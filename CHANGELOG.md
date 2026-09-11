# Changelog

## 2026-09-08

### Feature

The ledger-GO promises ship, surfaced by pathfinder's first real consumer
(communico, migrating its Matrix homeserver off oak). WebSocket upgrades become
a first-class request view method: `request.upgrade()` validates the headers at
call time, hands back a placeholder response plus a socket promise, and the
framework performs the upgrade at materialization — so middleware stamps (CORS)
land on the 101 in place instead of killing the socket. Any 101 response is now
identity-only in materialization: never reconstructed, recorded header mutations
applied in place, legacy `Deno.upgradeWebSocket(request._raw)` handlers
untouched. The optional middleware set ships — `cors()` (preflight
short-circuit + always-run stamping on misses, errors, and upgrades),
`clientIp()` (fail-closed XFF discipline), `logger()`, `timing()`, `accessLog()`
(honest time-to-last-byte via `request.completed`), and `compress()`
(CompressionStream via `pipeThrough`, stale Content-Length stripped by the
framework's causal-knowledge rule). `parseJson(request)` wraps JSON
`SyntaxError` into a distinct, catchable `ParseError` so an API can map client
faults to its own shaped bodies — the framework's 500-by-default error model is
unchanged. Docs: coming-from-Hono guide, dev notes (watch mode, two listeners,
cookies, graceful shutdown, WS recipe), and the error-shapes teaching doc.

Two late rulings complete the surface before the gate. The public API is
re-grouped into namespaced subpaths — `./response`, `./middleware`, `./body`,
`./grammar`, `./loader` — a hard move with no compat aliases; `mod.ts` stays the
thin root face (framework types, `pathfinder()`, `HttpError`), engine internals
(`coerceResult`, `ContractViolation`, `allowedMethods`) are un-exposed. And
`HttpError` is payload-agnostic: `HttpError(status, body?, headers?)` renders
the body verbatim via the return-contract coercion — the `{"detail": …}`
envelope is no longer imposed (the Layer-0 default outcome pages keep it as
_our_ choice; consumers write their own shape explicitly).

- websocket: request.upgrade() + materialize 101 in-place handling (`d5e2055`)
- middleware: ship the optional set (cors, clientIp, logger, timing, accessLog,
  compress) (`478d3e1`)
- http: ParseError + parseJson convenience (`3774af6`)
- docs: coming-from-hono, dev notes, error-shapes teaching doc (`9231d20`)
- namespace: re-group the public surface into subpaths (`293f8cc`)
- http: payload-agnostic HttpError — the body is the payload (`717d832`)

## 2026-09-01

### Feature

Registry installs now carry the full framework surface: Layer 0 ships as a
generated index module that statically imports the packaged tree, so
`deno install` materializes every default outcome page and the `/_status`
subtree into the import-graph cache — identical behavior on checkouts and JSR
installs, offline thereafter, with no protocol gate or degraded mode. The same
mechanism is public for framework authors: `gen index <dir>` emits a sibling
tree index, and `pathfinder({ roots })` accepts imported index modules alongside
filesystem roots (`https:` string roots are refused loudly). Both `layer0.ts`
and user indexes are drift-gated via `gen index --check`.

- gen: index subcommand — emit sibling tree index (`afefad9`)
- layer0: index-primary via generated layer0.ts (`61175bc`)

## 2026-08-31

### Feature

Initial public release. The compiled `#`-grammar automaton (ported from the
benchmark lab, registry v2 with `(num)`/`(int)→bigint` coercion), the framework
layer (return-value middleware, views, context containers, return contract), the
filesystem loader with ordered roots + tombstones + `PATHFINDER_USER_ENDPOINTS`
always-on, the `pathfinder()` factory with manifest/`/_status` ops face and
loopback guard, typed-params codegen, and the `context._manifest()` accessor.
First published as `@pathfinder/pathfinder@0.1.0` on JSR.

- Scaffold pathfinder package skeleton (`1823a24`)
- Port compiled chunk automaton from matcher spike (`79cbe55`)
- Add framework layer: main loop, views, middleware engine (`bc960a7`)
- Add filesystem loader, Layer 0, pathfinder() factory, $types generator
  (`92618f7`)
- router: context._manifest() — read-only manifest accessor (`a529706`)
- layer0: file-based tree walked from the package (`44dc4eb`)

### Fix

- Exclude tests and bench snapshots from JSR publish (`315ae29`)

### Docs

README with the filesystem routing tour, IoC story and benchmark summary;
SEMANTICS.md as the normative spec; the cleaned public dashboard.

- Add docs, dashboard, README (`e6a4b64`)
- docs: expose products only — no spike references (`1d96a65`)
- readme: collapse the latency chart, warn on light themes (`072b69c`)
