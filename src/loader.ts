// SPDX-License-Identifier: LGPL-3.0-only

// Filesystem loader & IoC: directory path = pattern,
// `<method>.ts` = handler file. Filename grammar — the first character
// decides; NOTHING is reserved:
//   <letter>[A-Za-z0-9-]*.ts  → method handler (letter-start, no dots)
//   <digits>-<label>.ts       → middleware, one per file, seat = digits
//   <digits>.ts               → outcome renderer (closed map v1)
//   .d.ts                     → ignored (type-only compile-time shadows)
//   anything else             → build error
// Directories are 100% URL namespace. No index.ts. Module contract:
// `export default` = handler (null = tombstone); named exports = meta.

import { toFileUrl } from "@std/path";
import { routeShapeKey, type TypeSpec } from "./grammar.ts";
import type { Handler, Meta, Middleware } from "./router.ts";
import { Router } from "./router.ts";

const METHOD_FILE = /^[A-Za-z][A-Za-z0-9-]*\.ts$/;
const MIDDLEWARE_FILE = /^[0-9]+-[A-Za-z0-9-]*\.ts$/;
const STATUS_FILE = /^[0-9]+\.ts$/;

/** Closed outcome map v1 — grows additively (413 with body limits). */
const OUTCOME_CODES = new Set([204, 404, 405, 413, 500]);

export interface ManifestRow {
  kind: "route" | "middleware" | "status" | "tombstone";
  layer: number;
  root: string;
  file: string;
  method?: string;
  pattern?: string;
  dir?: string;
  code?: number;
  shadows?: string;
}

// --- Classified entries --------------------------------------------------------

type Mod = { default?: unknown } & Record<string, unknown>;

/** A classified, imported file entry (from an fs walk or Layer 0). */
export type Entry =
  | {
    kind: "method";
    layer: number;
    root: string;
    file: string;
    method: string;
    pattern: string;
    dir: string;
    mod: Mod;
  }
  | {
    kind: "middleware";
    layer: number;
    root: string;
    file: string;
    dir: string;
    name: string;
    mod: Mod;
  }
  | {
    kind: "status";
    layer: number;
    root: string;
    file: string;
    code: number;
    dir: string;
    mod: Mod;
  };

interface RouteReg {
  method: string;
  pattern: string;
  handler: Handler;
  meta: Meta;
  dir: string;
  layer: number;
  root: string;
  file: string;
}
interface MiddlewareReg {
  dir: string;
  name: string;
  middleware: Middleware;
  disableStreaming: boolean;
  layer: number;
  root: string;
  file: string;
}
interface StatusReg {
  code: number;
  dir: string;
  handler: Handler;
  layer: number;
  root: string;
  file: string;
}

class Resolver {
  /** Routes keyed by method + structural shape (notes/#title ≡ notes/#name —
   * param names don't defeat shadowing). */
  routes = new Map<string, RouteReg>();
  middleware = new Map<string, MiddlewareReg>();
  statuses = new Map<string, StatusReg>();
  manifest: ManifestRow[] = [];
  registry: Record<string, TypeSpec> | undefined;

