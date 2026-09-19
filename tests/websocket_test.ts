// SPDX-License-Identifier: LGPL-3.0-only

// WebSocket upgrade tests: the `request.upgrade()` membrane (placeholder +
// socket promise + materialize-time host call), the materialize 101 in-place
// rule (never reconstruct — recorded header mutations apply in place), the
// contract edges, and the legacy handler-does-host-call path. Wire-level
// tests run a real Deno.serve and speak the handshake + frame protocol over
// a raw TCP connection, so the assertions see the actual bytes on the wire.

import { assertEquals } from "@std/assert";
import { Router } from "../src/router.ts";
import type { Middleware } from "../src/router.ts";

// --- Log capture -------------------------------------------------------------

function captureLogs(
  fn: () => Promise<void>,
): Promise<{ errors: string[]; debugs: string[] }> {
  const errors: string[] = [];
  const debugs: string[] = [];
  const { error, debug } = console;
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(" "));
  console.debug = (...args: unknown[]) =>
    debugs.push(args.map(String).join(" "));
  return fn().finally(() => {
    console.error = error;
    console.debug = debug;
  }).then(() => ({ errors, debugs }));
}

// --- Raw WebSocket client (wire level) ---------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readFull(conn: Deno.Conn, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const n = await conn.read(out.subarray(offset));
    if (n === null) {
      throw new Error(`connection closed (wanted ${length}, got ${offset})`);
    }
    offset += n;
  }
  return out;
}

async function readUntil(
  conn: Deno.Conn,
  sentinel: string,
): Promise<string> {
  let acc = "";
  while (!acc.includes(sentinel)) {
    const chunk = new Uint8Array(1024);
    const n = await conn.read(chunk);
    if (n === null) throw new Error("connection closed while reading head");
    acc += decoder.decode(chunk.subarray(0, n));
  }
  return acc;
}

function maskFrame(text: string): Uint8Array {
  const payload = encoder.encode(text);
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const head: number[] = [0x81]; // FIN + text
  if (payload.length < 126) {
    head.push(0x80 | payload.length);
  } else if (payload.length < 65536) {
    head.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  } else {
    throw new Error("test frames stay under 64KiB");
  }
  const masked = payload.map((b, i) => b ^ mask[i % 4]);
  const frame = new Uint8Array(head.length + 4 + masked.length);
  frame.set(head, 0);
  frame.set(mask, head.length);
  frame.set(masked, head.length + 4);
  return frame;
}

async function readTextFrame(conn: Deno.Conn): Promise<string> {
  const head = await readFull(conn, 2);
  assertEquals(head[0] & 0x0f, 1, "expected a text frame");
  let length = head[1] & 0x7f;
  if (length === 126) {
    const ext = await readFull(conn, 2);
    length = (ext[0] << 8) | ext[1];
  } else if (length === 127) {
    throw new Error("test frames stay under 64KiB");
  }
  assertEquals(head[1] & 0x80, 0, "server frames are unmasked");
  const payload = await readFull(conn, length);
  return decoder.decode(payload);
}

interface RawHandshake {
  statusLine: string;
  headers: Headers;
  echo(text: string): Promise<string>;
  close(): void;
}

/** A real WS client handshake at wire level: plain TCP, HTTP upgrade request,
 * byte-level assertions on the 101, then masked client frames / unmasked
 * server frames. `extraHeaders` appends raw request headers (e.g.
 * `Sec-WebSocket-Protocol`). */
