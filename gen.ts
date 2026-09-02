// SPDX-License-Identifier: LGPL-3.0-only

// CLI: emit per-directory `$types.d.ts` files for endpoint roots, and sibling
// tree indexes (`<dir>.ts`) for packaged trees.
//
//   deno task gen -- ./endpoints/                     (types)
//   deno task gen:check -- ./endpoints/               (CI drift gate)
//   deno task gen -- index src/layer0                 (tree index)
//   deno run --allow-read gen.ts index --check src/layer0   (drift gate)

import { generateTypes } from "./src/types-gen.ts";
import { generateIndex } from "./src/index-gen.ts";

const args = Deno.args.filter((a) => a !== "--" && a.trim() !== "");

if (args[0] === "index") {
  // index subcommand: gen index [--check] [--from <specifier>] <dir>…
  const rest = args.slice(1);
  const check = rest.includes("--check");
  let from: string | undefined;
  const dirs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--check") continue;
    if (rest[i] === "--from") {
      from = rest[++i];
      continue;
    }
    dirs.push(rest[i]);
  }
  if (dirs.length === 0) {
    console.error("usage: gen index [--check] [--from <specifier>] <dir>…");
    Deno.exit(2);
  }
  const drifted: string[] = [];
  let written = 0;
  for (const dir of dirs) {
    const result = await generateIndex(dir, { check, from });
    if (check) {
      if (result.drift) drifted.push(result.file);
    } else {
      console.log(
        `[pathfinder] gen index: wrote ${result.file} (${result.entries} entries)`,
      );
      written++;
    }
  }
  if (check) {
    if (drifted.length > 0) {
      console.error(
        `[pathfinder] gen index --check: ${drifted.length} file(s) drifted:\n  ${
          drifted.join("\n  ")
        }\nRun \`gen index <dir>\` to regenerate.`,
      );
      Deno.exit(1);
    }
    console.log(
      `[pathfinder] gen index --check: ${dirs.length} file(s) up to date`,
    );
  }
  Deno.exit(0);
}

// types subcommand (default): gen [--check] -- <root> [root...]
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
