// SPDX-License-Identifier: LGPL-3.0-only

// Framework layer: the main loop, request/response views, context, the
// return-value middleware engine, and miss/outcome handling. The public
// `pathfinder()` factory (which binds this layer to the filesystem loader)
// lands with the loader.

import { coerceResult, ContractViolation, HttpError } from "./http.ts";
import { BodyLimitError, limitTransform } from "./body_limit.ts";
import type { ManifestRow } from "./loader.ts";
import type { LookupResult, Params } from "./matcher.ts";
import { CompiledMatcher } from "./matcher.ts";
import type { TypeSpec } from "./grammar.ts";

// --- Augmentable interfaces (module augmentation; declared as interfaces
// forever — type aliases can't merge). One idiom for apps AND middleware:
//   declare module "@pathfinder/pathfinder" { interface State { user?: User } }

// Empty BY DESIGN: augmentation targets. Type aliases can't merge — these
// must remain interfaces forever (sealed design constraint).
// deno-lint-ignore no-empty-interface
export interface State {}
// deno-lint-ignore no-empty-interface
export interface App {}
// deno-lint-ignore no-empty-interface
export interface Meta {}

// --- Request world -----------------------------------------------------------

/** Ours, structural — Deno's NetAddr satisfies it as-is; adapters for other
 * platforms fill the same shape (Node: socket.remoteAddress/remotePort). */
export interface RemoteAddress {
  transport: string;
  hostname: string;
  port: number;
}

export interface PathfinderBody {
  /** Fresh parse per call — no shared-mutable parse results. */
  json(): Promise<unknown>;
  text(): Promise<string>;
  form(): Promise<FormData>;
  /** The native stream (through any queued transforms). Null without a body. */
  readonly stream: ReadableStream<Uint8Array> | null;
  /** Queue a transform — composed lazily, fed to `.stream` AND accessors;
   * zero cost if nobody reads (every GET). */
  pipeThrough(transform: TransformStream): void;
}

/** The request view — input world. `query` is lazy and cached; `headers` is
 * a REFERENCE to the native Headers; `_raw` is the escape hatch (underscore =
 * you own the consequences; expandos don't survive `_raw.clone()`). */
export interface PathfinderRequest<P = Params> {
  params: P;
  path: string;
  readonly query: URLSearchParams;
  method: string;
  headers: Headers;
  body: PathfinderBody;
  remoteAddr?: RemoteAddress;
  /** Resolves when the response has been fully sent on the wire. */
  completed?: Promise<void>;
  _raw: Request;
}

// --- Misses (§8.3 data table; "miss" naming reserved for 404/405/204) --------

export type Miss =
  | { kind: "no-match"; params: Params; rest: string }
  | { kind: "method-miss"; params: Params; allowed: string[] };

// --- Context -----------------------------------------------------------------

export interface Context {
  /** Long-lived app data, shared across requests; provided at construction.
   * Getter-only container, fields OPEN (plugins/overlays self-register). */
  readonly app: App;
  /** Per-request, starts `{}`; middleware-writable. Getter-only container. */
  readonly state: State;
  /** The matched route's metadata (module named exports); frozen per route.
   * Empty on misses. */
  readonly meta: Meta;
  /** Effective file table of THIS router instance — read-only. */
  _manifest(): readonly ManifestRow[];
  /** Miss data — present only inside 404/405/204 outcome rendering. */
  miss?: Miss;
  /** The thrown value — present only inside 500 outcome rendering. */
  error?: unknown;
}

// --- Middleware --------------------------------------------------------------

/** Post-phase function: sees the response view; may mutate it, queue
 * transforms, or return a fresh Response (wholesale replacement). */
export type PostFn = (
  response: ResponseView,
) => void | Response | Promise<void | Response>;

/** Return-value middleware model — no `next`. `void` continues; a `Response`
 * short-circuits (pre-phase); a post-fn joins the response path (LIFO,
 * always run). The `{ wrap }` shape is RESERVED, not shipped. */
export type Middleware = (
  request: PathfinderRequest,
  context: Context,
) => void | Response | PostFn | Promise<void | Response | PostFn>;

/** Framework handler face. Return contract: Response | object/array → JSON |
 * string → text/plain | ReadableStream / async iterable → streamed |
 * Uint8Array/ArrayBuffer → octet-stream | Blob → its `.type` | throw
 * HttpError → `{"detail"}`. null/undefined/primitives = contract violations
 * (loud 500). */
