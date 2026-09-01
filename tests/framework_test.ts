// SPDX-License-Identifier: LGPL-3.0-only

// Framework-layer unit tests: return contract, middleware engine, views,
// context, misses/outcomes, framing. Internal tests consume the unmodified
// production surface — the Router is the engine the factory will bind.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { Router } from "../src/router.ts";
import type { Context, PathfinderRequest } from "../src/router.ts";
import {
  allowedMethods,
  html,
  HttpError,
  json,
  redirect,
  text,
} from "../src/http.ts";

/** Silence the deliberately-loud logs for the duration of fn. */
async function quiet(fn: () => Promise<void>): Promise<void> {
  const { error, debug, log } = console;
  console.error = () => {};
  console.debug = () => {};
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.error = error;
    console.debug = debug;
    console.log = log;
  }
}

function makeRouter(app: object = {}): Router {
  return new Router(app);
}

async function dispatch(
  router: Router,
  request: Request,
  info?: unknown,
): Promise<Response> {
  return await router.handle(request, info);
}

const GET = (path: string) => new Request("http://localhost" + path);

// --- Return contract (§8.6) --------------------------------------------------

Deno.test("contract: object → JSON, array → JSON", async () => {
  const router = makeRouter();
  router.add("GET", "/obj", () => ({ ok: true }));
  router.add("GET", "/arr", () => [1, 2]);
  const obj = await dispatch(router, GET("/obj"));
  assertEquals(obj.status, 200);
  assertEquals(obj.headers.get("content-type"), "application/json");
  assertEquals(await obj.json(), { ok: true });
  const arr = await dispatch(router, GET("/arr"));
  assertEquals(await arr.json(), [1, 2]);
});

Deno.test("contract: string → text/plain (no sniffing)", async () => {
  const router = makeRouter();
  router.add("GET", "/", () => "<h1>not html</h1>");
  const res = await dispatch(router, GET("/"));
  assertEquals(res.headers.get("content-type"), "text/plain;charset=UTF-8");
  assertEquals(await res.text(), "<h1>not html</h1>");
});

Deno.test("contract: ReadableStream → streamed 200", async () => {
  const router = makeRouter();
  router.add("GET", "/", () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk1"));
        c.enqueue(new TextEncoder().encode("chunk2"));
        c.close();
      },
    }));
  const res = await dispatch(router, GET("/"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "chunk1chunk2");
});

Deno.test("contract: async generator → streamed 200", async () => {
  const router = makeRouter();
  router.add("GET", "/", async function* () {
    yield new TextEncoder().encode("a");
    yield new TextEncoder().encode("b");
  });
  const res = await dispatch(router, GET("/"));
  assertEquals(await res.text(), "ab");
});

Deno.test("contract: binary → octet-stream; Blob → its .type", async () => {
  const router = makeRouter();
  router.add("GET", "/u8", () => new Uint8Array([1, 2, 3]));
  router.add("GET", "/ab", () => new ArrayBuffer(4));
  router.add("GET", "/blob", () => new Blob(["x"], { type: "image/png" }));
  router.add("GET", "/blob-plain", () => new Blob(["x"]));
  assertEquals(
    (await dispatch(router, GET("/u8"))).headers.get("content-type"),
    "application/octet-stream",
  );
  assertEquals(
    (await dispatch(router, GET("/ab"))).headers.get("content-type"),
    "application/octet-stream",
  );
  assertEquals(
    (await dispatch(router, GET("/blob"))).headers.get("content-type"),
    "image/png",
  );
  assertEquals(
    (await dispatch(router, GET("/blob-plain"))).headers.get("content-type"),
    "application/octet-stream",
  );
});

Deno.test("contract: Response is the identity branch", async () => {
  const router = makeRouter();
  const original = new Response("hi");
  router.add("GET", "/", () => original);
  const res = await dispatch(router, GET("/"));
  assertStrictEquals(res, original); // identity fast path
});

