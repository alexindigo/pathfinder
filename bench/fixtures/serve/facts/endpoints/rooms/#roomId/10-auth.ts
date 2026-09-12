// Fact-bearing fixture: middleware + outcome at a bounded-dynamic dir, and
// a fact-only catch-all dir — the always-dict scenarios. Plain middleware
// bodies (no short-circuit) so the scenarios measure the walk + dict, not
// handler work.
export default function auth(): void {}
