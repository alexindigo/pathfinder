// SPDX-License-Identifier: LGPL-3.0-only

// Deterministic edge-case paths — no randomness in this corpus. Pinned
// expectations live in grammar_test.ts.

/** `/mm/` + (k+1 groups joined by `/mid/`) + `/get` (+ optional suffix). */
export function midFamilyPath(k: number, suffix = ""): string {
  const groups = Array.from({ length: k + 1 }, (_, i) => "v" + i);
  return "/mm/" + groups.join("/mid/") + "/get" + suffix;
}
