// SPDX-License-Identifier: LGPL-3.0-only

import type { Route } from "../../../src/matcher.ts";
import { sharedHandler } from "../handlers.ts";

// Deterministic anchor-stress routes. Expected values are pinned in
// grammar_test.ts; model divergences are registered in docs/SEMANTICS.md.
const routes: Route[] = [
  // Many continuation occurrences / nested crossing misses (cases 1–2).
  { method: "GET", pattern: "/mm/#...a/mid/#...b/get", handler: sharedHandler },
  // Near-miss multi-char anchor (case 3). The post-dynamic static spans a
  // slash — the compiled matcher anchors on the whole chunk `-osx/dl`
  // (RFC.md D1).
  { method: "GET", pattern: "/vx/#ver#-osx/dl", handler: sharedHandler },
  // Anchor text inside value (case 4).
  { method: "GET", pattern: "/nm/#a.#b", handler: sharedHandler },
  // Anchor at window edge (case 5).
  { method: "GET", pattern: "/we/#a-end/tail", handler: sharedHandler },
  // Bound-ref with anchor-lookalike value (case 6).
  { method: "GET", pattern: "/eq/#s/into/#s", handler: sharedHandler },
  // Crossing at end + trailing slash (case 7).
  { method: "GET", pattern: "/tr/#...p", handler: sharedHandler },
];

export default routes;