Deno.test("contract: HttpError → {detail} + status + headers", async () => {
  const router = makeRouter();
  router.add("GET", "/", () => {
    throw new HttpError(401, "bad token", {
      "WWW-Authenticate": `Bearer realm="x"`,
    });
  });
  const res = await dispatch(router, GET("/"));
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("www-authenticate"), `Bearer realm="x"`);
  assertEquals(await res.json(), { detail: "bad token" });
});

Deno.test("contract: primitives/null are loud 500 violations", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.add("GET", "/n", () => null);
    router.add("GET", "/u", () => undefined);
    router.add("GET", "/num", () => 42);
    router.add("GET", "/bool", () => true);
    router.add("GET", "/big", () => 1n);
    for (const path of ["/n", "/u", "/num", "/bool", "/big"]) {
      const res = await dispatch(router, GET(path));
      assertEquals(res.status, 500, path);
      assertEquals(await res.text(), "", path); // vacuum = bare status
    }
  });
});

Deno.test("contract: violation error names the offense via 500 renderer", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.add("GET", "/", () => 42);
    router.setOutcome(500, "/", (_request, context) => ({
      message: (context.error as Error).message,
    }));
    const res = await dispatch(router, GET("/"));
    const body = await res.json() as { message: string };
    assert(body.message.includes("contract violation"));
    assert(body.message.includes("number"));
  });
});

// --- Helpers -----------------------------------------------------------------

Deno.test("helpers: json/html/text/redirect", () => {
  const j = json({ a: 1 });
  assertEquals(j.headers.get("content-type"), "application/json");
  const h = html("<b>x</b>");
  assertEquals(h.headers.get("content-type"), "text/html; charset=utf-8");
  const t = text("y");
  assertEquals(t.headers.get("content-type"), "text/plain;charset=UTF-8");
  // Platform Response.redirect rejects relative URLs; ours accepts them.
  const r = redirect("/login");
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("location"), "/login");
  assertEquals(redirect("/next", 307).status, 307);
  assertEquals(allowedMethods(["post", "get"]), "GET, POST");
});

// --- Middleware engine (§2.1) -------------------------------------------------

Deno.test("middleware: void continues, Response short-circuits handler", async () => {
  const router = makeRouter();
  let handlerRan = false;
  function gate(request: PathfinderRequest): Response | void {
    if (request.headers.get("x-block")) {
      return new Response("blocked", { status: 403 });
    }
  }
  router.add("GET", "/", (request) => {
    handlerRan = true;
    return request.headers.has("x-block") ? "should not run" : "ran";
  }, { chain: [gate] });
  assertEquals(await (await dispatch(router, GET("/"))).text(), "ran");
  assert(handlerRan);
  const blocked = await dispatch(
    router,
    new Request("http://localhost/", {
      headers: { "x-block": "1" },
    }),
  );
  assertEquals(blocked.status, 403);
  assertEquals(await blocked.text(), "blocked");
});

Deno.test("middleware: post-fns run LIFO and always (incl. error paths)", async () => {
  const router = makeRouter();
  const order: string[] = [];
  function outer(_r: PathfinderRequest): PostFnStub {
    return function outerPost() {
      order.push("outer");
    };
  }
  function inner(_r: PathfinderRequest): PostFnStub {
    return function innerPost() {
      order.push("inner");
    };
  }
  type PostFnStub = () => void;
  router.add("GET", "/ok", () => "ok", { chain: [outer, inner] });
  await dispatch(router, GET("/ok"));
  assertEquals(order, ["inner", "outer"]); // LIFO: inner→outer

  order.length = 0;
  router.add("GET", "/throw", () => {
    throw new Error("boom");
  }, { chain: [outer, inner] });
  await quiet(async () => {
    const res = await dispatch(router, GET("/throw"));
    assertEquals(res.status, 500);
  });
  assertEquals(order, ["inner", "outer"]); // post-fns survive errors
});

