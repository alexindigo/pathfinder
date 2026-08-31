// SPDX-License-Identifier: LGPL-3.0-only

// Ported from the spike's grammar_test.ts: SM/RE cross-checks dropped (they
// live in the spike benchmark lab); pinned expected-values kept verbatim —
// the ratified matrix is the semantics contract. Registry-v2 coercion pins
// (ledger §4; num format ruling 2026-08-31) extend the ported set.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { type Chunk, parsePattern, routeShapeKey } from "../src/grammar.ts";
import { CompiledMatcher } from "../src/matcher.ts";
import grammar2Routes from "./fixtures/routes/grammar2.ts";
import edgecasesRoutes from "./fixtures/routes/edgecases.ts";
import adversarialRoutes from "./fixtures/routes/adversarial.ts";
import { sharedHandler } from "./fixtures/handlers.ts";
import { midFamilyPath } from "./fixtures/paths/edgecases.ts";

function dyn(
  name: string,
  opts: { type?: string; rest?: boolean; crossing?: boolean } = {},
): Chunk {
  return {
    kind: "dynamic",
    name,
    type: opts.type ?? "string",
    rest: opts.rest ?? false,
    crossing: opts.crossing ?? false,
  };
}

function static_(text: string): Chunk {
  return { kind: "static", text };
}

Deno.test("grammar v2 — pure static pattern", () => {
  assertEquals(parsePattern("/_matrix/client/v3/login"), [
    static_("/_matrix/client/v3/login"),
  ]);
});

Deno.test("grammar v2 — dynamic then dot anchor", () => {
  assertEquals(parsePattern("/files/#name.json"), [
    static_("/files/"),
    dyn("name"),
    static_(".json"),
  ]);
});

Deno.test("grammar v2 — stop signal before identifier-char anchor", () => {
  assertEquals(parsePattern("/v/#version#osx"), [
    static_("/v/"),
    dyn("version"),
    static_("osx"),
  ]);
});

Deno.test("grammar v2 — stop signal before underscore anchor", () => {
  assertEquals(parsePattern("/dl/#file_version#_x86"), [
    static_("/dl/"),
    dyn("file_version"),
    static_("_x86"),
  ]);
});

Deno.test("grammar v2 — typed dynamic + stop signal", () => {
  assertEquals(parsePattern("/build/#(int)build#_x86"), [
    static_("/build/"),
    dyn("build", { type: "int" }),
    static_("_x86"),
  ]);
});

Deno.test("grammar v2 — stop signal before literal paren anchor", () => {
  assertEquals(parsePattern("/x/#a#(v2)"), [
    static_("/x/"),
    dyn("a"),
    static_("(v2)"),
  ]);
});

Deno.test("grammar v2 — cast-style type annotation", () => {
  assertEquals(parsePattern("/api/#(int)version"), [
    static_("/api/"),
    dyn("version", { type: "int" }),
  ]);
});

Deno.test("grammar v2 — dash is ordinary anchor text", () => {
  assertEquals(parsePattern("/x/#a-#b"), [
    static_("/x/"),
    dyn("a"),
    static_("-"),
    dyn("b"),
  ]);
});

Deno.test("grammar v2 — single # after name is a stop, then static", () => {
  assertEquals(parsePattern("/x/#a#b"), [
    static_("/x/"),
    dyn("a"),
    static_("b"),
  ]);
});

Deno.test("grammar v2 — stop then dash-separated dynamic", () => {
  assertEquals(parsePattern("/x/#a#-#b"), [
    static_("/x/"),
    dyn("a"),
    static_("-"),
    dyn("b"),
  ]);
});

Deno.test("grammar v2 — trailing stop signal consumed", () => {
  assertEquals(parsePattern("/x/#a#"), [static_("/x/"), dyn("a")]);
});

Deno.test("grammar v2 — $ and _ are legal name characters", () => {
  assertEquals(parsePattern("/#_private/#$dollar/#a_b"), [
    static_("/"),
    dyn("_private"),
    static_("/"),
    dyn("$dollar"),
    static_("/"),
    dyn("a_b"),
  ]);
});

Deno.test("grammar v2 — bounded rest in compound segment", () => {
  assertEquals(parsePattern("/archive/#year-#...slug/get"), [
    static_("/archive/"),
    dyn("year"),
    static_("-"),
    dyn("slug", { rest: true, crossing: false }),
    static_("/get"),
  ]);
});