async function wsHandshake(
  port: number,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<RawHandshake> {
  const conn = await Deno.connect({ port });
  const key = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  );
  const extra = Object.entries(extraHeaders ?? {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  const request =
    `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;
  await conn.write(encoder.encode(request));
  const head = await readUntil(conn, "\r\n\r\n");
  const [statusLine, ...headerLines] = head.split("\r\n");
  const headers = new Headers();
  for (const line of headerLines) {
    const cut = line.indexOf(":");
    if (cut > 0) {
      headers.set(line.slice(0, cut).trim(), line.slice(cut + 1).trim());
    }
  }
  return {
    statusLine,
    headers,
    echo: (text) => conn.write(maskFrame(text)).then(() => readTextFrame(conn)),
    close: () => conn.close(),
  };
}

// --- Harness -----------------------------------------------------------------

function serve(router: Router): { server: Deno.HttpServer; port: number } {
  const server = Deno.serve(
    { port: 0 },
    (request, info) => router.handle(request, info),
  );
  const port = (server.addr as Deno.NetAddr).port;
  return { server, port };
}

/** Commit-1 stand-in for the shipped cors() middleware: a post-fn that
 * stamps a header on everything (incl. 101 upgrades, in place). */
const corsLike = (): Middleware => (_request, _context) => (response) => {
  response.headers.set("access-control-allow-origin", "*");
};

const WS_HEADERS = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
};

const DISPATCH = (path: string, headers: HeadersInit = {}) =>
  new Request("http://localhost" + path, { headers });

// --- 1. Wire level: new API behind a header-mutating post-fn -------------------

Deno.test("websocket: request.upgrade() — 101 with stamped header over the wire, socket echoes", async () => {
  const router = new Router();
  router.setDirMiddleware("", [{ middleware: corsLike() }]);
  router.add("GET", "/ws", (request) => {
    const upgrade = request.upgrade({});
    upgrade.socket.then((ws) => {
      ws.onmessage = (ev) => ws.send(ev.data);
    });
    return upgrade.response;
  });
  const { server, port } = serve(router);
  try {
    const client = await wsHandshake(port, "/ws");
    assertEquals(client.statusLine, "HTTP/1.1 101 Switching Protocols");
    assertEquals(
      client.headers.get("access-control-allow-origin"),
      "*",
      "post-fn header stamped in place on the upgrade response",
    );
    assertEquals(
      client.headers.get("sec-websocket-protocol"),
      null,
      "empty params do not stamp a subprotocol",
    );
    assertEquals(await client.echo("ping"), "ping");
    assertEquals(await client.echo("hello"), "hello");
    client.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("websocket: upgrade({ protocol }) stamps Sec-WebSocket-Protocol", async () => {
  const router = new Router();
  router.add("GET", "/ws", (request) => {
    const upgrade = request.upgrade({ protocol: "chat" });
    upgrade.socket.then((ws) => {
      ws.onmessage = (ev) => ws.send(ev.data);
    });
    return upgrade.response;
  });
  const { server, port } = serve(router);
  try {
    const client = await wsHandshake(port, "/ws", {
      "Sec-WebSocket-Protocol": "chat",
    });
    assertEquals(client.statusLine, "HTTP/1.1 101 Switching Protocols");
    assertEquals(client.headers.get("sec-websocket-protocol"), "chat");
    assertEquals(await client.echo("ping"), "ping");
    client.close();
  } finally {
    await server.shutdown();
  }
});

// --- 2. Contract edges ---------------------------------------------------------

Deno.test("websocket: invalid upgrade request — TypeError at call time with the host's message shape", async () => {
  const router = new Router();
  router.add("GET", "/ws", (request) => request.upgrade({}) && "nope");
  const { errors } = await captureLogs(() =>
    (async () => {
      const response = await router.handle(DISPATCH("/ws"));
      assertEquals(response.status, 500);
    })()
  );
  assertEquals(
    errors.some((e) =>
      e.includes("Invalid Header: 'upgrade' header must contain 'websocket'")
    ),
    true,
  );
});

Deno.test("websocket: missing connection header — host's message shape", async () => {
  const router = new Router();
  router.add("GET", "/ws", (request) => request.upgrade({}) && "nope");
  const { errors } = await captureLogs(() =>
    (async () => {
      const response = await router.handle(
        DISPATCH("/ws", { upgrade: "websocket", "sec-websocket-key": "x" }),
      );
      assertEquals(response.status, 500);
    })()
  );
  assertEquals(
    errors.some((e) =>
      e.includes("Invalid Header: 'connection' header must contain 'Upgrade'")
    ),
    true,
  );
});

Deno.test("websocket: missing sec-websocket-key — host's message shape", async () => {
  const router = new Router();
  router.add("GET", "/ws", (request) => request.upgrade({}) && "nope");
  const { errors } = await captureLogs(() =>
    (async () => {
      const response = await router.handle(
        DISPATCH("/ws", { upgrade: "websocket", connection: "Upgrade" }),
      );
      assertEquals(response.status, 500);
    })()
  );
  assertEquals(
    errors.some((e) =>
      e.includes("Invalid Header: 'sec-websocket-key' header must be set")
    ),
    true,
  );
});

Deno.test("websocket: second upgrade() call errors", async () => {
  const router = new Router();
  router.add("GET", "/ws", (request) => {
    request.upgrade({});
    request.upgrade({});
    return "nope";
  });
  const { errors } = await captureLogs(() =>
    (async () => {
      const response = await router.handle(DISPATCH("/ws", WS_HEADERS));
      assertEquals(response.status, 500);
    })()
  );
  assertEquals(
    errors.some((e) => e.includes("Already upgraded")),
    true,
  );
});

Deno.test("websocket: flag set but a different value returned — loud contract violation", async () => {
  const router = new Router();
  let socketRejected = false;
  router.add("GET", "/ws", (request) => {
    const upgrade = request.upgrade({});
    upgrade.socket.catch(() => socketRejected = true);
    return "not the placeholder";
  });
  const { errors } = await captureLogs(() =>
    (async () => {
      const response = await router.handle(DISPATCH("/ws", WS_HEADERS));
      assertEquals(response.status, 500);
    })()
  );
  assertEquals(
    errors.some((e) =>
      e.includes(
        "handler called request.upgrade() but returned a different value",
      )
    ),
    true,
  );
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(socketRejected, true, "the socket promise rejects");
});

Deno.test("websocket: placeholder replaced by a post-fn — upgrade cancelled (101 never ships)", async () => {
  const router = new Router();
  let socketRejected = false;
  router.add("GET", "/ws", (request) => {
    const upgrade = request.upgrade({});
    upgrade.socket.catch(() => socketRejected = true);
    return upgrade.response;
  });
  router.setDirMiddleware("", [{
    middleware: () => () => new Response("replaced"),
  }]);
  const { debugs } = await captureLogs(() =>
    (async () => {
      const response = await router.handle(DISPATCH("/ws", WS_HEADERS));
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "replaced");
    })()
  );
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(socketRejected, true, "the socket promise rejects");
  assertEquals(
    debugs.some((d) => d.includes("WebSocket upgrade cancelled")),
    true,
  );
});

// --- 3. Legacy path: handler does the host call itself --------------------------

Deno.test("websocket: legacy Deno.upgradeWebSocket(request._raw) — headers applied in place, socket works", async () => {
  const router = new Router();
  router.setDirMiddleware("", [{ middleware: corsLike() }]);
  router.add("GET", "/legacy", (request) => {
    const { socket, response } = Deno.upgradeWebSocket(request._raw);
    socket.onmessage = (ev) => socket.send(ev.data);
    return response;
  });
  const { server, port } = serve(router);
  try {
    const client = await wsHandshake(port, "/legacy");
    assertEquals(client.statusLine, "HTTP/1.1 101 Switching Protocols");
    assertEquals(
      client.headers.get("access-control-allow-origin"),
      "*",
      "recorded mutation applied in place — never reconstructed",
    );
    assertEquals(await client.echo("legacy"), "legacy");
    client.close();
  } finally {
    await server.shutdown();
  }
});