Deno.test("middleware: short-circuit Response passes through post-fns", async () => {
  const router = makeRouter();
  function adder(): (response: { status: number }) => void {
    return function mark(response) {
      response.status = 403;
    };
  }
  function gate(): Response {
    return new Response("denied", { status: 401 });
  }
  router.add("GET", "/", () => "never", { chain: [adder, gate] });
  const res = await dispatch(router, GET("/"));
  assertEquals(res.status, 403); // post-fn edited the short-circuit response
  assertEquals(await res.text(), "denied");
});

Deno.test("middleware: junk return is a loud contract violation", async () => {
  await quiet(async () => {
    const router = makeRouter();
    function junk(): unknown {
      return 42;
    }
    router.add("GET", "/", () => "x", { chain: [junk as never] });
    router.setOutcome(
      500,
      "/",
      (_r, context) => ({ message: (context.error as Error).message }),
    );
    const res = await dispatch(router, GET("/"));
    const body = await res.json() as { message?: string };
    assert(body.message!.includes("junk"));
    assert(body.message!.includes("a number"));
  });
});

// --- Context (§2.6) -----------------------------------------------------------

Deno.test("context: getter-only containers, open fields, state isolation", async () => {
  const router = makeRouter({ db: "shared" });
  const seen: string[] = [];
  function stater(_r: PathfinderRequest, context: Context): void {
    // fields OPEN
    (context.app as { db: string }).db = (context.app as { db: string }).db;
    (context.state as { hits?: number }).hits =
      ((context.state as { hits?: number }).hits ?? 0) + 1;
    seen.push(JSON.stringify(context.state));
    // container getter-only: strict-mode throw on assignment
    try {
      (context as { state: unknown }).state = {};
      seen.push("REPLACE-ALLOWED");
    } catch {
      seen.push("replace-throws");
    }
    try {
      (context as { app: unknown }).app = {};
      seen.push("APP-REPLACE-ALLOWED");
    } catch {
      seen.push("app-replace-throws");
    }
  }
  router.add("GET", "/", () => "ok", { chain: [stater] });
  await dispatch(router, GET("/"));
  await dispatch(router, GET("/"));
  assertEquals(seen, [
    '{"hits":1}',
    "replace-throws",
    "app-replace-throws",
    '{"hits":1}',
    "replace-throws",
    "app-replace-throws",
  ]); // state starts {} per request — no cross-request leaks
});

Deno.test("context: meta frozen per route; empty on misses", async () => {
  const router = makeRouter();
  router.add("GET", "/m", (_r, context) => {
    try {
      (context.meta as { tag?: string }).tag = "mutated";
      return "mutable";
    } catch {
      return "frozen";
    }
  }, { meta: { tag: "route" } as never });
  router.setOutcome(
    404,
    "",
    (_r, context) => ({ metaKeys: Object.keys(context.meta).length }),
  );
  const res = await dispatch(router, GET("/m"));
  assertEquals(await res.text(), "frozen"); // frozen per route
  const miss = await dispatch(router, GET("/missing"));
  assertEquals((await miss.json() as { metaKeys: number }).metaKeys, 0);
});

// --- Request view (§2.2 + §11) ------------------------------------------------

Deno.test("request view: params coerced, path, lazy query, headers reference", async () => {
  const router = makeRouter();
  router.add("GET", "/api/#(int)id/#(num)n", (request) => ({
    // bigint/number params converted for output — JSON can't carry bigint
    // (documented footnote); the types are asserted separately.
    id: String(request.params.id),
    idType: typeof request.params.id,
    n: request.params.n,
    nType: typeof request.params.n,
    path: request.path,
    q: request.query.get("x"),
    sameHeaders: request.headers === request._raw.headers,
    method: request.method,
  }));
  const res = await dispatch(router, GET("/api/7/2.5?x=y"));
  assertEquals(await res.json(), {
    id: "7",
    idType: "bigint",
    n: 2.5,
    nType: "number",
    path: "/api/7/2.5",
    q: "y",
    sameHeaders: true,
    method: "GET",
  });
});

