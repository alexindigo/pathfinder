# Pathfinder semantics — the `#` pattern grammar and matching model

Status: **spec**. Once `@pathfinder/pathfinder@0.1.0` ships, this document is
normative: breaking changes to anything specified here cost a major version.
Forward-compatible valves (reserved syntax that is an error today) are marked
**reserved**. The historical record of how each ruling was made — including the
divergence register from the three-matcher benchmark lab — is internal: this
document is the public surface for the rulings themselves, and the published
dashboard and bench snapshot are the public surface for the lab's products. Only
the lab can regenerate three-way comparisons.

## 1. The pattern grammar (v2)

A route pattern is a sequence of **chunks**: static anchors and dynamic
captures. `/` is never structural — it appears inside static text (which may
therefore span several URL segments) and is the one character a bounded dynamic
refuses to contain.

```
name    := [$_A-Za-z][$_A-Za-z0-9]*        (ASCII; legal JS identifier)
dynamic := "#" [ "#" ] [ "(" type ")" ] ["..."] name [ "#" ]
type    := registry lookup
```

- A dynamic's name ends at the first non-identifier character, or at an explicit
  `#` **stop signal** (consumed; belongs to no chunk). The stop is only needed
  when the following anchor starts with an identifier character or `(` — e.g.
  `/v/#version#osx`, `/dl/#file_version#_x86`.
- A second `#` immediately after the opener marks the capture **empty-ok**
  (`##name`, `##(int)n`): the bounded window may be zero length **because the
  path is finished there** (or only the leaf's one tolerated trailing `/`
  remains) — never because the next byte is `/`. The param is then **absent**
  from the capture set (not `""`); types never see an empty take —
  `validate`/`parse` run only on a non-empty take, so `##(int)n` means absent
  or a valid int. Empty-ok is terminal-only in practice: with a following
  anchor the path is not finished, so the zero-length take never fires. The
  marker sits only in the slot before type/name — after a name, `#` stays the
  stop signal.
- A `(` directly after a dynamic's name is **reserved** for future parameterized
  syntax and is a build-time error today. A literal paren anchor after a param
  is written with the stop signal: `#a#(v2)`.
- `#...name` marks a **rest**. A rest is **crossing** iff it occupies a full
  inter-slash span (adjacent anchors end with `/` on the left and start with `/`
  on the right, or pattern boundary). Otherwise it is a bounded dynamic.
  Non-rest dynamics are never crossing.
- Repeating a name in one pattern imposes an equality constraint (§5).
  Re-annotating a name with a different type is a build error. Repeating an
  **empty-ok** name is a build error (the capture may be absent — nothing to
  bind to).

### Types (registry v2)

| Annotation        | TS type  | Validation (on the RAW capture)                                                       | Parse                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| none / `(string)` | `string` | — (implicit default)                                                                  | passthrough                                                               |
| `(num)`           | `number` | plain decimal literal: `/^-?\d+(\.\d+)?$/` — no exponent, no hex, no `Infinity`/`NaN` | `Number()` (double semantics)                                             |
| `(int)`           | `bigint` | `/^-?\d+$/`                                                                           | `BigInt()` — arbitrary precision; big ids (snowflake etc.) never truncate |

Footnote: `bigint` is not JSON-serializable; converting typed params for output
is the handler's job.

Custom types register at construction —
`pathfinder({ types: { uuid: { validate,
parse } } })` — and are immutable after
boot. The built-ins above are examples of the same mechanism.

### Build-time errors

Unclosed type annotation · unknown type · invalid parameter name · empty anchor
between two dynamics (e.g. `#a##b`) · `(type)` on a rest · `##` on a rest (a
rest is already a non-empty take) · conflicting type re-annotation · repeating
an empty-ok name · `(` after a name (reserved). Patterns are validated at
registration; nothing at runtime.

## 2. Matching model

All routes compile into a **radix automaton** walked over the raw request path.
Dispatch is O(path length), independent of route count. Static edges carry
byte-string labels (radix-compressed, may span `/`); bounded-dynamic edges carry
their next-anchor text and a type validator compiled at build; one crossing edge
per node. Edge priority per node: static > bound-ref > typed bounded > untyped
bounded > crossing; ties resolve by insertion order. A small explicit stack
backtracks over grammar choices — never over characters within a committed
capture.