export type Handler = (
  request: PathfinderRequest,
  context: Context,
) => unknown;

// --- Response view (post-fn world) -------------------------------------------

/** Symmetric view for post-fns: mutable `status`/`headers` (recorded
 * copy-on-write), queued `pipeThrough`, `_raw`. Nothing queued/mutated → the
 * handler's ORIGINAL Response reaches Deno.serve untouched (identity fast
 * path). Users produce platform Responses, never views. */
export interface ResponseView {
  status: number;
  readonly headers: Headers;
  pipeThrough(transform: TransformStream): void;
  _raw: Response;
}

const NULL_BODY_STATUSES = new Set([204, 304]);

class ResponseViewImpl implements ResponseView {
  #base: Response;
  #status: number | null = null;
  #headersProxy: Headers | null = null;
  #headersReal: Headers | null = null;
  #headersTouched = false;
  #transforms: TransformStream[] = [];

  constructor(base: Response) {
    this.#base = base;
  }

  get _raw(): Response {
    return this.#base;
  }

  get status(): number {
    return this.#status ?? this.#base.status;
  }

  set status(value: number) {
    this.#status = value;
  }

  /** Copy-on-write headers: reads hit the native headers; the first write
   * clones (also defuses the immutable `fetch()`-headers footgun). */
  get headers(): Headers {
    if (this.#headersProxy === null) {
      // Captured for the proxy closures below — a proxy handler cannot be
      // a method on `this` without it.
      // deno-lint-ignore no-this-alias
      const self = this;
      this.#headersProxy = new Proxy(this.#base.headers, {
        get(_target, prop) {
          const backing = self.#headersReal ?? self.#base.headers;
          const value = Reflect.get(backing, prop, backing);
          if (typeof value === "function") {
            return (...args: unknown[]) => {
              if (prop === "set" || prop === "append" || prop === "delete") {
                self.#touchHeaders();
                const real = self.#headersReal as unknown as Record<
                  string,
                  (...a: unknown[]) => unknown
                >;
                return real[prop as string](...args);
              }
              return (value as (...a: unknown[]) => unknown).apply(
                backing,
                args,
              );
            };
          }
          return value;
        },
      });
    }
    return this.#headersProxy;
  }

  #touchHeaders(): void {
    if (this.#headersReal === null) {
      this.#headersReal = new Headers(this.#base.headers);
      this.#headersTouched = true;
    }
  }

  pipeThrough(transform: TransformStream): void {
    this.#transforms.push(transform);
  }

  /** Wholesale replacement: the old response dies entirely; queued transforms
   * and pending mutations reset (they described a dead body). Correlated
   * header+transform state dies atomically (gzip + Content-Encoding can't
   * desync). */
  replace(next: Response): void {
    this.#base = next;
    this.#status = null;
    this.#headersProxy = null;
    this.#headersReal = null;
    this.#headersTouched = false;
    this.#transforms = [];
  }

  get #editsPending(): boolean {
    return this.#status !== null || this.#headersTouched ||
      this.#transforms.length > 0;
  }

  /** Materialization: identity handoff is the fast path when all edit sets
   * are empty — an optimization, not a stance. Causal knowledge, not
   * arithmetic: the materializer is the sole wirer of transforms, so it
   * knows it changed the body and deletes the stale Content-Length without
   * ever computing one. */
  materialize(): Response {
    if (!this.#editsPending) return this.#base; // identity fast path

    let body = this.#base.body;
    let headers = this.#headersReal;
    if (headers === null) {
      // Clone before touching (transforms delete Content-Length; the base's
      // own headers may be immutable — never mutate the identity response).
      headers = new Headers(this.#base.headers);
      this.#headersReal = headers;
    }
    const status = this.#status ?? this.#base.status;
    if (this.#transforms.length > 0 && body !== null) {
      for (const transform of this.#transforms) {
        body = body.pipeThrough(transform);
      }
      headers.delete("content-length");
    }
    const finalBody = NULL_BODY_STATUSES.has(status) ? null : body;
    return new Response(finalBody, {
      status,
      statusText: this.#base.statusText,
      headers,
    });
  }
}

// --- Request body ------------------------------------------------------------

type BodyPhase = "middleware" | "handler";

/** Streaming-first body accessor. Middleware cannot consume the body;
 * `pipeThrough` is the sanctioned interaction; `{ disableStreaming: true }`
 * is the override. Never tee (unbounded buffering) — `_raw.clone()` is the
 * deep escape. */
class RequestBody implements PathfinderBody {
  #raw: Request;
  #phase: BodyPhase = "middleware";
  #middlewareAccess = false;
  #transforms: TransformStream[] = [];
  #bytes: Promise<Uint8Array> | null = null;
  #text: Promise<string> | null = null;
  #form: Promise<FormData> | null = null;
  #streamOut: ReadableStream<Uint8Array> | null | undefined = undefined;
  #selfRead = false;
  #rawConsumer: string | null = null;
  #limit: number | null = null;

  constructor(raw: Request) {
    this.#raw = raw;
  }

  // Engine hooks — router.ts owns the lifecycle; not public API.
  setPhase(phase: BodyPhase): void {
    this.#phase = phase;
  }

  allowMiddlewareAccess(): void {
    this.#middlewareAccess = true;
  }

  /** Body size limit (meta `bodyLimit`, bytes). Set before any read; one
   * counting transform guards both consumption styles. */
  setLimit(maxBytes: number): void {
    this.#limit = maxBytes;
  }

  /** `_raw` consumption mid-chain: the handler's guard error names the
   * culprit middleware. */
  noteRawConsumer(name: string): void {
    this.#rawConsumer = name;
  }

  get consumedSelf(): boolean {
    return this.#bytes !== null;
  }

  json(): Promise<unknown> {
    this.#guardAccessor();
    return this.#memoText().then((t) => JSON.parse(t) as unknown);
  }

  text(): Promise<string> {
    this.#guardAccessor();
    return this.#memoText();
  }

  form(): Promise<FormData> {
    this.#guardAccessor();
    if (this.#form === null) {
      const contentType = this.#raw.headers.get("content-type") ?? "";
      this.#form = this.#memoBytes().then((bytes) =>
        new Response(bytes as unknown as BodyInit, {
          headers: { "content-type": contentType },
        }).formData()
      );
    }
    return this.#form;
  }

  get stream(): ReadableStream<Uint8Array> | null {
    this.#guardStream();
    if (this.#streamOut === undefined) {
      let stream: ReadableStream<Uint8Array> | null = this.#raw.body;
      if (stream !== null) {
        if (this.#limit !== null) {
          stream = stream.pipeThrough(
            limitTransform(this.#limit),
          ) as ReadableStream<Uint8Array>;
        }
        for (const transform of this.#transforms) {
          stream = stream.pipeThrough(transform) as ReadableStream<Uint8Array>;
        }
      }
      this.#streamOut = stream;
    }
    return this.#streamOut;
  }

  pipeThrough(transform: TransformStream): void {
    if (this.#streamOut !== undefined || this.#bytes !== null) {
      throw new Error(
        "body already started — pipeThrough must be called before the body is read",
      );
    }
    this.#transforms.push(transform);
  }

  #guardAccessor(): void {
    if (this.#streamOut !== undefined) {
      throw new Error(
        "body accessors unavailable: the body has already been handed out as a stream",
      );
    }
    if (this.#rawConsumer !== null) {
      throw new Error(
        `request body was consumed by middleware "${this.#rawConsumer}" via _raw`,
      );
    }
    if (this.#phase === "middleware" && !this.#middlewareAccess) {
      throw new Error(
        "middleware cannot consume the body (streaming-first); use body.pipeThrough() or register { disableStreaming: true }",
      );
    }
  }

  #guardStream(): void {
    if (this.#bytes !== null || this.#text !== null || this.#form !== null) {
      throw new Error(
        "body stream unavailable: accessors already consumed the body",
      );
    }
    if (this.#rawConsumer !== null) {
      throw new Error(
        `request body was consumed by middleware "${this.#rawConsumer}" via _raw`,
      );
    }
  }

  #composed(): ReadableStream<Uint8Array> | null {
    let stream: ReadableStream<Uint8Array> | null = this.#raw.body;
    if (stream !== null) {
      if (this.#limit !== null) {
        stream = stream.pipeThrough(
          limitTransform(this.#limit),
        ) as ReadableStream<Uint8Array>;
      }
      for (const transform of this.#transforms) {
        stream = stream.pipeThrough(transform) as ReadableStream<Uint8Array>;
      }
    }
    return stream;
  }

  #memoBytes(): Promise<Uint8Array> {
    if (this.#bytes === null) {
      this.#selfRead = true;
      const source = this.#composed();
      this.#bytes = source === null
        ? Promise.resolve(new Uint8Array(0))
        : readAll(source);
    }
    return this.#bytes;
  }

  #memoText(): Promise<string> {
    if (this.#text === null) {
      this.#text = this.#memoBytes().then((bytes) =>
        new TextDecoder().decode(bytes)
      );
    }
    return this.#text;
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// --- View construction (the membrane) ----------------------------------------

