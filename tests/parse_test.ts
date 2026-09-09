// SPDX-License-Identifier: LGPL-3.0-only

// ParseError + parseJson: the endpoint-side parse convenience. The
// framework default is untouched — uncaught parse errors still map to the
// 500 outcome by design; parseJson makes the shaped-body mapping a catch.

import { assertEquals } from "@std/assert";
import { Router } from "../src/router.ts";
import { json, ParseError, parseJson } from "../src/http.ts";

const quiet = async (fn: () => Promise<void>): Promise<void> => {
  const { error } = console;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = error;
  }
};

const POST = (path: string, body: string) =>
  new Request("http://localhost" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

Deno.test("parseJson: parses a valid JSON body", async () => {
  const router = new Router();
  router.add("POST", "/x", (request) => parseJson(request));
  const response = await router.handle(POST("/x", `{"ok":true}`));
  assertEquals(await response.json(), { ok: true });
});

Deno.test("parseJson: wraps SyntaxError into ParseError (catchable, cause kept)", async () => {
  const router = new Router();
  let caught: ParseError | undefined;
  router.add("POST", "/x", async (request) => {
    try {
      return await parseJson(request);
    } catch (error) {
      if (error instanceof ParseError) caught = error;
      throw error;
    }
  });
  await quiet(async () => {
    const response = await router.handle(POST("/x", `{"broken":`));
    assertEquals(response.status, 500);
  });
  assertEquals(caught instanceof ParseError, true);
  assertEquals(caught!.message, "request body is not valid JSON");
  assertEquals(caught!.cause instanceof SyntaxError, true);
});

Deno.test("parseJson: shaped-body mapping — the M_NOT_JSON pattern", async () => {
  await quiet(async () => {
    const router = new Router();
    router.add("POST", "/send", async (request) => {
      try {
        return await parseJson(request);
      } catch (error) {
        if (error instanceof ParseError) {
          return json({ errcode: "M_NOT_JSON", error: "Content not JSON." }, {
            status: 400,
          });
        }
        throw error;
      }
    });
    const bad = await router.handle(POST("/send", "not json"));
    assertEquals(bad.status, 400);
    assertEquals(await bad.json(), {
      errcode: "M_NOT_JSON",
      error: "Content not JSON.",
    });
    const good = await router.handle(POST("/send", `{"a":1}`));
    assertEquals(good.status, 200);
  });
});

Deno.test("framework default stays: uncaught parse error → 500 outcome", async () => {
  await quiet(async () => {
    const router = new Router();
    router.add("POST", "/x", (request) => request.body.json());
    const response = await router.handle(POST("/x", "not json"));
    assertEquals(response.status, 500);
  });
});