Deno.test("request view: remoteAddr/completed distilled from host info", async () => {
  const router = makeRouter();
  router.add("GET", "/", (request) => ({
    addr: request.remoteAddr ?? null,
    hasCompleted: request.completed instanceof Promise,
  }));
  const completed = new Promise<void>(() => {});
  const res = await dispatch(router, GET("/"), {
    remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 54321 },
    completed,
    // Host junk that must NOT leak through any hatch:
    localAddr: { transport: "tcp", hostname: "0.0.0.0", port: 80 },
  });
  assertEquals(await res.json(), {
    addr: { transport: "tcp", hostname: "127.0.0.1", port: 54321 },
    hasCompleted: true,
  });
  // Without info: fields absent entirely (guard: undefined → deny).
  const res2 = await dispatch(router, GET("/"));
  const body2 = await res2.json() as { addr: unknown };
  assertEquals(body2.addr, null);
});

// --- Body (§2.3) ---------------------------------------------------------------

Deno.test("body: accessors memoize one read; json re-parses fresh", async () => {
  const router = makeRouter();
  router.add("POST", "/", async (request) => {
    const a = await request.body.json();
    const b = await request.body.json();
    const t = await request.body.text();
    return { a, b, sameObject: a === b, t };
  });
  const res = await dispatch(
    router,
    new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ k: 1 }),
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals(await res.json(), {
    a: { k: 1 },
    b: { k: 1 },
    sameObject: false,
    t: '{"k":1}',
  });
});

Deno.test("body: form accessor", async () => {
  const router = makeRouter();
  router.add("POST", "/", async (request) => {
    const form = await request.body.form();
    return { v: form.get("v") };
  });
  const res = await dispatch(
    router,
    new Request("http://localhost/", {
      method: "POST",
      body: "v=hello",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
  );
  assertEquals(await res.json(), { v: "hello" });
});

Deno.test("body: stream access; accessors-after-stream named error", async () => {
  const router = makeRouter();
  router.add("POST", "/stream", async (request) => {
    let text = "";
    for await (const chunk of request.body.stream!) {
      text += new TextDecoder().decode(chunk);
    }
    return text;
  });
  assertEquals(
    await (await dispatch(
      router,
      new Request("http://localhost/stream", {
        method: "POST",
        body: "wire-bytes",
      }),
    )).text(),
    "wire-bytes",
  );

  await quiet(async () => {
    router.add("POST", "/guard", async (request) => {
      let text = "";
      for await (const chunk of request.body.stream!) {
        text += new TextDecoder().decode(chunk);
      }
      await request.body.text(); // accessors after stream — named error
      return text;
    });
    router.setOutcome(500, "/guard", (_r, context) => ({
      err: (context.error as Error).message,
    }));
    const res = await dispatch(
      router,
      new Request("http://localhost/guard", {
        method: "POST",
        body: "x",
      }),
    );
    const body = await res.json() as { err: string };
    assert(body.err.includes("already been handed out as a stream"));
  });
});

Deno.test("body: middleware cannot consume; disableStreaming overrides", async () => {
  const router = makeRouter();
  async function greedy(request: PathfinderRequest): Promise<void> {
    await request.body.text(); // forbidden by default
  }
  router.add("POST", "/default", () => "x", { chain: [greedy] });
  router.setOutcome(500, "/default", (_r, context) => ({
    err: (context.error as Error).message,
  }));
  await quiet(async () => {
    const res = await dispatch(
      router,
      new Request("http://localhost/default", {
        method: "POST",
        body: "z",
      }),
    );
    const body = await res.json() as { err: string };
    assert(body.err.includes("middleware cannot consume the body"));
    assert(body.err.includes("disableStreaming"));
  });

  // Override: accessors allowed, memoized ⇒ handler still works.
  router.add("POST", "/override", async (request) => ({
    len: (await request.body.text()).length,
  }), { chain: [greedy], disableStreaming: true });
  const ok = await dispatch(
    router,
    new Request("http://localhost/override", {
      method: "POST",
      body: "zz",
    }),
  );
  assertEquals(await ok.json(), { len: 2 });
});

Deno.test("body: pipeThrough queued composition feeds accessors and stream", async () => {
  const upper = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(
        new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase()),
      );
    },
  });
  const router = makeRouter();
  router.add("POST", "/via-accessor", async (request) => {
    request.body.pipeThrough(upper);
    return { t: await request.body.text() };
  });
  const res = await dispatch(
    router,
    new Request("http://localhost/via-accessor", {
      method: "POST",
      body: "quiet",
    }),
  );
  assertEquals(await res.json(), { t: "QUIET" });

  // Zero cost if nobody reads (every GET): pipeThrough then stream read.
  const tagged = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      controller.enqueue(new TextEncoder().encode("!"));
    },
  });
  router.add("POST", "/via-stream", async (request) => {
    request.body.pipeThrough(tagged);
    let text = "";
    for await (const chunk of request.body.stream!) {
      text += new TextDecoder().decode(chunk);
    }
    return text;
  });
  const res2 = await dispatch(
    router,
    new Request("http://localhost/via-stream", {
      method: "POST",
      body: "a",
    }),
  );
  assertEquals(await res2.text(), "a!");
});

