// SPDX-License-Identifier: LGPL-3.0-only

// $types generator tests: matryoshka emission, gen --check drift gate.

import { assertEquals } from "@std/assert";
import { generateTypes } from "../src/types-gen.ts";
import { dirParams } from "../src/types-gen.ts";

Deno.test("types-gen: dirname grammar → param types", () => {
  assertEquals(dirParams("#x").get("x"), "string");
  assertEquals(dirParams("#(num)x").get("x"), "number");
  assertEquals(dirParams("#(int)x").get("x"), "bigint");
  assertEquals(dirParams("#...rest").get("rest"), "string");
  assertEquals(dirParams("#x.json").get("x"), "string");
  assertEquals(dirParams("plain").size, 0);
});

Deno.test("types-gen: matryoshka emission + drift gate", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Tree: api/#(int)v/#name/get.ts + items/#(num)n/get.ts + plain/
    await Deno.mkdir(`${tmp}/api/#(int)v/#name`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/api/#(int)v/#name/get.ts`, "x");
    await Deno.mkdir(`${tmp}/api/#(int)v`, { recursive: true });
    await Deno.mkdir(`${tmp}/api`, { recursive: true });
    await Deno.mkdir(`${tmp}/items/#(num)n`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/items/#(num)n/get.ts`, "x");
    await Deno.mkdir(`${tmp}/plain`, { recursive: true });

    const first = await generateTypes([tmp]);
    assertEquals(first.drift, []);
    assertEquals(first.files.length, 7); // root + api + v + name + items + n + plain

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
