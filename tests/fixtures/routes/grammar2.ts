// SPDX-License-Identifier: LGPL-3.0-only

import type { Route } from "../../../src/matcher.ts";
import { sharedHandler } from "../handlers.ts";

// Grammar-v2 showcase routes: the four new-capability shapes. Authority for
// their matching semantics is SEMANTICS.md; expected values are asserted
// explicitly in grammar_test.ts.
const routes: Route[] = [
  // Stop signal: without `#` the name would swallow the following anchor.
  { method: "GET", pattern: "/build/#version#osx", handler: sharedHandler },
  // Dot anchor: multi-char anchor text after a dynamic.
  { method: "GET", pattern: "/files/#name.json", handler: sharedHandler },
  // Typed + stop: cast-style type annotation with a stop signal.
  { method: "GET", pattern: "/pkg/#(int)build#_x86", handler: sharedHandler },
  // Repeated-name equality constraint (bound-ref, raw-byte literal insertion).
  { method: "GET", pattern: "/mirror/#src/into/#src", handler: sharedHandler },
];

export default routes;