Deno.test("grammar v2 — crossing rests at full inter-slash spans", () => {
  assertEquals(parsePattern("/#...a/mid/#...b/get"), [
    static_("/"),
    dyn("a", { rest: true, crossing: true }),
    static_("/mid/"),
    dyn("b", { rest: true, crossing: true }),
    static_("/get"),
  ]);
  assertEquals(parsePattern("/static/#...path"), [
    static_("/static/"),
    dyn("path", { rest: true, crossing: true }),
  ]);
  assertEquals(parsePattern("/api/#(int)version/#name/#...rest"), [
    static_("/api/"),
    dyn("version", { type: "int" }),
    static_("/"),
    dyn("name"),
    static_("/"),
    dyn("rest", { rest: true, crossing: true }),
  ]);
});

Deno.test("grammar v2 — rest not at a span boundary stays bounded", () => {
  assertEquals(parsePattern("/proxy/#...path/get"), [
    static_("/proxy/"),
    dyn("path", { rest: true, crossing: true }),
    static_("/get"),
  ]);
  assertEquals(parsePattern("/x#...a"), [
    static_("/x"),
    dyn("a", { rest: true, crossing: false }),
  ]);
});

Deno.test("grammar v2 — explicit string type is legal and redundant", () => {
  assertEquals(parsePattern("/#(string)a/x/#(string)a"), [
    static_("/"),
    dyn("a", { type: "string" }),
    static_("/x/"),
    dyn("a", { type: "string" }),
  ]);
  assertEquals(parsePattern("/#a/x/#(string)a"), [
    static_("/"),
    dyn("a"),
    static_("/x/"),
    dyn("a", { type: "string" }),
  ]);
});

Deno.test("grammar v2 — repeated same type is legal and redundant", () => {
  assertEquals(parsePattern("/#(int)a/x/#(int)a"), [
    static_("/"),
    dyn("a", { type: "int" }),
    static_("/x/"),
    dyn("a", { type: "int" }),
  ]);
});

Deno.test("grammar v2 build errors — unknown type", () => {
  assertThrows(() => parsePattern("/#(foo)x"), Error, `Unknown type "foo"`);
});

Deno.test("grammar v2 build errors — name not a legal identifier", () => {
  assertThrows(
    () => parsePattern("/#4x"),
    Error,
    `Invalid parameter name "4x"`,
  );
  assertThrows(() => parsePattern("/#"), Error, `Invalid parameter name ""`);
  assertThrows(
    () => parsePattern("/#(int)"),
    Error,
    `Invalid parameter name ""`,
  );
  assertThrows(() => parsePattern("/#..."), Error, `Invalid parameter name ""`);
  assertThrows(() => parsePattern("/#..a"), Error, `Invalid parameter name ""`);
});

Deno.test("grammar v2 build errors — empty anchor between two dynamics", () => {
  assertThrows(
    () => parsePattern("/#a##b"),
    Error,
    "Empty anchor between two dynamics",
  );
  assertThrows(
    () => parsePattern("/#a##...b"),
    Error,
    "Empty anchor between two dynamics",
  );
});

Deno.test("grammar v2 build errors — (type) on a rest", () => {
  assertThrows(
    () => parsePattern("/#(int)...a"),
    Error,
    "(type) annotation on a rest dynamic",
  );
  assertThrows(
    () => parsePattern("/#(string)...a"),
    Error,
    "(type) annotation on a rest dynamic",
  );
});

Deno.test("grammar v2 build errors — reserved paren after a name", () => {
  assertThrows(
    () => parsePattern("/#var_name(param1, param2)"),
    Error,
    "reserved for future parameterized syntax",
  );
  assertThrows(
    () => parsePattern("/#...a(b)"),
    Error,
    "reserved for future parameterized syntax",
  );
});

Deno.test("grammar v2 build errors — conflicting type re-annotation", () => {
  assertThrows(
    () => parsePattern("/#(int)a/x/#(string)a"),
    Error,
    `Conflicting type re-annotation for "a"`,
  );
  assertThrows(
    () => parsePattern("/#a/x/#(int)a"),
    Error,
    `Conflicting type re-annotation for "a"`,
  );
});

Deno.test("grammar v2 build errors — unclosed type annotation", () => {
  assertThrows(
    () => parsePattern("/#(inta"),
    Error,
    `Unclosed "(" type annotation`,
  );
  assertThrows(() => parsePattern("/#()a"), Error, `Unknown type ""`);
});

