# Dev notes

Practical answers for running, watching, and operating a pathfinder server.
Normative framework semantics live in [SEMANTICS.md](SEMANTICS.md).

## Watch mode

The dev answer is the platform's:

```sh
deno run --watch --allow-net --allow-read your-server.ts
```

The loader resolves endpoint roots at boot; `--watch` restarts the process when
any imported file changes, which re-walks the tree and reprints the startup
summary line (the method histogram is your did-you-mean net for stray files).

## Two listeners, two ports

Multiple API surfaces on one process: two `pathfinder()` instances with
different `roots`, two `Deno.serve` calls. Each instance is its own callable app
with its own Layer 0 (its own `/_status/` subtree and loopback guard) and its
own startup summary. There is no front dispatcher to wire — run the servers you
need:

```ts
const cs = await pathfinder({ roots: ["./endpoints/"] });
const internal = await pathfinder({ roots: ["./internal-endpoints/"] });

Deno.serve({ port: 8008 }, cs);
Deno.serve({ port: 8009 }, internal);
```

## Cookies

Cookie helpers are a docs recipe over `@std/http/cookie`, never core:

```ts
import { getCookies, setCookie } from "jsr:@std/http/cookie";

export default (request, context) => {
  const session = getCookies(request.headers).session;
  const response = new Response("ok");
  if (!session) {
    setCookie(response.headers, {
      name: "session",
      value: crypto.randomUUID(),
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
      path: "/",
    });
  }
  return response;
};
```

## Graceful shutdown

`Deno.serve` returns a server with `shutdown()` — it stops accepting new
connections and waits for in-flight responses to drain:

```ts
const server = Deno.serve({ port: 8008 }, app);

Deno.addSignalListener("SIGTERM", () => {
  server.shutdown().then(() => console.log("drained, exiting"));
});
```

Caveat: a never-ending response (Server-Sent Events, a long poll) never drains,
so `shutdown()` never resolves. Bound the wait with an `AbortSignal` deadline
and close your SSE streams on abort:

```ts
await Promise.race([
  server.shutdown(),
  new Promise((r) => setTimeout(r, 10_000).unref?.() ?? setTimeout(r, 10_000)),
]);
Deno.exit(0);
```

(Design the SSE handler itself to honor the client's abort —
`request._raw.signal` — and the drain completes naturally in the common case.)

## WebSocket upgrade

To upgrade, call `request.upgrade(params)` in the handler and return the
placeholder response it hands back. The framework validates the upgrade headers
at call time (a `TypeError` with the platform's message shapes on failure),
performs the actual upgrade when the response materializes, and resolves the
socket promise. The handler owns the socket lifecycle:

```ts
// endpoints/events/get.ts
export default (request) => {
  const upgrade = request.upgrade({});
  upgrade.socket.then((ws) => {
    ws.onmessage = (ev) => ws.send(ev.data);
    ws.onclose = () => {/* cleanup */};
  });
  return upgrade.response;
};
```

`params` is the RFC 6455 handshake bag — required (pass `{}` when empty);
`options` is host knobs (`idleTimeout` seconds today, `0` disables):

```ts
request.upgrade({ protocol: "chat" }); // stamps Sec-WebSocket-Protocol
request.upgrade({ protocol: "chat" }, { idleTimeout: 60 });
```

Facts worth knowing:

- One upgrade per request; a second `request.upgrade()` call errors.
- The handler must return the placeholder — returning anything else is a
  contract violation. A middleware post-fn wholesale-replacing the placeholder
  cancels the upgrade (the socket promise rejects).
- Headers are the only meaningful edits on an upgrade response: middleware
  stamps (CORS, security headers) are applied in place by the framework; status
  edits and body transforms are dropped with a debug log.
- The legacy escape hatch still works — `Deno.upgradeWebSocket(request._raw)`
  returned directly rides the identity fast path when nothing edits it, and gets
  the same in-place header application when something does.
