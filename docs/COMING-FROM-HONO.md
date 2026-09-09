# Coming from Hono

You know the shape: one app object, `app.get()`, a context threaded through
middleware, `next()`. pathfinder keeps the ergonomics you actually use and
changes where the code lives. This page maps the concepts, then names the four
deltas that surprise people.

## Concept map

| Hono                                          | pathfinder                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Hono()` + `app.get(path, handler)`       | `pathfinder({ roots: ["./endpoints/"] })` — routes are the filesystem: directory path = pattern, `get.ts` = the GET handler                                                                          |
| `app.route()` / `app.basePath()` mounting     | nested directories; ordered roots with last-wins shadowing                                                                                                                                           |
| `c.req.param("id")`                           | `request.params.id` — decoded and validated/typed at capture (`#(int)x`, `#(num)x`)                                                                                                                  |
| `c.req.query("q")`                            | `request.query.get("q")` — lazy, cached `URLSearchParams`                                                                                                                                            |
| `c.req.json()`                                | `request.body.json()` — lazy accessor; `parseJson(request)` (from `./body`) wraps parse failures into a catchable `ParseError`                                                                       |
| `c.req.raw`                                   | `request._raw` — the native platform Request                                                                                                                                                         |
| `c.env`, `c.set()/c.get()`                    | `context.app` (long-lived, provided at construction) and `context.state` (per-request, middleware-writable). No get/set bag — plain typed objects, augmentable via `interface State`/`interface App` |
| `c.var`                                       | `context.state`                                                                                                                                                                                      |
| `app.use("*", mw)`                            | `<digits>-<label>.ts` middleware files beside the route files; digits are the order                                                                                                                  |
| `c.status()` / `c.body()` / `return c.json()` | return values coerce: object → JSON, string → text/plain, `Response` → identity, stream → streamed. Helpers (`./response`): `json()`, `html()`, `text()`, `redirect()`                               |
| `createMiddleware()`                          | export a function `(request, context)` returning `void`, a `Response`, or a post-fn                                                                                                                  |
| `app.onError()`                               | `500.ts` status-page files, subtree-scoped                                                                                                                                                           |
| `app.notFound()`                              | `404.ts` status-page files, subtree-scoped                                                                                                                                                           |
| `serve(app)`                                  | `Deno.serve(app)` — the factory returns the callable app itself                                                                                                                                      |

## The four deltas

### 1. Routes are files

There is no route-registration call. `/api/v1/rooms/:roomId` is:

```
endpoints/api/v1/rooms/#roomId/get.ts
```

Dynamic segments are `#roomId` (filesystem-legal everywhere `:` is not), typed
inline: `#(int)n`, `#(num)price`. The file's default export is the handler;
named exports are route metadata. There is no `index.ts` — a 404 returning
content lies; the catch-all is the grammar-native rest route
(`#...path/get.ts`).

### 2. There is no `next()`

Middleware cannot call into the rest of the chain because the framework owns the
loop — the chain is data, compiled per route. Middleware returns exactly one of:

- `undefined` — continue;
- a `Response` — short-circuit (pre-phase) or wholesale-replace (post-fn);
- a post-fn `(response) => void | Response` — join the response path. Post-fns
  run LIFO, always — even after errors — which is why a root `00-cors.ts` can
  stamp headers on 404s, 500s, and WebSocket upgrades alike.

What you lose: in-middleware retry and downstream try/catch. What you get:
post-fns that always run (metrics can't be swallowed), and error pages recovered
via subtree status files.

### 3. Middleware is return-value based, positioned by file

`10-auth.ts` sorts before `20-rate-limit.ts`; parent directories wrap child
directories. Body-bound middleware sits inner (it can queue request transforms
via `request.body.pipeThrough`); replacement-robust middleware (security
headers, CORS, request-id) sits outer. Streaming-first is the default:
middleware cannot consume the request body, only transform it.

### 4. Layers and overlays are built in

`PATHFINDER_USER_ENDPOINTS` points at additional endpoint roots — routes found
there override or augment the app's own, per file, no changes to the app's code
required. Unset = zero extra FS access. `export default null` in an overlay
tombstones a single route or middleware file. `app.manifest()` is the effective
file table (every row, including tombstones).
