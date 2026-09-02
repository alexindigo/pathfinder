# Changelog

## 2026-09-01

### Feature

Registry installs now carry the full framework surface: Layer 0 ships as a
generated index module that statically imports the packaged tree, so
`deno install` materializes every default outcome page and the `/_status`
subtree into the import-graph cache — identical behavior on checkouts and
JSR installs, offline thereafter, with no protocol gate or degraded mode.
The same mechanism is public for framework authors: `gen index <dir>` emits
a sibling tree index, and `pathfinder({ roots })` accepts imported index
modules alongside filesystem roots (`https:` string roots are refused
loudly). Both `layer0.ts` and user indexes are drift-gated via
`gen index --check`.

- gen: index subcommand — emit sibling tree index (`afefad9`)
- layer0: index-primary via generated layer0.ts (`61175bc`)

## 2026-08-31

### Feature

Initial public release. The compiled `#`-grammar automaton (ported from the
benchmark lab, registry v2 with `(num)`/`(int)→bigint` coercion), the
framework layer (return-value middleware, views, context containers, return
contract), the filesystem loader with ordered roots + tombstones +
`PATHFINDER_USER_ENDPOINTS` always-on, the `pathfinder()` factory with
manifest/`/_status` ops face and loopback guard, typed-params codegen, and
the `context._manifest()` accessor. First published as
`@pathfinder/pathfinder@0.1.0` on JSR.

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