  add(entry: Entry): void {
    if (entry.kind === "method") {
      const mod = entry.mod;
      const key = routeKey(entry.method, shapeOf(entry.pattern, this.registry));
      if (mod.default === null) {
        this.routes.delete(key);
        this.manifest.push({
          kind: "tombstone",
          layer: entry.layer,
          root: entry.root,
          file: entry.file,
          method: entry.method,
          pattern: entry.pattern,
        });
        return;
      }
      if (typeof mod.default !== "function") {
        throw new Error(
          `[pathfinder] build error: ${entry.file} — method files must default-export a handler (null = tombstone)`,
        );
      }
      const prev = this.routes.get(key);
      if (prev !== undefined) {
        if (prev.layer === entry.layer && prev.root === entry.root) {
          throw new Error(
            `[pathfinder] build error: duplicate route shape in one root — ${entry.file} collides with ${prev.file} (${entry.method} ${entry.pattern})`,
          );
        }
        console.log(
          `[pathfinder] SHADOWS ${entry.method} ${entry.pattern} (${entry.file} replaces ${prev.file})`,
        );
      }
      this.routes.set(key, {
        method: entry.method,
        pattern: entry.pattern,
        handler: mod.default as Handler,
        meta: metaOf(mod),
        dir: entry.dir,
        layer: entry.layer,
        root: entry.root,
        file: entry.file,
      });
      this.manifest.push({
        kind: "route",
        layer: entry.layer,
        root: entry.root,
        file: entry.file,
        method: entry.method,
        pattern: entry.pattern,
        shadows: prev?.file,
      });
      return;
    }

    if (entry.kind === "middleware") {
      const mod = entry.mod;
      const key = `${entry.dir}\u0000${entry.name}`;
      const prev = this.middleware.get(key);
      if (
        prev !== undefined && prev.layer === entry.layer &&
        prev.root === entry.root
      ) {
        throw new Error(
          `[pathfinder] build error: duplicate middleware file in one root — ${entry.file} collides with ${prev.file}`,
        );
      }
      if (mod.default === null) {
        this.middleware.delete(key);
        this.manifest.push({
          kind: "tombstone",
          layer: entry.layer,
          root: entry.root,
          file: entry.file,
          dir: entry.dir,
        });
        return;
      }
      if (typeof mod.default !== "function") {
        throw new Error(
          `[pathfinder] build error: ${entry.file} — middleware files must default-export a middleware (null = tombstone)`,
        );
      }
      if (prev !== undefined) {
        console.log(
          `[pathfinder] SHADOWS middleware ${
            entry.dir || "/"
          }/${entry.name} (${entry.file} replaces ${prev.file})`,
        );
      }
      this.middleware.set(key, {
        dir: entry.dir,
        name: entry.name,
        middleware: mod.default as Middleware,
        disableStreaming: mod.disableStreaming === true,
        layer: entry.layer,
        root: entry.root,
        file: entry.file,
      });
      this.manifest.push({
        kind: "middleware",
        layer: entry.layer,
        root: entry.root,
        file: entry.file,
        dir: entry.dir,
        shadows: prev?.file,
      });
      return;
    }

    // status renderer
    const mod = entry.mod;
    const key = `${entry.code}\u0000${entry.dir}`;
    const prev = this.statuses.get(key);
    if (
      prev !== undefined && prev.layer === entry.layer &&
      prev.root === entry.root
    ) {
      throw new Error(
        `[pathfinder] build error: duplicate outcome renderer in one root — ${entry.file} collides with ${prev.file}`,
      );
    }
    if (mod.default === null) {
      this.statuses.delete(key);
      this.manifest.push({
        kind: "tombstone",
        layer: entry.layer,
        root: entry.root,
        file: entry.file,
        code: entry.code,
      });
      return;
    }
    if (typeof mod.default !== "function") {
      throw new Error(
        `[pathfinder] build error: ${entry.file} — outcome renderers must default-export a handler (null = tombstone)`,
      );
    }
    if (prev !== undefined) {
      console.log(
        `[pathfinder] SHADOWS ${entry.code} outcome at ${
          entry.dir || "/"
        } (${entry.file} replaces ${prev.file})`,
      );
    }
    this.statuses.set(key, {
      code: entry.code,
      dir: entry.dir,
      handler: mod.default as Handler,
      layer: entry.layer,
      root: entry.root,
      file: entry.file,
    });
    this.manifest.push({
      kind: "status",
      layer: entry.layer,
      root: entry.root,
      file: entry.file,
      code: entry.code,
      dir: entry.dir,
      shadows: prev?.file,
    });
  }
}

function routeKey(method: string, shape: string): string {
  return method + "\u0000" + shape;
}