Deno.test("grammar v2 — route shape key normalization", () => {
  assertEquals(
    routeShapeKey("/_matrix/client/v3/login"),
    "/_matrix/client/v3/login",
  );
  assertEquals(
    routeShapeKey("/api/v1/rooms/#roomId/messages"),
    "/api/v1/rooms/#/messages",
  );
  assertEquals(
    routeShapeKey("/api/#(int)a/#(int)b/get"),
    "/api/#(int)/#(int)/get",
  );
  assertEquals(routeShapeKey("/#...a/mid/#...b/get"), "/#.../mid/#.../get");
  assertEquals(
    routeShapeKey("/archive/#year-#...slug/get"),
    "/archive/#-#.../get",
  );
  // Same shape, different names → same key (duplicate detection).
  assertEquals(routeShapeKey("/x/#a"), routeShapeKey("/x/#b"));
  // Different shapes → different keys.
  assert(routeShapeKey("/x/#(int)a") !== routeShapeKey("/x/#a"));
  assert(routeShapeKey("/x/#a") !== routeShapeKey("/x/#...a"));
});

// --- New-capability matching -------------------------------------------------
//
// Expected values per SEMANTICS.md; the compiled matcher is the product.

const compiledG2 = new CompiledMatcher(grammar2Routes);

function expectMatch(
  url: string,
  expected: Record<string, unknown>,
  method = "GET",
): void {
  assertEquals(
    compiledG2.handle(method, url),
    expected,
    `compiled: ${method} ${url}`,
  );
}

function expectNoMatch(url: string, method = "GET"): void {
  assertEquals(
    compiledG2.handle(method, url),
    null,
    `compiled: ${method} ${url}`,
  );
}

Deno.test("showcase: stop signal — /build/#version#osx", () => {
  expectMatch("/build/1.2.3osx", { version: "1.2.3" });
  // First occurrence of the anchor wins, then hard-commit:
  // capture "a.b", anchor "osx", leftover "c" → no match.
  expectNoMatch("/build/a.bosxc");
  expectNoMatch("/build/a.bosxc/ignore");
  expectNoMatch("/build/osx");
  expectNoMatch("/build/1.2.3osxextra");
  expectMatch("/build/1.2.3osx/", { version: "1.2.3" });
  expectNoMatch("/build/1.2.3osx", "POST");
});

Deno.test("showcase: dot anchor — /files/#name.json", () => {
  expectMatch("/files/a.b.json", { name: "a.b" });
  expectMatch("/files/report.pdf.json", { name: "report.pdf" });
  expectNoMatch("/files/.json");
  expectNoMatch("/files/a.txt");
  // First ".json" wins; the tail is leftover → no match.
  expectNoMatch("/files/a.json.json");
  // Duplicate internal slashes do NOT match (raw-stream model).
  expectNoMatch("/files//a.json");
});

Deno.test("showcase: typed + stop — /pkg/#(int)build#_x86", () => {
  // Registry v2: (int) coerces to bigint (validate RAW → decode → parse).
  expectMatch("/pkg/42_x86", { build: 42n });
  expectNoMatch("/pkg/x_x86");
  expectNoMatch("/pkg/42_x64");
  expectNoMatch("/pkg/_x86");
  // First "_x86" occurrence yields capture "4_2", which fails the int
  // validator; hard-commit means no retry → no match.
  expectNoMatch("/pkg/4_2_x86");
  expectNoMatch("/pkg/42_x86x");
});

Deno.test("showcase: repeated-name equality — /mirror/#src/into/#src", () => {
  expectMatch("/mirror/abc/into/abc", { src: "abc" });
  // Equality constraint: raw-byte literal insertion.
  expectNoMatch("/mirror/abc/into/xyz");
  expectNoMatch("/mirror/abc/into/ab");
  expectMatch("/mirror/abc/into/abc/", { src: "abc" });
  // Raw-byte comparison at match time; decoded value to the handler.
  expectMatch("/mirror/a%2Db/into/a%2Db", { src: "a-b" });
});

Deno.test("showcase: decode model — malformed % throws only when captured", () => {
  // Captured payload → decodeURIComponent throws at leaf acceptance.
  assertThrows(() => compiledG2.handle("GET", "/files/%ZZ.json"), URIError);
  // Malformed escape in an unrelated position → no match, no throw.
  expectNoMatch("/files/a.json/%ZZ");
});

// --- Registry v2 — coercion pins (ledger §4; num ruling 2026-08-31) ----------

const typedMatcher = new CompiledMatcher([
  { method: "GET", pattern: "/num/#(num)n", handler: sharedHandler },
  { method: "GET", pattern: "/int/#(int)n", handler: sharedHandler },
  { method: "GET", pattern: "/both/#(num)a-#(int)b", handler: sharedHandler },
]);

