// SPDX-License-Identifier: LGPL-3.0-only

// $types generator tests: matryoshka emission, gen --check drift gate.

import { assertEquals } from "@std/assert";
import { generateTypes } from "../src/loader/types-gen.ts";
import { dirParams } from "../src/loader/types-gen.ts";

Deno.test("types-gen: dirname grammar → param types", () => {
  assertEquals(dirParams("#x").get("x"), { tsType: "string", optional: false });
  assertEquals(dirParams("#(num)x").get("x"), {
    tsType: "number",
    optional: false,
  });
  assertEquals(dirParams("#(int)x").get("x"), {
    tsType: "bigint",
    optional: false,
  });
  assertEquals(dirParams("#...rest").get("rest"), {
    tsType: "string",
    optional: false,
  });
  assertEquals(dirParams("#x.json").get("x"), {
    tsType: "string",
    optional: false,
  });
  assertEquals(dirParams("plain").size, 0);
});

Deno.test("types-gen: empty-ok ## dirnames emit optional params", () => {
  assertEquals(dirParams("##x").get("x"), { tsType: "string", optional: true });
  assertEquals(dirParams("##(int)n").get("n"), {
    tsType: "bigint",
    optional: true,
  });
  assertEquals(dirParams("##(num)n").get("n"), {
    tsType: "number",
    optional: true,
  });
});

Deno.test("types-gen: matryoshka emission + drift gate", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Tree: api/#(int)v/#name/get.ts + items/#(num)n/get.ts + plain/
    //   + ping##ext/get.ts (empty-ok terminal capture → optional param)
    await Deno.mkdir(`${tmp}/api/#(int)v/#name`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/api/#(int)v/#name/get.ts`, "x");
    await Deno.mkdir(`${tmp}/api/#(int)v`, { recursive: true });
    await Deno.mkdir(`${tmp}/api`, { recursive: true });
    await Deno.mkdir(`${tmp}/items/#(num)n`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/items/#(num)n/get.ts`, "x");
    await Deno.mkdir(`${tmp}/plain`, { recursive: true });
    await Deno.mkdir(`${tmp}/ping##ext`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/ping##ext/get.ts`, "x");

    const first = await generateTypes([tmp]);
    assertEquals(first.drift, []);
    assertEquals(first.files.length, 8); // root + api + v + name + items + n + plain + ping##ext

    // Root: honest-union baseline.
    const root = await Deno.readTextFile(`${tmp}/$types.d.ts`);
    assert(root.includes("Record<string, string | number | bigint>"));

    // #name extends its typed parent chain: v:number then name:string.
    const v = await Deno.readTextFile(`${tmp}/api/#(int)v/$types.d.ts`);
    assert(v.includes(`"v": bigint;`));
    const name = await Deno.readTextFile(
      `${tmp}/api/#(int)v/#name/$types.d.ts`,
    );
    assert(
      name.includes(
        `import type { Params as ParentParams } from "../$types.d.ts";`,
      ),
    );
    assert(name.includes(`"name": string;`));

    // ##ext emits an optional param.
    const ext = await Deno.readTextFile(`${tmp}/ping##ext/$types.d.ts`);
    assert(ext.includes(`"ext"?: string;`));

    // --check passes on a fresh tree.
    const clean = await generateTypes([tmp], { check: true });
    assertEquals(clean.drift, []);

    // Drift: edit a generated file → --check flags it.
    await Deno.writeTextFile(`${tmp}/api/#(int)v/$types.d.ts`, "// tampered\n");
    const drifted = await generateTypes([tmp], { check: true });
    assertEquals(drifted.drift.length, 1);
    assert(drifted.drift[0].includes("#(int)v"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

function assert(condition: unknown, msg?: string): void {
  if (!condition) throw new Error(msg ?? "assertion failed");
}