/** Structural shape of a pattern (routeShapeKey), with the custom registry
 * when one is configured. */
function shapeOf(
  pattern: string,
  registry: Record<string, TypeSpec> | undefined,
): string {
  return registry === undefined
    ? routeShapeKey(pattern)
    : routeShapeKey(pattern, registry);
}

/** Named exports = meta → context.meta (open bag; `default` excluded). */
function metaOf(mod: Mod): Meta {
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mod)) {
    if (k !== "default") meta[k] = v;
  }
  return meta as Meta;
}

// --- FS walk -------------------------------------------------------------------

/** Classify + import every file under one root. Directories are 100% URL
 * namespace — only files are grammar-checked. Paths are built as strings and
 * converted with toFileUrl() — `new URL(rel, base)` with a `#` dirname would
 * treat it as a fragment (verified trap); toFileUrl encodes to %23. */
export async function walkRoot(
  root: string | URL,
  layer: number,
): Promise<Entry[]> {
  const rootPath = root instanceof URL
    ? decodeURIComponent(root.pathname)
    : decodeURIComponent(
      toFileUrl(absolute(root.endsWith("/") ? root : root + "/")).pathname,
    );
  const entries: Entry[] = [];

  async function visit(dirRel: string): Promise<void> {
    const absDir = rootPath + dirRel;
    for await (const item of Deno.readDir(absDir)) {
      const rel = dirRel === "" ? item.name : dirRel + item.name;
      if (item.isDirectory) {
        await visit(rel.endsWith("/") ? rel : rel + "/");
        continue;
      }
      if (!item.isFile) continue; // symlinks etc. — skip
      const file = rel;
      const base = item.name;
      const display = rootPath.replace(/\/$/, "") + "/" + file;
      const absFile = rootPath + file;

      if (base.endsWith(".d.ts")) continue; // ignored: type-only shadows

      if (METHOD_FILE.test(base)) {
        entries.push({
          kind: "method",
          layer,
          root: rootPath,
          file: display,
          method: base.slice(0, -3).toUpperCase(),
          pattern: patternOf(dirRel),
          dir: dirPatternOf(dirRel),
          mod: await import(toFileUrl(absFile).href),
        });
        continue;
      }

      if (MIDDLEWARE_FILE.test(base)) {
        entries.push({
          kind: "middleware",
          layer,
          root: rootPath,
          file: display,
          dir: dirPatternOf(dirRel),
          name: base.slice(0, -3),
          mod: await import(toFileUrl(absFile).href),
        });
        continue;
      }

      if (STATUS_FILE.test(base)) {
        const code = parseInt(base.slice(0, -3), 10);
        if (!OUTCOME_CODES.has(code)) {
          throw new Error(
            `${display} — "${file}" is not in the outcome map (${
              [...OUTCOME_CODES].sort().join(", ")
            })`,
          );
        }
        entries.push({
          kind: "status",
          layer,
          root: rootPath,
          file: display,
          code,
          dir: dirPatternOf(dirRel),
          mod: await import(toFileUrl(absFile).href),
        });
        continue;
      }

      throw new Error(
        `${display} — the endpoints tree contains route files only (method, <digits>-<label> middleware, <digits> outcome, or .d.ts)`,
      );
    }
  }

  await visit("");
  return entries;
}

function absolute(path: string): string {
  return path.startsWith("/") ? path : `${Deno.cwd()}/${path}`;
}

function patternOf(dirRel: string): string {
  // "api/#roomId/" → "/api/#roomId"; "" → "/"
  if (dirRel === "") return "/";
  return "/" + dirRel.slice(0, -1);
}

function dirPatternOf(dirRel: string): string {
  // The file's directory as a chain key: "" for root-level files.
  if (dirRel === "") return "";
  return "/" + dirRel.slice(0, -1);
}

// --- Assembly -------------------------------------------------------------------

