# Changelog

## 2026-09-13

### Feature

`body.bytes()` — a memoized raw accessor beside `text()`/`json()`, exposing the
internal `#bytes` memo: one read, cached, and `text()`/`json()`/`form()` still
work after it. Unblocks fatal-UTF-8 JSON validation (`new TextDecoder("utf-8",
{ fatal: true })` over the bytes, once, subtree-wide) — e.g. Matrix's
invalid-UTF-8 → `400 M_NOT_JSON` rule, which `text()` (non-fatal U+FFFD) and
`json()` (structure-only) cannot express.

- body: expose memoized bytes() accessor (`5d6b841`)

### Fix

Thrown `HttpError`s are now visible to outcome pages: the HttpError catch branch
sets `context.error = error` before the page renders — it was the only error
branch that didn't (413 and uncaught already do) — so a subtree page reads the
thrown errcode/message instead of a fixed miss text, and `context.miss` stays
the clean miss/thrown discriminator. The error's explicit headers ride along on
the page path too: an envelope header merge with one shared rule (the same
semantics the verbatim fallback already used) — the error's headers win, the
page's own headers fill the gaps.

- http: context.error for outcome pages + envelope header merge (`2c1d256`)

### Docs

`Context.error` no longer documents as 500-only (the 413 and thrown-HttpError
branches set it too), and `HttpError.headers` documents as riding along in both
the fallback and the outcome-page path — true on both paths once the merge
lands.

- http: context.error for outcome pages + envelope header merge (`2c1d256`)

## 2026-09-11

### Breaking

`context.miss.rest` is now measured from the answering folder — everything below
the directory that answered the miss, leading slash included (a request for
`/api/v1/rooms/x/messagesNOPE` answered at `rooms/#roomId` now reports
`/messagesNOPE`, not the old deepest-walked fragment) — and `params` are the
captures along that folder's path, so the two compose. Miss handlers and outcome
pages that consume `context.miss.rest` need updating. Nothing else in the public
surface changed.

- matcher: fact entries + always-dict walk (`bd6b2c6`)
- router: dispatch from the merged dict chain (`e708b22`)

### Fix

communico's two M1 findings land in final form: no-match anchors tag directories
— a leafless directory holding only outcome/middleware files (e.g.
`_matrix/404.ts`) anchors misses — and miss dispatches honor directory
middleware body access. Both are pinned at wire level by the integration matrix.

- router: dispatch from the merged dict chain (`e708b22`)
- tests: cascade integration matrix (`06b08cc`)

### Feature

The dispatch state now comes from the walk itself: middleware and outcome files
compile into the same automaton as routes (fact entries), and every branch
carries its dict — the middleware chain to run and the closest outcome page per
status code. Directory middleware runs on every outcome — hits, misses, and
wrong-methods alike; a miss is answered by the deepest folder-with-files the
walk stood in (ties: exact over dynamic over catch-all); an endpoint's
`HttpError(status)` renders the branch's own page for that status when one
exists (verbatim body stays the no-page fallback); a catch-all directory holding
only fact files is always a reachable stopping point, so its page fires. The
post-walk directory scan is gone, and the bench proves it: fileless-miss
baselines held (~55.6k ops/s direct, the tactical slice regression gone).
SEMANTICS.md §6 is the normative spec.

- router: dispatch from the merged dict chain (`e708b22`)
- loader: compile middleware/outcome files as automaton facts (`ace809f`)
- tests: cascade integration matrix (`06b08cc`)
- bench: fact-bearing miss scenarios (`c6ef5d4`)
- docs: SEMANTICS §6 — anchors are walk facts (`183501a`)

### Docs

The JSR documentation pass: module docs with `@module` on all eight entrypoints
(the generated layer0 index gets it from the `gen index` template) and JSDoc on
every exported symbol — the JSR census over the entrypoints reports 77 symbols,
0 undocumented. Plus the release pipeline: a tag-triggered GitHub Actions
workflow publishes via JSR's native OIDC integration (no secrets; every
published version carries provenance), gated on tag/version match and the full
gate set.

- docs: module docs + full symbol docs across entrypoints (`f2f298e`)
- ci: JSR publish workflow — tag-triggered, OIDC provenance (`3ec8d62`)

## 2026-09-10

### Feature

The matcher substrate grows the always-dict walk: middleware/outcome files
compile as fact entries that never accept and never prune, per-branch dicts copy
forward with copy-on-write, dynamic groups unify into one shared parent where
facts sit, catch-all shortlists count folders-with-files as stopping points, and
the miss anchor is the deepest fact-bearing stand. Serve-level perf harness
ships alongside (wire + direct modes, scenarios isolating each hot path).

- matcher: fact entries + always-dict walk (`bd6b2c6`)
- bench: serve-level perf harness (`c2e4922`)

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

- websocket: request.upgrade() + materialize 101 in-place handling (`31f56cb`)
- middleware: ship the optional set (cors, clientIp, logger, timing, accessLog,
  compress) (`cf28bc4`)
- http: ParseError + parseJson convenience (`59b753a`)
- docs: coming-from-hono, dev notes, error-shapes teaching doc (`d96a04b`)
- namespace: re-group the public surface into subpaths (`9e9d02f`)
- http: payload-agnostic HttpError — the body is the payload (`1097291`)

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