/** Duck-extract our structural RemoteAddress from the host's info object.
 * No hatch: extract into our buckets, store nothing of the host's. */
function extractRemoteAddr(info: unknown): RemoteAddress | undefined {
  const addr = (info as { remoteAddr?: unknown } | undefined)?.remoteAddr;
  if (
    typeof addr === "object" && addr !== null &&
    typeof (addr as RemoteAddress).transport === "string" &&
    typeof (addr as RemoteAddress).hostname === "string" &&
    typeof (addr as RemoteAddress).port === "number"
  ) {
    const { transport, hostname, port } = addr as RemoteAddress;
    return { transport, hostname, port };
  }
  return undefined;
}

function extractCompleted(info: unknown): Promise<void> | undefined {
  const completed = (info as { completed?: unknown } | undefined)?.completed;
  return completed instanceof Promise ? completed : undefined;
}

function buildRequestView(
  raw: Request,
  path: string,
  params: Params,
  body: RequestBody,
  info: unknown,
): PathfinderRequest {
  let query: URLSearchParams | undefined;
  const remoteAddr = extractRemoteAddr(info);
  const completed = extractCompleted(info);
  const view = Object.create(null) as PathfinderRequest;
  Object.defineProperties(view, {
    params: { value: params, enumerable: true },
    path: { value: path, enumerable: true },
    query: {
      enumerable: true,
      get: () => {
        if (query === undefined) query = new URL(raw.url).searchParams;
        return query;
      },
    },
    method: { value: raw.method, enumerable: true },
    headers: { value: raw.headers, enumerable: true },
    body: { value: body, enumerable: true },
    ...(remoteAddr !== undefined
      ? { remoteAddr: { value: remoteAddr, enumerable: true } }
      : {}),
    ...(completed !== undefined
      ? { completed: { value: completed, enumerable: true } }
      : {}),
    _raw: { value: raw, enumerable: true },
  });
  return view;
}

