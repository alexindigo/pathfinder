// SPDX-License-Identifier: LGPL-3.0-only

// Matcher fact entries + always-dict walk: facts compile as non-accepting
// annotations at their directory's pattern; the walk accumulates a
// per-branch dispatch dict (copy-forward, copy-on-write); the miss answer
// comes from the deepest fact-bearing stand (hole 3). Unit tests at the
// grammar layer — the integration matrix lives in cascade_test.ts.

import { assertEquals, assertThrows } from "@std/assert";
import { CompiledMatcher } from "../src/grammar/matcher.ts";
import type { FactPayload } from "../src/grammar/matcher.ts";

const mw = (name: string): FactPayload => ({
  kind: "middleware",
  name,
  disableStreaming: false,
  reg: { name },
});
const page = (code: number): FactPayload => ({
  kind: "outcome",
  code,
  reg: { code },
});

Deno.test("facts: static dir — dict rides hits and misses alike", () => {
  const m = new CompiledMatcher([
    { pattern: "/api", fact: mw("auth") },
    { method: "GET", pattern: "/api/devices", handler: () => "list" },
  ]);
  // Hit: the accepting branch's dict carries the dir's middleware.
  const hit = m.lookup("GET", "/api/devices");
  assertEquals(hit.kind, "match");
  if (hit.kind !== "match") return;
  assertEquals(hit.dict.dir, "/api");
  assertEquals(hit.dict.chain.length, 1);
  assertEquals(hit.dict.outcomes.size, 0);
  // Miss below the folder: the stand is the folder, dict carried.
  const miss = m.lookup("GET", "/api/unknown");
  if (miss.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(miss.anchor.dict.dir, "/api");
  assertEquals(miss.anchor.params, {});
  assertEquals(miss.anchor.rest, "/unknown");
});

Deno.test("facts: hole 1 — bounded-dynamic dir unification (hit carries the dict)", () => {
  // The concilium's load-bearing hole: auth at /rooms/#roomId must chain on
  // GET /rooms/42/messages even though messages/settings are anchored
  // sibling edges. Unification merges the group.
  const m = new CompiledMatcher([
    { pattern: "/rooms/#roomId", fact: mw("10-auth") },
    { method: "GET", pattern: "/rooms/#roomId/messages", handler: () => "m" },
    { method: "GET", pattern: "/rooms/#roomId/settings", handler: () => "s" },
  ]);
  const hit = m.lookup("GET", "/rooms/42/messages");
  assertEquals(hit.kind, "match");
  if (hit.kind !== "match") return;
  assertEquals(hit.dict.dir, "/rooms/#roomId");
  assertEquals(hit.dict.chain.length, 1);
  // Same for the sibling — unification is shared, not per-branch.
  const hit2 = m.lookup("GET", "/rooms/7/settings");
  if (hit2.kind !== "match") throw new Error("wrong kind");
  assertEquals(hit2.dict.chain.length, 1);
  // A miss inside the folder anchors at the folder stand.
  const miss = m.lookup("GET", "/rooms/42/unknown");
  if (miss.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(miss.anchor.dict.dir, "/rooms/#roomId");
  assertEquals(miss.anchor.params, { roomId: "42" });
  assertEquals(miss.anchor.rest, "/unknown");
});

Deno.test("facts: typed variant validates at capture (no match, no dict)", () => {
  const m = new CompiledMatcher([
    { pattern: "/rooms/#(int)roomId", fact: mw("10-auth") },
    {
      method: "GET",
      pattern: "/rooms/#(int)roomId/messages",
      handler: () => "m",
    },
  ]);
  const miss = m.lookup("GET", "/rooms/abc/messages");
  if (miss.kind !== "no-match") throw new Error("wrong miss kind");
  // The walk never entered the folder — root stand, no facts.
  assertEquals(miss.anchor.dict.dir, "");
  assertEquals(miss.anchor.params, {});
  assertEquals(miss.anchor.rest, "/rooms/abc/messages");
});

Deno.test("facts: hole 2 — catch-all dir with files seeds the take-everything candidate", () => {
  // Fact-only catch-all (no endpoint): the walk can only enter the folder
  // if the facts seed the take-everything candidate.
  const m = new CompiledMatcher([
    { pattern: "/files/#...path", fact: page(404) },
  ]);
  // A path inside the folder: the seeded take enters the stand; the miss
  // answers from the catch-all dir's dict.
  const inner = m.lookup("GET", "/files/x/y");
  if (inner.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(inner.anchor.dict.dir, "/files/#...path");
  assertEquals(inner.anchor.dict.outcomes.get(404)?.kind, "outcome");
  assertEquals(inner.anchor.params, { path: "x/y" });
  // Exact-dir: the crossing is never taken (empty capture) — the folder is
  // out of the catch-all's scope; the root stand answers (row B3).
  const exact = m.lookup("GET", "/files");
  if (exact.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(exact.anchor.dict.dir, "");
  // With an endpoint present, the same folder answers via the branch dict.
  m.add({ method: "GET", pattern: "/files/#...path", handler: () => "dl" });
  const hit = m.lookup("GET", "/files/x/y");
  if (hit.kind !== "match") throw new Error("wrong kind");
  assertEquals(hit.dict.outcomes.get(404)?.kind, "outcome");
});

Deno.test("facts: hole 3 — the anchor is the deepest fact-bearing stand, not the deepest touch", () => {
  const m = new CompiledMatcher([
    { pattern: "/a", fact: mw("outer") },
    { method: "GET", pattern: "/a/b", handler: () => "x" },
  ]);
  // The walk dies two segments past the fact-bearing folder; the stand is
  // still /a — the deepest FOLDER-WITH-FILES, not the deepest position.
  const miss = m.lookup("GET", "/a/b/NOPE");
  if (miss.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(miss.anchor.dict.dir, "/a");
  assertEquals(miss.anchor.rest, "/b/NOPE");
  // Deeper fact-bearing stands win when the walk stands in them.
  m.add({ pattern: "/a/b/c", fact: mw("inner") });
  const deeper = m.lookup("GET", "/a/b/NOPE");
  if (deeper.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(deeper.anchor.dict.dir, "/a");
  const standIn = m.lookup("GET", "/a/b/c/NOPE");
  if (standIn.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(standIn.anchor.dict.dir, "/a/b/c");
  assertEquals(standIn.anchor.rest, "/NOPE");
});

Deno.test("facts: method-miss pockets the branch dict", () => {
  const m = new CompiledMatcher([
    { pattern: "/api", fact: page(405) },
    { method: "GET", pattern: "/api/x", handler: () => "x" },
  ]);
  const miss = m.lookup("POST", "/api/x");
  assertEquals(miss.kind, "method-miss");
  if (miss.kind !== "method-miss") return;
  assertEquals(miss.dict.dir, "/api");
  assertEquals(miss.dict.outcomes.get(405)?.kind, "outcome");
  assertEquals(miss.allowed, ["GET"]);
});

Deno.test("facts: multiple middleware names per dir coexist; kind-qualified keys", () => {
  const m = new CompiledMatcher([
    { pattern: "/x", fact: mw("10-auth") },
    { pattern: "/x", fact: mw("20-log") },
    { pattern: "/x", fact: page(404) },
    { method: "GET", pattern: "/x/y", handler: () => "y" },
  ]);
  const hit = m.lookup("GET", "/x/y");
  if (hit.kind !== "match") throw new Error("wrong kind");
  assertEquals(hit.dict.chain.length, 2);
  assertEquals(hit.dict.outcomes.size, 1);
  // Same-shape endpoint does not collide with the fact.
  const miss = m.lookup("GET", "/x");
  if (miss.kind !== "no-match") throw new Error("wrong miss kind");
  assertEquals(miss.anchor.dict.chain.length, 2);
  // Duplicate fact (same kind+identity+dir) refuses.
  assertThrows(
    () => m.add({ pattern: "/x", fact: mw("10-auth") }),
    Error,
    "Duplicate fact entry",
  );
});

Deno.test("facts: insertion order independence — route after fact, fact after route", () => {
  // Route first, fact second: unification demotes the route's anchor.
  const a = new CompiledMatcher([
    { method: "GET", pattern: "/rooms/#roomId/messages", handler: () => "m" },
  ]);
  a.add({ pattern: "/rooms/#roomId", fact: mw("10-auth") });
  const hitA = a.lookup("GET", "/rooms/1/messages");
  if (hitA.kind !== "match") throw new Error("wrong kind");
  assertEquals(hitA.dict.chain.length, 1);
  // Fact first, route second: the route demotes its own anchor.
  const b = new CompiledMatcher([
    { pattern: "/rooms/#roomId", fact: mw("10-auth") },
  ]);
  b.add({
    method: "GET",
    pattern: "/rooms/#roomId/messages",
    handler: () => "m",
  });
  const hitB = b.lookup("GET", "/rooms/1/messages");
  if (hitB.kind !== "match") throw new Error("wrong kind");
  assertEquals(hitB.dict.chain.length, 1);
});

Deno.test("facts: unification preserves accept/reject for the route set", () => {
  const plain = new CompiledMatcher([
    {
      method: "GET",
      pattern: "/api/v1/rooms/#roomId/messages",
      handler: () => "m",
    },
    {
      method: "GET",
      pattern: "/api/v1/rooms/#roomId/settings",
      handler: () => "s",
    },
  ]);
  const withFact = new CompiledMatcher([
    { pattern: "/api/v1/rooms/#roomId", fact: mw("10-auth") },
    {
      method: "GET",
      pattern: "/api/v1/rooms/#roomId/messages",
      handler: () => "m",
    },
    {
      method: "GET",
      pattern: "/api/v1/rooms/#roomId/settings",
      handler: () => "s",
    },
  ]);
  const cases: [string, string][] = [
    ["GET", "/api/v1/rooms/42/messages"],
    ["GET", "/api/v1/rooms/42/settings"],
    ["GET", "/api/v1/rooms/42/unknown"],
    ["GET", "/api/v1/rooms//messages"],
    ["GET", "/api/v1/rooms/42/messagesNOPE"],
    ["POST", "/api/v1/rooms/42/messages"],
    ["GET", "/api/v1/rooms/42/messages/extra"],
  ];
  for (const [method, path] of cases) {
    const a = plain.lookup(method, path);
    const b = withFact.lookup(method, path);
    assertEquals(b.kind, a.kind, `${method} ${path}`);
    if (a.kind === "match" && b.kind === "match") {
      assertEquals(b.params, a.params, `${method} ${path}`);
    }
    if (a.kind === "no-match" && b.kind === "no-match") {
      // Captures along the branch may differ only at the unified edge's
      // accepted capture boundary — the plan's equivalence claim is for
      // accept/reject and surviving captures.
      assertEquals(a.anchor.rest.startsWith("/"), true);
    }
  }
});