Deno.test("registry v2 — num coercion (plain decimal, double semantics)", () => {
  assertEquals(typedMatcher.handle("GET", "/num/42"), { n: 42 });
  assertEquals(typedMatcher.handle("GET", "/num/-3.14"), { n: -3.14 });
  assertEquals(typedMatcher.handle("GET", "/num/0.5"), { n: 0.5 });
  // Plain decimal only: no exponent, no hex, no bare-fraction forms.
  assertEquals(typedMatcher.handle("GET", "/num/1e5"), null);
  assertEquals(typedMatcher.handle("GET", "/num/0x1f"), null);
  assertEquals(typedMatcher.handle("GET", "/num/.5"), null);
  assertEquals(typedMatcher.handle("GET", "/num/5."), null);
  assertEquals(typedMatcher.handle("GET", "/num/Infinity"), null);
  assertEquals(typedMatcher.handle("GET", "/num/NaN"), null);
});

Deno.test("registry v2 — int coercion (raw validation, bigint parse)", () => {
  assertEquals(
    typedMatcher.handle("GET", "/int/123456789012345678901234567890"),
    {
      n: 123456789012345678901234567890n,
    },
  );
  assertEquals(typedMatcher.handle("GET", "/int/-7"), { n: -7n });
  // D6: typed validators run on the RAW capture — %2D escapes fail.
  assertEquals(typedMatcher.handle("GET", "/int/%2D123"), null);
});

Deno.test("registry v2 — mixed typed captures in one segment", () => {
  assertEquals(typedMatcher.handle("GET", "/both/2.5-100"), {
    a: 2.5,
    b: 100n,
  });
});

// --- Edge-case corpus --------------------------------------------------------
//
// Deterministic anchor-stress cases. Model divergences are registered in the
// spike's RFC.md (SEMANTICS.md source).

const compiledEdge = new CompiledMatcher(edgecasesRoutes);

function expectEdgeMatch(url: string, expected: Record<string, unknown>): void {
  assertEquals(compiledEdge.handle("GET", url), expected, `compiled: ${url}`);
}

function expectEdgeNoMatch(url: string): void {
  assertEquals(compiledEdge.handle("GET", url), null, `compiled: ${url}`);
}

Deno.test("edge: many continuation occurrences — /mm/#...a/mid/#...b/get", () => {
  // Greedy split at the LAST viable /mid/ (crossing longest-match rule).
  for (const k of [2, 8, 32]) {
    const groups = Array.from({ length: k + 1 }, (_, i) => "v" + i);
    expectEdgeMatch(midFamilyPath(k), {
      a: groups.slice(0, k).join("/mid/"),
      b: groups[k],
    });
  }
});

Deno.test("edge: nested crossing misses — k-occurrence + /extra", () => {
  for (const k of [2, 8, 32]) expectEdgeNoMatch(midFamilyPath(k, "/extra"));
});

Deno.test("edge: near-miss multi-char anchor — /vx/#ver#-osx/dl", () => {
  expectEdgeMatch("/vx/v1-os--osx/dl", { ver: "v1-os-" });
  // First full `-osx/dl` occurrence missing → reject (hard-commit at the
  // first `-osx`).
  expectEdgeNoMatch("/vx/v1-osx-os/dl");
  // Chunk-spanning anchor: compiled anchors on the whole chunk `-osx/dl` and
  // matches (RFC.md D1 — compiled-pinned).
  expectEdgeMatch("/vx/v1-osx-osx/dl", { ver: "v1-osx" });
});

Deno.test("edge: anchor text inside value — /nm/#a.#b", () => {
  // First-`.` split.
  expectEdgeMatch("/nm/a.b.c", { a: "a", b: "b.c" });
  expectEdgeMatch("/nm/x.y.z.w", { a: "x", b: "y.z.w" });
  expectEdgeNoMatch("/nm/.y");
  expectEdgeNoMatch("/nm/x.");
  expectEdgeNoMatch("/nm/ab");
});

Deno.test("edge: anchor at window edge — /we/#a-end/tail", () => {
  expectEdgeMatch("/we/abc-end/tail", { a: "abc" });
  // `-end` ends exactly at the `/` boundary.
  expectEdgeMatch("/we/x-end/tail", { a: "x" });
  // Empty capture → reject.
  expectEdgeNoMatch("/we/-end/tail");
});

Deno.test("edge: bound-ref with anchor-lookalike value — /eq/#s/into/#s", () => {
  // First `s` captures the literal text `into`; equality still by raw-byte
  // literal insertion.
  expectEdgeMatch("/eq/into/into/into", { s: "into" });
  expectEdgeMatch("/eq/xinto/into/xinto", { s: "xinto" });
  expectEdgeNoMatch("/eq/abc/into/xyz");
  expectEdgeNoMatch("/eq/abc/into");
});

