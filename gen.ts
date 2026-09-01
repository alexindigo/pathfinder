// SPDX-License-Identifier: LGPL-3.0-only

// CLI: emit per-directory `$types.d.ts` files for endpoint roots.
//
//   deno task gen -- ./endpoints/
//   deno task gen:check -- ./endpoints/   (CI drift gate — exits 1 on drift)

import { generateTypes } from "./src/types-gen.ts";

const args = Deno.args.filter((a) => a !== "--" && a.trim() !== "");
const check = args.includes("--check");
const roots = args.filter((a) => a !== "--check");

if (roots.length === 0) {
  console.error("usage: deno task gen [--check] -- <root> [root...]");
  Deno.exit(2);
}

const { files, drift } = await generateTypes(roots, { check });

if (check) {
  if (drift.length > 0) {
    console.error(
      `[pathfinder] gen --check: ${drift.length} file(s) drifted:\n  ${
        drift.join("\n  ")
      }\nRun \`deno task gen\` to regenerate.`,
    );
    Deno.exit(1);
  }
  console.log(`[pathfinder] gen --check: ${files.length} file(s) up to date`);
} else {
  console.log(`[pathfinder] generated ${files.length} $types.d.ts file(s)`);
}