function buildContext(
  app: object,
  meta: Meta,
  manifest: () => readonly ManifestRow[],
): Context {
  const state: State = {};
  const context = Object.create(null) as Context;
  Object.defineProperties(context, {
    // Getter-only containers: non-replaceable (strict-mode throw on
    // assignment); fields OPEN (no freeze — hackability doctrine).
    app: { get: () => app, enumerable: true },
    state: { get: () => state, enumerable: true },
    meta: { get: () => meta, enumerable: true },
    _manifest: { value: manifest, enumerable: true },
    miss: { value: undefined, writable: true, enumerable: true },
    error: { value: undefined, writable: true, enumerable: true },
  });
  return context;
}

// --- Router ------------------------------------------------------------------

interface RouteEntry {
  method: string;
  pattern: string;
  handler: Handler;
  meta: Meta;
  dir: string;
  disableStreaming: boolean;
  chain: Middleware[] | null; // null = compose from directory middleware
}

export interface AddRouteOptions {
  meta?: Meta;
  /** Explicit middleware chain; default = composed from directory middleware. */
  chain?: Middleware[];
  /** Directory tag (fs routes: the pattern itself). Default = pattern. */
  dir?: string;
  disableStreaming?: boolean;
}

/** Internal framework router. NOT public API — the public face is the
 * `pathfinder()` factory; no public Router class ships (register() is
 * postponed; v1 makes no post-boot mutability promise). */
export class Router {
  #matcher = new CompiledMatcher([]);
  #entries = new Map<string, RouteEntry>();
  #dirMiddleware = new Map<
    string,
    { middleware: Middleware; disableStreaming: boolean }[]
  >();
  // outcome code → dir → renderer
  #outcomes = new Map<number, Map<string, Handler>>();
  #app: object;
  #manifest: () => readonly ManifestRow[];

  constructor(
    app: object = {},
    opts?: {
      types?: Record<string, TypeSpec>;
      manifest?: () => readonly ManifestRow[];
    },
  ) {
    this.#app = app;
    this.#manifest = opts?.manifest ?? (() => []);
    this.#matcher = new CompiledMatcher([], { types: opts?.types });
  }

