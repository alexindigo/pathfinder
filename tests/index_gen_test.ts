// SPDX-License-Identifier: LGPL-3.0-only

// Tree index generator tests: emission shape, drift gate, grammar errors,
// parity with the fs walk, and resolver integration of index roots.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { generateIndex } from "../src/index-gen.ts";
import { displayRoot, isIndexRoot, resolveTree } from "../src/loader.ts";
import type { IndexRoot } from "../src/loader.ts";

async function makeTree(): Promise<string> {
  const tmp = await Deno.makeTempDir();
  await Deno.mkdir(`${tmp}/tree/api/#roomId`, { recursive: true });
  await Deno.mkdir(`${tmp}/tree/api/v1`, { recursive: true });
  await Deno.writeTextFile(`${tmp}/tree/get.ts`, "export default () => 'root'");
  await Deno.writeTextFile(
    `${tmp}/tree/api/v1/get.ts`,
    "export default () => 'v1'",
  );
  await Deno.writeTextFile(
    `${tmp}/tree/api/#roomId/get.ts`,
    "export default (request) => request.params.roomId",
  );
  await Deno.writeTextFile(
    `${tmp}/tree/api/10-mark.ts`,
    "export default function mark(_r, c) { c.state.mark = 'yes'; }",
  );
  await Deno.writeTextFile(
    `${tmp}/tree/404.ts`,
    "export default () => 'tree 404'",
  );
  await Deno.writeTextFile(
    `${tmp}/tree/$types.d.ts`,
    "export interface Params {}",
  );
  return tmp;
}

Deno.test("index-gen: sibling emission with static imports + entries", async () => {
  const tmp = await makeTree();
  try {
    const result = await generateIndex(`${tmp}/tree`);
    assertEquals(result.file, `${tmp}/tree.ts`);
    assertEquals(result.entries, 5); // get×3, 10-mark middleware, 404 — .d.ts skipped
    assert(
      result.content.includes('import * as m0 from "./tree/404.ts";') ||
        result.content.includes('import * as m1 from "./tree/api/v1/get.ts";'),
    );
    assert(
      result.content.includes(
        `import type { IndexRoot, LayerIndexEntry } from "./loader.ts";`,
      ),
    );
    assert(
      result.content.includes('root: new URL("./", import.meta.url).href'),
    );
    assert(result.content.includes('"GET"'));
    assert(result.content.includes('"/api/#roomId"'));
    assert(result.content.includes('"/api"')); // middleware dir
    assert(result.content.includes("404")); // status code
    // Importing the emitted module yields a self-describing IndexRoot.
    const tree = (await import(`${result.file}`)).default as IndexRoot;
    assert(isIndexRoot(tree));
    assert(tree.root.startsWith("file://"));
    assertEquals(tree.entries.length, 5);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("index-gen: --from rewrites the type import", async () => {
  const tmp = await makeTree();
  try {
    const result = await generateIndex(`${tmp}/tree`, {
      from: "@pathfinder/pathfinder",
    });
    assert(result.content.includes('from "@pathfinder/pathfinder";'));
    assert(!result.content.includes('from "./loader.ts"'));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("index-gen: drift gate — check mode flags tampered and missing", async () => {
  const tmp = await makeTree();
  try {
    const written = await generateIndex(`${tmp}/tree`);
    assertEquals(
      (await generateIndex(`${tmp}/tree`, { check: true })).drift,
      false,
    );
    await Deno.writeTextFile(written.file, "// tampered\n");
    const drifted = await generateIndex(`${tmp}/tree`, { check: true });
    assertEquals(drifted.drift, true);
    // Missing file also drifts.
    await Deno.remove(written.file);
    assertEquals(
      (await generateIndex(`${tmp}/tree`, { check: true })).drift,
      true,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("index-gen: grammar errors propagate with path context", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/tree`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/tree/999.ts`, "export default () => 1");
    const error = await generateIndex(`${tmp}/tree`).catch((e) => e);
    assert(error instanceof Error);
    assert(error.message.includes("999.ts"));
    assert(error.message.includes("not in the outcome map"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("index-gen: rejects unnamed roots", async () => {
  const error = await generateIndex(".").catch((e) => e);
  assert(error instanceof Error);
  assert(error.message.includes("named tree directory"));
});

Deno.test("resolver: index roots are consumed, layered, shadowable", async () => {
  const tmp = await makeTree();
  try {
    await generateIndex(`${tmp}/tree`);
    const tree = (await import(`${tmp}/tree.ts`)).default as IndexRoot;

    // Two index roots: the later one shadows (last wins). The overlay is a
    // distinct root (its own URL) replacing one entry's module (plain spread
    // — module namespaces aren't cloneable).
    const overlay: IndexRoot = {
      root: "file:///overlay-pkg/",
      entries: tree.entries.map((e) =>
        e.kind === "method" && e.pattern === "/api/#roomId"
          ? { ...e, mod: { default: () => "overridden room" } }
          : e
      ),
    };

    const { router, manifest } = await resolveTree({
      appRoots: [tree, overlay],
    });
    const res = await router.handle(new Request("http://localhost/api/42"));
    assertEquals(await res.text(), "overridden room"); // string → text/plain

    const rows = manifest.filter((r) => r.kind === "route");
    assert(rows.length > 0);
    assert(rows.every((r) => r.root.startsWith("/")), rows[0].root); // file: display = fs path
    assert(rows.every((r) => r.file.startsWith("tree/")));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolver: https: string roots are refused with the index recipe", async () => {
  await assertRejects(
    () =>
      resolveTree({ appRoots: ["https://jsr.io/@mock/fx/0.0.1/endpoints/"] }),
    Error,
    "cannot walk a URL root",
  );
});

Deno.test("resolver: layer0 index lands at layer 0 and shadows lose to apps", async () => {
  const tmp = await makeTree();
  try {
    await generateIndex(`${tmp}/tree`);
    const tree = (await import(`${tmp}/tree.ts`)).default as IndexRoot;

    // layer0 provides a route; an app root shadows it.
    const { router, manifest } = await resolveTree({
      layer0: tree,
      appRoots: [`${tmp}/tree`],
    });
    const res = await router.handle(new Request("http://localhost/api/v1"));
    assertEquals(await res.text(), "v1"); // string → text/plain

    const layer0Rows = manifest.filter((r) => r.layer === 0);
    assert(layer0Rows.length > 0);
    assertEquals(
      layer0Rows.every((r) => r.root === displayRoot(tree.root)),
      true,
    );
    // Walked app rows land at layer 1.
    assert(manifest.some((r) => r.layer === 1 && r.kind === "route"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("displayRoot: file:, jsr.io, and pass-through URLs", () => {
  assertEquals(displayRoot("file:///home/u/pkg/src/"), "/home/u/pkg/src/");
  assertEquals(
    displayRoot("https://jsr.io/@mock/fx/0.0.1/src/"),
    "jsr:@mock/fx@0.0.1",
  );
  assertEquals(displayRoot("https://other.host/x/"), "https://other.host/x/");
});