Deno.test("body: _raw consumption mid-chain names the culprit", async () => {
  await quiet(async () => {
    async function stealer(request: PathfinderRequest): Promise<void> {
      await request._raw.text(); // owns the consequences
    }
    const router = makeRouter();
    router.add("POST", "/", async (request) => await request.body.text(), {
      chain: [stealer],
    });
    router.setOutcome(500, "/", (_r, context) => ({
      err: (context.error as Error).message,
    }));
    const res = await dispatch(
      router,
      new Request("http://localhost/", {
        method: "POST",
        body: "secret",
      }),
    );
    const body = await res.json() as { err: string };
    assert(body.err.includes("stealer"));
  });
});

// --- Response view (§2.4, §2.5) -------------------------------------------------

Deno.test("response view: status + copy-on-write headers; identity otherwise", async () => {
  const router = makeRouter();
  function responder(response: { status: number; headers: Headers }): void {
    response.status = 201;
    response.headers.set("x-marker", "1");
  }
  router.add("GET", "/edited", () => {
    const original = new Response("made", { headers: { "x-orig": "1" } });
    return original;
  }, { chain: [() => responder] });
  const res = await dispatch(router, GET("/edited"));
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("x-marker"), "1");
  assertEquals(res.headers.get("x-orig"), "1");
  assertEquals(await res.text(), "made");
});

Deno.test("response view: identity fast path keeps the original object untouched", async () => {
  const router = makeRouter();
  function toucher(response: { headers: Headers }): void {
    assertEquals(response.headers.get("x-orig"), "1"); // reads don't clone
  }
  const original = new Response("x", { headers: { "x-orig": "1" } });
  router.add("GET", "/", () => original, { chain: [() => toucher] });
  const res = await dispatch(router, GET("/"));
  assertStrictEquals(res, original);
});

Deno.test("response view: pipeThrough queues transform; CL deleted causally", async () => {
  const router = makeRouter();
  const exclaim = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      controller.enqueue(new TextEncoder().encode("!"));
    },
  });
  function transformer(
    response: { pipeThrough: (t: TransformStream) => void },
  ): void {
    response.pipeThrough(exclaim);
  }
  router.add("GET", "/", () => new Response("hi"), {
    chain: [() => transformer],
  });
  const res = await dispatch(router, GET("/"));
  assertEquals(await res.text(), "hi!");
  assertEquals(res.headers.get("content-length"), null); // body changed; CL dead
});