  add(
    method: string,
    pattern: string,
    handler: Handler,
    opts: AddRouteOptions = {},
  ): void {
    const dir = opts.dir ?? pattern;
    const meta = opts.meta ?? {};
    const key = method + "\u0000" + pattern;
    if (this.#entries.has(key)) {
      throw new Error(`Duplicate route: ${method} ${pattern}`);
    }
    const entry: RouteEntry = {
      method,
      pattern,
      handler,
      meta,
      dir,
      disableStreaming: opts.disableStreaming === true ||
        (meta as Record<string, unknown>).disableStreaming === true,
      chain: opts.chain ?? null,
    };
    this.#entries.set(key, entry);
    this.#matcher.add({
      method,
      pattern,
      handler: () => null, // leaf placeholder — dispatch goes through lookup()
      data: entry,
      dir,
    });
  }

  /** Register middleware for a directory (ordered as given: parent dirs
   * before child, seats ascending within a dir — the loader's job). An entry
   * may carry options: `{ middleware, disableStreaming }` (the named-export
   * options of a middleware file). */
  setDirMiddleware(
    dir: string,
    entries:
      (Middleware | { middleware: Middleware; disableStreaming?: boolean })[],
  ): void {
    this.#dirMiddleware.set(
      dir,
      entries.map((e) =>
        typeof e === "function" ? { middleware: e, disableStreaming: false } : {
          middleware: e.middleware,
          disableStreaming: e.disableStreaming === true,
        }
      ),
    );
  }

  /** Streaming forfeited under this dir? (any ancestor middleware flagged) */
  #dirStreaming(dir: string): boolean {
    for (const [d, entries] of this.#dirMiddleware) {
      if (
        entries.some((e) => e.disableStreaming) &&
        (d === "" || dir === d || dir.startsWith(d + "/"))
      ) return true;
    }
    return false;
  }

  setOutcome(code: number, dir: string, handler: Handler): void {
    let byDir = this.#outcomes.get(code);
    if (byDir === undefined) {
      byDir = new Map();
      this.#outcomes.set(code, byDir);
    }
    byDir.set(dir, handler);
  }

  lookup(method: string, path: string): LookupResult {
    return this.#matcher.lookup(method, path);
  }

  #resolveOutcome(code: number, dir: string): Handler | null {
    const byDir = this.#outcomes.get(code);
    if (byDir === undefined) return null;
    let d = dir;
    for (;;) {
      const found = byDir.get(d);
      if (found !== undefined) return found; // nearest ancestor cascade
      if (d === "") return null;
      const cut = d.lastIndexOf("/");
      d = cut <= 0 ? "" : d.slice(0, cut);
    }
  }

  /** Middleware chain for a directory: every registered dir that is a prefix
   * (root first, deepest last). */
  chainFor(dir: string): Middleware[] {
    const dirs = [...this.#dirMiddleware.keys()]
      .filter((d) => d === "" || dir === d || dir.startsWith(d + "/"))
      .sort((a, b) => a.length - b.length);
    const chain: Middleware[] = [];
    for (const d of dirs) {
      for (const e of this.#dirMiddleware.get(d)!) chain.push(e.middleware);
    }
    return chain;
  }

  async handle(request: Request, info?: unknown): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = new RequestBody(request);
    const result = this.#matcher.lookup(request.method, path);

    if (result.kind === "match") {
      const entry = result.data as RouteEntry;
      if (entry.disableStreaming || this.#dirStreaming(entry.dir)) {
        body.allowMiddlewareAccess();
      }
      const limit = (entry.meta as { bodyLimit?: unknown }).bodyLimit;
      if (typeof limit === "number") body.setLimit(limit);
      const view = buildRequestView(request, path, result.params, body, info);
      const context = buildContext(
        this.#app,
        Object.freeze(entry.meta),
        this.#manifest,
      );
      return await this.#dispatch(
        view,
        context,
        body,
        entry.chain ?? this.chainFor(entry.dir),
        entry.handler,
        entry.dir,
      );
    }

    const view = buildRequestView(request, path, {}, body, info);
    const context = buildContext(this.#app, Object.freeze({}), this.#manifest);

    if (result.kind === "method-miss") {
      const entry = result.data as RouteEntry | undefined;
      const anchorDir = entry?.dir ?? "";
      const code = request.method === "OPTIONS" ? 204 : 405;
      context.miss = {
        kind: "method-miss",
        params: result.params,
        allowed: result.allowed,
      };
      const renderer = this.#resolveOutcome(code, anchorDir);
      const handler: Handler = renderer ??
        (() => new Response(null, { status: code })); // vacuum = bare status
      return await this.#dispatch(
        view,
        context,
        body,
        this.chainFor(anchorDir),
        handler,
        anchorDir,
      );
    }

    // no-match
    const anchor = result.anchor;
    const anchorDir = anchor?.dir ?? "";
    context.miss = {
      kind: "no-match",
      params: anchor?.params ?? {},
      rest: anchor?.rest ?? path,
    };
    const renderer = this.#resolveOutcome(404, anchorDir);
    const handler: Handler = renderer ??
      (() => new Response(null, { status: 404 })); // vacuum = bare status
    return await this.#dispatch(
      view,
      context,
      body,
      this.chainFor(anchorDir),
      handler,
      anchorDir,
    );
  }

  /** The dispatch loop: chain is data, flat iteration. Errors map to a
   * Response BEFORE post-fns; post-fns always run (finally-like guarantee). */
  async #dispatch(
    request: PathfinderRequest,
    context: Context,
    body: RequestBody,
    chain: Middleware[],
    handler: Handler,
    anchorDir: string,
  ): Promise<Response> {
    const postFns: PostFn[] = [];
    let response: Response | null = null;
    body.setPhase("middleware");

    try {
      let rawUsed = request._raw.bodyUsed;
      for (let i = 0; i < chain.length; i++) {
        const mw = chain[i];
        const result = await mw(request, context);
        // _raw consumption mid-chain detection (bodyUsed snapshots).
        if (request._raw.bodyUsed && !rawUsed && !body.consumedSelf) {
          body.noteRawConsumer(mw.name || `middleware#${i}`);
        }
        rawUsed = request._raw.bodyUsed;
        if (result === undefined) continue;
        if (result instanceof Response) {
          response = result; // short-circuit (pre-phase)
          break;
        }
        if (typeof result === "function") {
          postFns.push(result as PostFn);
          continue;
        }
        throw new ContractViolation(
          `middleware "${mw.name || `middleware#${i}`}" returned ${
            describeValue(result)
          } — void, Response, or a post-fn expected`,
        );
      }
      if (response === null) {
        body.setPhase("handler");
        response = coerceResult(await handler(request, context));
      }
    } catch (error) {
      if (error instanceof HttpError) {
        // Renders directly — cascades are for framework-generated outcomes.
        response = Response.json(
          { detail: error.detail },
          { status: error.status, headers: error.headers },
        );
      } else if (error instanceof BodyLimitError) {
        // 413 outcome (map grows additively; subtree 413.ts customizes).
        context.error = error;
        response = await this.#renderOutcome(413, anchorDir, request, context);
      } else {
        // 500 outcome → 500 renderer cascade; vacuum = bare status. Loud.
        console.error("[pathfinder] 500:", error);
        context.error = error;
        response = await this.#renderOutcome(500, anchorDir, request, context);
      }
    }

    // Post-fns — LIFO (inner→outer), always run.
    const view = new ResponseViewImpl(response);
    try {
      for (let i = postFns.length - 1; i >= 0; i--) {
        const postFn = postFns[i];
        const name = postFn.name || `postFn#${i}`;
        const wasUsed = view._raw.bodyUsed;
        const replacement = await postFn(view);
        if (view._raw.bodyUsed && !wasUsed) {
          throw new ContractViolation(
            `post-fn "${name}" consumed the response body via _raw`,
          );
        }
        if (replacement instanceof Response) {
          if (replacement.bodyUsed) {
            throw new ContractViolation(
              `post-fn "${name}" returned a Response with an already-consumed body`,
            );
          }
          console.debug(
            `[pathfinder] response wholesale-replaced by "${name}"`,
          );
          view.replace(replacement);
        }
      }
    } catch (error) {
      console.error("[pathfinder] post-fn phase failure:", error);
      return new Response(null, { status: 500 });
    }

    return view.materialize();
  }

  async #renderOutcome(
    code: number,
    anchorDir: string,
    request: PathfinderRequest,
    context: Context,
  ): Promise<Response> {
    const renderer = this.#resolveOutcome(code, anchorDir);
    if (renderer === null) return new Response(null, { status: code });
    try {
      return coerceResult(await renderer(request, context));
    } catch (error) {
      // A failing renderer must never take the request down with it.
      console.error(`[pathfinder] ${code} renderer failed:`, error);
      return new Response(null, { status: code });
    }
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") {
    return Array.isArray(value) ? "an array" : "an object";
  }
  return `a ${typeof value}`;
}
