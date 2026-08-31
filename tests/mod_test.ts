// SPDX-License-Identifier: LGPL-3.0-only

import { assertEquals } from "@std/assert";
import * as mod from "../mod.ts";

Deno.test("root module loads", () => {
  assertEquals(typeof mod, "object");
});