Deno.test("edge: crossing at end + trailing slash — /tr/#...p", () => {
  expectEdgeMatch("/tr/a/b", { p: "a/b" });
  expectEdgeMatch("/tr/x", { p: "x" });
  // Rulings (RFC.md D2/D10): slashes are ordinary payload bytes inside a
  // crossing capture — a crossing rest takes the raw remainder
  // byte-for-byte.
  expectEdgeMatch("/tr/a/b/", { p: "a/b/" });
  expectEdgeMatch("/tr/a//b", { p: "a//b" });
  expectEdgeMatch("/tr//", { p: "/" });
  expectEdgeMatch("/tr/a/b//", { p: "a/b//" });
  // Empty rest: no payload at all → reject.
  expectEdgeNoMatch("/tr/");
});

Deno.test("edge: URL fallback preserves empty segments and trailing slashes", () => {
  // The dot segment forces compiled off the fast path into `new URL(...)`;
  // WHATWG URL parsing must preserve the `//` and the capture stays raw
  // payload.
  expectEdgeMatch("/tr/./a//b", { p: "a//b" });
  expectEdgeMatch("/we/./x-end/tail/", { a: "x" });
});

Deno.test("edge: // outside a crossing span rejects structurally", () => {
  // Bounded window at the second `/` is empty → structural reject
  // (rest-slash-semantics plan §1).
  const inline = [
    { method: "GET", pattern: "/x/#a-#b", handler: sharedHandler },
    {
      method: "GET",
      pattern: "/api/v1/rooms/#roomId/messages",
      handler: sharedHandler,
    },
    { method: "GET", pattern: "/api/v1/status", handler: sharedHandler },
  ];
  const compiled = new CompiledMatcher(inline);
  assertEquals(compiled.handle("GET", "/x/a//b-c"), null);
  // Trailing-slash tolerance is exactly one slash — `//` tail rejects.
  assertEquals(compiled.handle("GET", "/api/v1/rooms/X/messages//"), null);
  assertEquals(compiled.handle("GET", "/api/v1/status//"), null);
  // And exactly one trailing slash IS tolerated at leaf acceptance.
  assertEquals(compiled.handle("GET", "/api/v1/status/"), {});
});

// --- Ratified matrix ---------------------------------------------------------
//
// The user's ruling table (2026-08-28), encoded as a contract test: each row
// asserts the compiled matcher's decision and captures exactly. If any future
// change flips a ratified row, this block names it. See SEMANTICS.md (spike
// RFC.md) for the register.

const ratifiedMatcher = new CompiledMatcher([
  ...grammar2Routes,
  ...edgecasesRoutes,
  ...adversarialRoutes,
  { method: "GET", pattern: "/x/#a-#b", handler: sharedHandler },
]);

Deno.test("ratified matrix — user rulings 2026-08-28", () => {
  const rows: [label: string, url: string, expected: unknown][] = [
    // D1 — anchor after a dynamic spans a slash (chunk model).
    ["D1 span anchor", "/vx/v1-osx-osx/dl", { ver: "v1-osx" }],
    ["D1 agreement", "/vx/v1-os--osx/dl", { ver: "v1-os-" }],
    ["D1 near-miss reject", "/vx/v1-osx-os/dl", null],
    // D2 — slashes are payload inside a crossing capture (D4 merged).
    ["D2 // payload", "/tr/a//b", { p: "a//b" }],
    ["D2 bare //", "/tr//", { p: "/" }],
    // D3 — trailing garbage after the last literal rejects.
    ["D3 trailing garbage", "/build/1.2.3osxextra", null],
    // D5 — decode at leaf; %2D stays inside a payload.
    ["D5 %2D payload", "/x/p%2Dq-r", { a: "p-q", b: "r" }],
    ["D5 malformed %, uncaptured", "/files/a.json/%ZZ", null],
    // D6 — typed validators run on the raw capture (locked 2026-08-28).
    ["D6 raw int validation", "/api/%2D123/x", null],
    // D7 — bound-ref equality is raw-byte.
    ["D7 raw-byte equality", "/mirror/a%2Db/into/a%2Db", { src: "a-b" }],
    ["D7 raw-byte mismatch", "/mirror/a%2Db/into/a-b", null],
    // D8 — dot segments normalize via the URL fallback.
    ["D8 dot segment", "/we/./x-end/tail", { a: "x" }],
    // D10 — trailing slash on a crossing-terminal route is captured.
    ["D10 trailing slash in rest", "/tr/a/b/", { p: "a/b/" }],
  ];
  for (const [label, url, expected] of rows) {
    assertEquals(
      ratifiedMatcher.handle("GET", url),
      expected,
      `${label}: ${url}`,
    );
  }
});