export interface ResolveOptions {
  /** Layer 0 — the package's own root, walked like any other (Amendment 1:
   * real files, no synthetic entries). App roots and overlays shadow or
   * tombstone its files identically (last wins, per file). */
  layer0Root?: string | URL;
  /** Layer 1 app roots — missing root is an error. */
  appRoots: (string | URL)[];
  /** Layer 2+ overlay roots — missing root is warn+skip. */
  envRoots?: (string | URL)[];
  /** context.app data. */
  app?: object;
  /** Custom type registry, immutable after boot. */
  types?: Record<string, TypeSpec>;
  /** Read-only manifest accessor, exposed to handlers as context._manifest(). */
  manifest?: () => readonly ManifestRow[];
}

export interface Loaded {
  router: Router;
  manifest: ManifestRow[];
  summary: string;
}

export async function resolveTree(opts: ResolveOptions): Promise<Loaded> {
  const resolver = new Resolver();
  resolver.registry = opts.types;

  if (opts.layer0Root !== undefined) {
    // The package's own tree — a missing layer0Root is a broken install,
    // not a warn+skip case. Let it throw.
    for (const entry of await walkRoot(opts.layer0Root, 0)) resolver.add(entry);
  }

  for (const root of opts.appRoots) {
    let entries: Entry[];
    try {
      entries = await walkRoot(root, 1);
    } catch (error) {
      throw new Error(
        `[pathfinder] app root missing or unreadable: ${
          root instanceof URL ? root.href : root
        } (${(error as Error).message})`,
        { cause: error },
      );
    }
    for (const entry of entries) resolver.add(entry);
  }

  // PATHFINDER_USER_ENDPOINTS — ALWAYS ON, unconditional. Missing/unreadable
  // env roots log loudly and are skipped: boot is never hostage to the hack.
  let layerNum = 2;
  for (const root of opts.envRoots ?? []) {
    let entries: Entry[];
    try {
      entries = await walkRoot(root, layerNum);
    } catch (error) {
      console.warn(
        `[pathfinder] WARNING: overlay root skipped: ${
          root instanceof URL ? root.href : root
        } (${(error as Error).message})`,
      );
      continue;
    }
    for (const entry of entries) resolver.add(entry);
    layerNum++;
  }

  const router = new Router(opts.app ?? {}, {
    types: opts.types,
    manifest: opts.manifest,
  });
  for (const [dir, mws] of middlewareByDir(resolver.middleware)) {
    router.setDirMiddleware(dir, mws);
  }
  for (const route of resolver.routes.values()) {
    router.add(route.method, route.pattern, route.handler, {
      meta: route.meta,
      dir: route.dir,
    });
  }
  for (const status of resolver.statuses.values()) {
    router.setOutcome(status.code, status.dir, status.handler);
  }

  const histogram = new Map<string, number>();
  for (const route of resolver.routes.values()) {
    histogram.set(route.method, (histogram.get(route.method) ?? 0) + 1);
  }
  const hist = [...histogram.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, n]) => `${m} ${n}`)
    .join(", ");
  const summary = `${resolver.routes.size} routes (${hist})`;
  return { router, manifest: resolver.manifest, summary };
}

function middlewareByDir(
  middleware: Map<string, MiddlewareReg>,
): [string, MiddlewareReg[]][] {
  const byDir = new Map<string, MiddlewareReg[]>();
  for (const mw of middleware.values()) {
    const list = byDir.get(mw.dir) ?? [];
    list.push(mw);
    byDir.set(mw.dir, list);
  }
  // Parent directory before child (outer→inner); lexicographic within a dir —
  // the digits ARE the config.
  const dirs = [...byDir.keys()].sort((a, b) =>
    a.length - b.length || a.localeCompare(b)
  );
  return dirs.map((
    d,
  ) => [d, byDir.get(d)!.sort((a, b) => a.name.localeCompare(b.name))]);
}