Deno.test("response view: wholesale replacement resets mutations + transforms", async () => {
  const router = makeRouter();
  const exclaim = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      controller.enqueue(new TextEncoder().encode("!"));
    },
  });
  function inner(
    response: { pipeThrough: (t: TransformStream) => void; status: number },
  ): Response {
    response.pipeThrough(exclaim); // describes a body about to die
    response.status = 418;
    return new Response("replaced", { status: 200 }); // wholesale replacement
  }
  function outer(response: { status: number; headers: Headers }): void {
    // Later (outer) post-fn sees a FRESH view of the replacement.
    assertEquals(response.status, 200);
    response.headers.set("x-after", "1");
  }
  router.add("GET", "/", () => "original", {
    chain: [() => outer, () => inner],
  });
  const res = await dispatch(router, GET("/"));
  assertEquals(res.status, 200); // 418 died with the old body
  assertEquals(await res.text(), "replaced"); // no "!" — transform was queued on a dead body
  assertEquals(res.headers.get("x-after"), "1");
});

// --- Lookup + misses (§8.2, §8.3) ------------------------------------------------

Deno.test("lookup: rich discriminated results", () => {
  const router = makeRouter();
  router.add("GET", "/x", () => null);
  router.add("POST", "/api/#(int)v", () => null);
  assertEquals(router.lookup("GET", "/x").kind, "match");
  const miss = router.lookup("DELETE", "/x");
  assertEquals(miss.kind, "method-miss");
  if (miss.kind === "method-miss") assertEquals(miss.allowed, ["GET"]);
  assertEquals(router.lookup("GET", "/nope").kind, "no-match");
  const m = router.lookup("POST", "/api/9");
  assert(m.kind === "match");
  assertEquals(m.params.v, 9n);
});

Deno.test("misses: 405 vacuum bare; renderer gets complete params + allowed", async () => {
  await quiet(async () => {
    const bare = makeRouter();
    bare.add("GET", "/x", () => "x");
    bare.add("POST", "/x", () => "x");
    const vacuum = await dispatch(
      bare,
      new Request("http://localhost/x", { method: "DELETE" }),
    );
    assertEquals(vacuum.status, 405);
    assertEquals(await vacuum.text(), "");

    const rich = makeRouter();
    rich.add("GET", "/api/rooms/#roomId", (_r) => "x");
    rich.setOutcome(405, "/api/rooms/#roomId", (_r, context) => {
      const miss = context.miss!;
      if (miss.kind !== "method-miss") throw new Error("wrong miss kind");
      return { params: miss.params, allowed: allowedMethods(miss.allowed) };
    });
    const res = await dispatch(
      rich,
      new Request("http://localhost/api/rooms/7", { method: "DELETE" }),
    );
    assertEquals(await res.json(), { params: { roomId: "7" }, allowed: "GET" });
  });
});

Deno.test("misses: OPTIONS without explicit route → 204 capability reflection", async () => {
  const router = makeRouter();
  router.add("GET", "/x", () => "x");
  router.add("POST", "/x", () => "x");
  router.setOutcome(204, "/x", (_r, context) => {
    const miss = context.miss!;
    return new Response(null, {
      status: 204,
      headers: {
        allow: allowedMethods(miss.kind === "method-miss" ? miss.allowed : []),
      },
    });
  });
  const res = await dispatch(
    router,
    new Request("http://localhost/x", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("allow"), "GET, POST");
});

Deno.test("misses: explicit OPTIONS route wins by grammar", async () => {
  const router = makeRouter();
  router.add("GET", "/x", () => "x");
  router.add("OPTIONS", "/x", () => "explicit");
  const res = await dispatch(
    router,
    new Request("http://localhost/x", { method: "OPTIONS" }),
  );
  assertEquals(await res.text(), "explicit");
});

Deno.test("misses: 404 fidelity — anchor captures + rest, cascade anchor", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.add("GET", "/api/v1/rooms/#roomId/messages", () => "m");
    router.setOutcome(404, "/api/v1/rooms/#roomId", (_r, context) => {
      const miss = context.miss!;
      if (miss.kind !== "no-match") throw new Error("wrong miss kind");
      return { params: miss.params, rest: miss.rest };
    });
    // Miss INSIDE the #roomId subtree: the walk statically matches
    // "/messages" and dies at "NOPE" — anchor = the route's own directory
    // (deepest matched point), rest = the unmatched remainder.
    const res = await dispatch(router, GET("/api/v1/rooms/x/messagesNOPE"));
    assertEquals(await res.json(), { params: { roomId: "x" }, rest: "NOPE" });
    // Miss outside any dynamic: vacuum bare 404.
    const bare = await dispatch(router, GET("/other"));
    assertEquals(bare.status, 404);
    assertEquals(await bare.text(), "");
  });
});

