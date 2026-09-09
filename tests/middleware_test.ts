// SPDX-License-Identifier: LGPL-3.0-only

// Shipped middleware set tests: CORS preflight short-circuit + stamps on
// misses/errors/upgrades, clientIp XFF discipline, logger/timing/accessLog
// output shapes, compress round-trip + stale Content-Length strip. The
// CORS+WebSocket interplay is proven end-to-end at the wire level in
// tests/websocket_test.ts and re-proven here through the shipped cors().

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Router } from "../src/router.ts";
import {
  accessLog,
  clientIp,
  compress,
  cors,
  logger,
  timing,
} from "../src/middleware/mod.ts";
import type { Middleware } from "../src/router.ts";

// The consumer-side state-slice idiom (module augmentation — the one idiom
// for apps AND middleware; documented on clientIp).
declare module "../src/router.ts" {
  interface State {
    clientIp?: string;
  }
}

const quiet = async (fn: () => Promise<void>): Promise<void> => {
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
};

function makeRouter(): Router {
  return new Router();
}

const GET = (path: string, headers: HeadersInit = {}) =>
  new Request("http://localhost" + path, { headers });

// --- CORS --------------------------------------------------------------------

Deno.test("cors: preflight OPTIONS short-circuits with the full header set", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{
      middleware: cors({
        origin: "*",
        headers: "Authorization, Content-Type",
        maxAge: 600,
      }),
    }]);
    router.add("GET", "/x", () => "body");
    const response = await router.handle(
      new Request("http://localhost/x", {
        method: "OPTIONS",
        headers: { "access-control-request-method": "DELETE" },
      }),
    );
    assertEquals(response.status, 204);
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
    assertEquals(
      response.headers.get("access-control-allow-methods"),
      "GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS",
    );
    assertEquals(
      response.headers.get("access-control-allow-headers"),
      "Authorization, Content-Type",
    );
    assertEquals(response.headers.get("access-control-max-age"), "600");
  });
});

Deno.test("cors: plain OPTIONS without the preflight header is not short-circuited", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: cors() }]);
    router.add("GET", "/x", () => "body");
    const response = await router.handle(
      new Request("http://localhost/x", {
        method: "OPTIONS",
      }),
    );
    // Falls through to the handler chain → 204 method-miss outcome (vacuum).
    assertEquals(response.status, 204);
  });
});

Deno.test("cors: stamp on a normal response", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: cors() }]);
    router.add("GET", "/x", () => ({ ok: true }));
    const response = await router.handle(GET("/x"));
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
  });
});

Deno.test("cors: stamps 404 and 405 (miss-chain runs the middleware)", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: cors() }]);
    router.add("GET", "/x", () => "body");
    const notFound = await router.handle(GET("/missing"));
    assertEquals(notFound.status, 404);
    assertEquals(
      notFound.headers.get("access-control-allow-origin"),
      "*",
      "stamp present on a 404 miss",
    );
    const methodMiss = await router.handle(
      new Request("http://localhost/x", { method: "DELETE" }),
    );
    assertEquals(methodMiss.status, 405);
    assertEquals(
      methodMiss.headers.get("access-control-allow-origin"),
      "*",
      "stamp present on a 405 miss",
    );
  });
});

Deno.test("cors: stamps 500 and HttpError responses (post-fns always run)", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: cors() }]);
    router.add("GET", "/boom", () => {
      throw new Error("boom");
    });
    const { HttpError } = await import("../src/http.ts");
    router.add("GET", "/rejected", () => {
      throw new HttpError(418, "teapot");
    });
    const serverError = await router.handle(GET("/boom"));
    assertEquals(serverError.status, 500);
    assertEquals(
      serverError.headers.get("access-control-allow-origin"),
      "*",
      "stamp present on a 500",
    );
    const httpError = await router.handle(GET("/rejected"));
    assertEquals(httpError.status, 418);
    assertEquals(
      httpError.headers.get("access-control-allow-origin"),
      "*",
      "stamp present on an HttpError",
    );
  });
});