- **Bounded dynamics** capture within a single no-slash window. With an anchor,
  the capture ends at the first position where the entire next anchor matches,
  then hard-commits — no retry at a later occurrence. An empty capture fails —
  unless the edge is **empty-ok** (`##name`): then the zero-length take is legal
  exactly when the path is finished there (or only the leaf's one tolerated
  trailing `/` remains), the child is pushed with **no** capture, and the param
  is absent from `params`. Empty because the next byte is `/` still fails (the
  wall): `/ping##ext` matches `/ping` (no `ext`) and `/ping.view`
  (`ext = ".view"`), never `/ping/view`. A required sibling and an empty-ok one
  are distinct edges; a route and its empty-ok terminal form answering the same
  path (`ping/get.ts` + `ping##ext/get.ts` → `GET /ping`) is a duplicate-route
  build error.
- **Crossing rests take the raw remainder byte-for-byte.** Slashes are ordinary
  payload bytes inside a crossing capture: `/tr/#...p` matches `/tr/a//b` with
  `p = "a//b"`, `/tr//` with `p = "/"`, and `/tr/a/b/` with `p = "a/b/"`.
  Greedy-longest first, then candidates descending.
- **Trailing-slash tolerance** is exactly one `/`, at leaf acceptance, on
  non-crossing routes — tolerated, not captured: `/api/v1/status/` matches with
  no params; a `//` tail rejects.
- **Outside crossing spans, `//` rejects structurally** (an empty bounded window
  or a failed static match) — never via a global check.
- **Dot-segment normalization**: the fast path walks the raw string; any path
  that could contain `.` segments (including trailing `/.`, `/..`) falls back to
  URL parsing, which normalizes them.

### Linearity

Matching is a linear walk: no regex backtracking, no ReDoS surface, flat
per-match cost as route counts grow (see [docs/dashboard.html](./dashboard.html)
for the numbers).

## 3. Decode model

Captured values decode at **leaf acceptance** — never segments up front:

- A malformed `%` escape **throws** only when it sits in a captured position
  (`/files/%ZZ.json` vs `/files/#name.json` throws; the same escape in an
  uncaptured position simply does not match).
- `%2D` and friends stay inside a payload: `/x/p%2Dq-r` vs `/x/#a-#b` gives
  `a = "p-q"`, `b = "r"` — matching operates on raw bytes, decode happens once,
  at the end.

## 4. Typed validation input

Type validators run on the **raw** capture, before decoding. Pipeline per
capture: **validate RAW → decode → parse**. A `(int)` position never accepts a
`%`-escaped digit string, because `%2D123` fails the raw validation before
decoding is attempted.

## 5. Bound-ref equality

A repeated name in one pattern is an equality constraint compared on **raw
bytes** at match time — literal insertion of the first capture's raw value:

- `/mirror/#src/into/#src` matches `/mirror/a%2Db/into/a%2Db` (both raw captures
  are the bytes `a%2Db`) with `src = "a-b"` — the decoded value.
- `/mirror/a%2Db/into/a-b` rejects: the raw bytes differ.

## 6. Lookup

`lookup(method, path)` — public on the app — returns a discriminated result:

```ts
{ kind: "match", params, handler, data, dict }
{ kind: "method-miss", allowed, params, data, dict }
{ kind: "no-match", anchor: { dict, params, rest } }
```

The first structurally-accepting leaf reached without the request method is the
method-miss candidate (a lower-priority route may still match). Every recognized
file compiles an automaton entry: method files as endpoints, middleware/outcome
files as **fact entries** at their directory's pattern — never accepting, never
pruning route candidates. The walk **always** accumulates a per-branch dispatch
dict (the middleware chain and the deepest-seen outcome page per code),
copy-forward with copy-on-write; there is no rollback and no post-walk
resolution.

The miss answer comes from the walk itself: the **deepest fact-bearing stand** —
the deepest folder-with-files the walk stood in (ties broken by the walk's
priority order). Its dict is the dispatch state; its `params` are the captures
along the folder's path; `rest` is everything below the folder (leading slash
included). A miss with no folder-with-files anywhere answers at the root stand
(params `{}`, `rest` = the full path). Middleware runs first and handlers (page
or outcome) second — on hits, misses, and wrong-methods alike.

## 7. Stability

Everything above is terminal once 0.1.0 ships. Additive valves, reserved today:
`#name(args…)` parameterized dynamics, the open type registry (additive growth),
and the open method set (RFC 9110 tokens — no whitelist, ever).