Deno.test("misses: miss-chain rule — deepest directory middleware wraps misses", async () => {
  const seen: string[] = [];
  const router = makeRouter();
  function apiLog(_r: PathfinderRequest, _context: Context): void {
    seen.push("api-mw");
  }
  function rootLog(_r: PathfinderRequest): void {
    seen.push("root-mw");
  }
  router.setDirMiddleware("", [rootLog]);
  router.setDirMiddleware("/api", [apiLog]);
  router.add("GET", "/api/v1/rooms/#roomId/messages", () => "m");
  router.setOutcome(
    404,
    "/api/v1/rooms/#roomId",
    () => new Response(null, { status: 404 }),
  );
  await dispatch(router, GET("/api/v1/rooms/x/messagesNOPE"));
  assertEquals(seen, ["root-mw", "api-mw"]); // root before child; runs on misses
  seen.length = 0;
  await dispatch(router, GET("/api/v1/rooms/x/messages"));
  assertEquals(seen, ["root-mw", "api-mw"]); // same chain on matches
});

Deno.test("misses: 500 outcome — complete params + meta + context.error", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.add("GET", "/api/#(int)n", () => {
      throw new Error("exploded");
    }, { meta: { tag: "boom" } as never });
    router.setOutcome(500, "/api/#(int)n", (request, context) => ({
      params: { n: String((request.params as { n: bigint }).n) },
      meta: context.meta,
      err: (context.error as Error).message,
    }));
    const res = await dispatch(router, GET("/api/5"));
    assertEquals(await res.json(), {
      params: { n: "5" },
      meta: { tag: "boom" },
      err: "exploded",
    });
  });
});

// --- Framing policy (§2.5) --------------------------------------------------------

// CL is framing; framing belongs to the runtime — verified on the wire.
Deno.test("framing: wire-level — auto CL, chunked streams, causal CL deletion", async () => {
  const router = makeRouter();
  router.add("GET", "/json", () => json({ a: 1 })); // Response.json → auto CL
  router.add("GET", "/stream", () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("abc"));
        c.close();
      },
    })); // stream → chunked, no CL
  const exclaim = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      controller.enqueue(new TextEncoder().encode("!"));
    },
  });
  function transformer(
    response: { pipeThrough: (t: TransformStream) => void },
  ): void {
    response.pipeThrough(exclaim);
  }
  // Response constructed with an explicit CL + queued transform → the
  // framework changed the body → it deletes the stale CL (no chunked lie).
  router.add(
    "GET",
    "/transformed",
    () => new Response("hi", { headers: { "content-length": "2" } }),
    {
      chain: [() => transformer],
    },
  );

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    (request) => router.handle(request),
  );
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const jsonRes = await fetch(base + "/json");
    assertEquals(jsonRes.headers.get("content-length"), "7");
    assertEquals(await jsonRes.text(), '{"a":1}');
    const streamRes = await fetch(base + "/stream");
    assertEquals(streamRes.headers.get("content-length"), null);
    assertEquals(await streamRes.text(), "abc");
    const transRes = await fetch(base + "/transformed");
    assertEquals(transRes.headers.get("content-length"), null); // deleted, not computed
    assertEquals(await transRes.text(), "hi!");
  } finally {
    await server.shutdown();
  }
});