Deno.test("cors: stamp lands on a WebSocket upgrade (in place, wire-level via cors())", async () => {
  const router = makeRouter();
  router.setDirMiddleware("", [{ middleware: cors() }]);
  router.add("GET", "/ws", (request) => {
    const upgrade = request.upgrade();
    upgrade.socket.then((ws) => {
      ws.onmessage = (ev) => ws.send(ev.data);
    });
    return upgrade.response;
  });
  const server = Deno.serve(
    { port: 0 },
    (request, info) => router.handle(request, info),
  );
  try {
    const conn = await Deno.connect({
      port: (server.addr as Deno.NetAddr).port,
    });
    const key = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    await conn.write(
      new TextEncoder().encode(
        `GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    const head = await readHead(conn);
    assertStringIncludes(head, "101");
    assertStringIncludes(
      head.toLowerCase(),
      "access-control-allow-origin: *",
      "shipped cors() stamps the 101 response in place",
    );
    conn.close();
  } finally {
    await server.shutdown();
  }
});

async function readHead(conn: Deno.Conn): Promise<string> {
  let acc = "";
  const decoder = new TextDecoder();
  while (!acc.includes("\r\n\r\n")) {
    const chunk = new Uint8Array(1024);
    const n = await conn.read(chunk);
    if (n === null) throw new Error("connection closed");
    acc += decoder.decode(chunk.subarray(0, n));
  }
  return acc;
}

// --- clientIp ------------------------------------------------------------------

const INFO = (hostname: string) => ({
  remoteAddr: { transport: "tcp", hostname, port: 44444 },
});

Deno.test("clientIp: peer hostname without XFF", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: clientIp() }]);
    router.add("GET", "/who", (_request, context) => ({
      ip: context.state.clientIp,
    }));
    const response = await router.handle(
      GET("/who"),
      INFO("203.0.113.7"),
    );
    assertEquals(await response.json(), { ip: "203.0.113.7" });
  });
});

Deno.test("clientIp: untrusted peer's XFF is ignored (spoofing can only deny)", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: clientIp() }]);
    router.add("GET", "/who", (_request, context) => ({
      ip: context.state.clientIp,
    }));
    const response = await router.handle(
      GET("/who", { "x-forwarded-for": "1.2.3.4" }),
      INFO("203.0.113.7"),
    );
    assertEquals(
      await response.json(),
      { ip: "203.0.113.7" },
      "spoofed XFF never changes the extracted IP",
    );
  });
});

Deno.test("clientIp: trusted proxy — rightmost untrusted entry wins", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{
      middleware: clientIp({ trust: ["10.0.0.1", "10.0.0.2"] }),
    }]);
    router.add("GET", "/who", (_request, context) => ({
      ip: context.state.clientIp,
    }));
    const response = await router.handle(
      GET("/who", { "x-forwarded-for": "198.51.100.9, 10.0.0.1" }),
      INFO("10.0.0.2"),
    );
    assertEquals(await response.json(), { ip: "198.51.100.9" });
  });
});

// --- logger / timing / accessLog -------------------------------------------------

function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return fn().finally(() => {
    console.log = log;
  }).then(() => lines);
}

Deno.test("logger: one line per request with method, path, status, ms", async () => {
  const router = makeRouter();
  router.setDirMiddleware("", [{ middleware: logger() }]);
  router.add("GET", "/x", () => "body");
  const lines = await captureLogs(async () => {
    const response = await router.handle(GET("/x"));
    assertEquals(response.status, 200);
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "GET /x 200 ");
  assertStringIncludes(lines[0], "ms");
});

Deno.test("timing: server-timing total dur header", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: timing() }]);
    router.add("GET", "/x", () => "body");
    const response = await router.handle(GET("/x"));
    assertEquals(response.status, 200);
    const header = response.headers.get("server-timing")!;
    assertStringIncludes(header, "total;dur=");
  });
});

Deno.test("accessLog: head line + completed disposition line", async () => {
  const router = makeRouter();
  router.setDirMiddleware("", [{ middleware: accessLog() }]);
  router.add("GET", "/x", () => "body");
  const lines = await captureLogs(async () => {
    const response = await router.handle(GET("/x"), {
      completed: Promise.resolve(),
    });
    assertEquals(response.status, 200);
    // Let the resolved `completed` continuation log its line.
    await new Promise((r) => setTimeout(r, 0));
  });
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0], "GET /x 200 +");
  assertStringIncludes(lines[1], "GET /x sent ");
});

// --- compress --------------------------------------------------------------------

Deno.test("compress: gzip round-trips a body and drops the stale Content-Length", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: compress() }]);
    router.add("GET", "/x", () => "hello compressible world".repeat(10));
    const response = await router.handle(GET("/x", {
      "accept-encoding": "gzip",
    }));
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-encoding"), "gzip");
    assertEquals(
      response.headers.get("content-length"),
      null,
      "framework strips the falsified CL",
    );
    assertEquals(
      response.headers.get("vary"),
      "accept-encoding",
    );
    const inflated = response.body!.pipeThrough(
      new DecompressionStream("gzip"),
    );
    const body = await new Response(inflated).text();
    assertEquals(body, "hello compressible world".repeat(10));
  });
});

Deno.test("compress: no negotiation — passthrough", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: compress() }]);
    router.add("GET", "/x", () => "plain");
    const response = await router.handle(GET("/x"));
    assertEquals(response.headers.get("content-encoding"), null);
    assertEquals(await response.text(), "plain");
  });
});

Deno.test("compress: gzip;q=0 is a rejection", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: compress() }]);
    router.add("GET", "/x", () => "plain");
    const response = await router.handle(GET("/x", {
      "accept-encoding": "gzip;q=0, deflate",
    }));
    assertEquals(response.headers.get("content-encoding"), null);
    assertEquals(await response.text(), "plain");
  });
});

Deno.test("compress: skips already-encoded responses and empty bodies", async () => {
  await quiet(async () => {
    const router = makeRouter();
    router.setDirMiddleware("", [{ middleware: compress() }]);
    router.add("GET", "/encoded", () =>
      new Response("already", {
        headers: { "content-encoding": "br" },
      }));
    const encoded = await router.handle(GET("/encoded", {
      "accept-encoding": "gzip",
    }));
    assertEquals(encoded.headers.get("content-encoding"), "br");
    router.add("GET", "/empty", () => new Response(null, { status: 204 }));
    const empty = await router.handle(GET("/empty", {
      "accept-encoding": "gzip",
    }));
    assertEquals(empty.status, 204);
    assertEquals(empty.headers.get("content-encoding"), null);
  });
});

// Middleware type sanity: every factory satisfies the Middleware face.
const _factories: Middleware[] = [
  cors(),
  clientIp(),
  logger(),
  timing(),
  accessLog(),
  compress(),
];
