// SPDX-License-Identifier: LGPL-3.0-only

// Cascade integration matrix (plan §3.6): real fixture trees loaded through
// the production loader (Layer 0 included unless the row is about vacuum),
// dispatched through the Router. A shared recorder proves who ran and in
// what order. Rows A–C/E–G are the regression floor (they passed via the
// scan and must keep passing via the dict); row D is the newly deterministic
// tie-break.

import { assertEquals } from "@std/assert";
import { resolveTree } from "../src/loader/mod.ts";
import layer0Tree from "../src/layer0.ts";
import * as recorder from "./fixtures/cascade/recorder.ts";

const BASE = new URL("./fixtures/cascade/", import.meta.url);
const tree = (name: string) => new URL(name, BASE).pathname;

const GET = (path: string, headers?: HeadersInit) =>
  new Request(`http://cascade.local${path}`, { headers });
const POST = (path: string, headers?: HeadersInit) =>
  new Request(`http://cascade.local${path}`, { method: "POST", headers });
const TOKEN = { authorization: "Bearer t" };

async function boot(app: string, withLayer0 = true) {
  recorder.reset();
  return await resolveTree({
    ...(withLayer0 ? { layer0: layer0Tree } : {}),
    appRoots: [tree(`${app}/endpoints/`)],
  });
}

async function body(res: Response): Promise<string> {
  const text = await res.text();
  return text;
}

// --- A. rooms app (hole 1): facts at bounded-dynamic directories ---------------

Deno.test("cascade A: rooms — middleware + outcome at a dynamic dir ride hits and misses", async () => {
  const { router } = await boot("rooms");
  // Hits: root log (outer) → auth (inner) → handler.
  const messages = await router.handle(GET("/rooms/42/messages", TOKEN));
  assertEquals(messages.status, 200);
  assertEquals(await body(messages), "messages-body");
  assertEquals([...recorder.log], ["log", "rooms-auth", "messages"]);
  recorder.reset();
  const settings = await router.handle(GET("/rooms/7/settings", TOKEN));
  assertEquals(settings.status, 200);
  assertEquals(await body(settings), "settings-body");
  assertEquals([...recorder.log], ["log", "rooms-auth", "settings"]);
  // Miss without token: auth runs, outcome page never reached.
  recorder.reset();
  const denied = await router.handle(GET("/rooms/42/unknown"));
  assertEquals(denied.status, 401);
  assertEquals(
    await body(denied),
    '{"errcode":"M_UNKNOWN_TOKEN","error":"Invalid token"}',
  );
  assertEquals([...recorder.log], ["log", "rooms-auth"]);
  // Miss with token: the room's own 404 page (the branch's dict).
  recorder.reset();
  const miss = await router.handle(GET("/rooms/42/unknown", TOKEN));
  assertEquals(miss.status, 404);
  assertEquals(await body(miss), "room-404-page");
  assertEquals([...recorder.log], ["log", "rooms-auth", "rooms-404"]);
  // A folder without files: no folder middleware runs; Layer-0 answers.
  recorder.reset();
  const users = await router.handle(GET("/users/7/nope"));
  assertEquals(users.status, 404);
  assertEquals(await body(users), '{"detail":"Not Found"}');
  assertEquals([...recorder.log], ["log"]);
});

Deno.test("cascade A′: typed variant — validation at capture, auth not run", async () => {
  const { router } = await boot("rooms-typed");
  const miss = await router.handle(GET("/rooms/abc/messages"));
  assertEquals(miss.status, 404);
  assertEquals(await body(miss), '{"detail":"Not Found"}');
  assertEquals([...recorder.log], []);
  const hit = await router.handle(GET("/rooms/42/messages", TOKEN));
  assertEquals(hit.status, 200);
  assertEquals(await body(hit), "messages-body");
  assertEquals([...recorder.log], ["rooms-auth", "messages"]);
});

// --- B. files apps (hole 2): catch-all folders with files --------------------

Deno.test("cascade B1: cheeky page — fact-only folder is a stopping point", async () => {
  const { router } = await boot("files-cheeky");
  const miss = await router.handle(GET("/files/leaked_material.pdf"));
  assertEquals(miss.status, 404);
  assertEquals(await body(miss), "cheeky-files-page");
  assertEquals([...recorder.log], ["cheeky-404"]);
  // /files/ itself: the fact-bearing folder stand answers too.
  recorder.reset();
  const slash = await router.handle(GET("/files/"));
  assertEquals(slash.status, 404);
  assertEquals(await body(slash), "cheeky-files-page");
});

Deno.test("cascade B2: endpoint 404 cascades to the parent folder's page", async () => {
  const { router } = await boot("files-cascade");
  const res = await router.handle(GET("/files/x/y"));
  assertEquals(res.status, 404);
  assertEquals(await body(res), "cascade-files-page");
  assertEquals([...recorder.log], ["files-endpoint", "files-404"]);
});

Deno.test("cascade B3: attached page inside the catch-all dir; /files/ out of scope", async () => {
  const { router } = await boot("files-inner");
  const res = await router.handle(GET("/files/x/y"));
  assertEquals(res.status, 404);
  assertEquals(await body(res), "inner-files-page");
  assertEquals([...recorder.log], ["inner-endpoint", "inner-404"]);
  recorder.reset();
  const slash = await router.handle(GET("/files/"));
  assertEquals(slash.status, 404);
  assertEquals(await body(slash), '{"detail":"Not Found"}');
  assertEquals([...recorder.log], []);
});

// --- C. api app (hole 3): wrong-method and static/bounded interplay ----------

Deno.test("cascade C: api — the five-request table", async () => {
  const { router } = await boot("api");
  // 1. Static branch accepts before the bounded candidate: auth NOT run.
  const v1 = await router.handle(GET("/api/docs/v1"));
  assertEquals(v1.status, 200);
  assertEquals(await body(v1), "docs-v1-body");
  assertEquals([...recorder.log], ["v1-handler"]);
  // 2. Usage with/without token.
  recorder.reset();
  const usage = await router.handle(GET("/api/acme-corp/usage", TOKEN));
  assertEquals(usage.status, 200);
  assertEquals(await body(usage), "usage-body");
  assertEquals([...recorder.log], ["api-auth", "usage-handler"]);
  recorder.reset();
  const usageDenied = await router.handle(GET("/api/acme-corp/usage"));
  assertEquals(usageDenied.status, 401);
  assertEquals([...recorder.log], ["api-auth"]);
  // 3. Invoices: miss at the account stand — auth runs; with token → 404
  //    (no 404 page on that branch → Layer-0 default).
  recorder.reset();
  const invoices = await router.handle(GET("/api/acme-corp/invoices"));
  assertEquals(invoices.status, 401);
  assertEquals([...recorder.log], ["api-auth"]);
  recorder.reset();
  const invoicesAuthed = await router.handle(
    GET("/api/acme-corp/invoices", TOKEN),
  );
  assertEquals(invoicesAuthed.status, 404);
  assertEquals(await body(invoicesAuthed), '{"detail":"Not Found"}');
  assertEquals([...recorder.log], ["api-auth"]);
  // 4. /api/docs/v2: docs reads as the account — the static branch dies and
  // the bounded guess carries the fact.
  recorder.reset();
  const v2 = await router.handle(GET("/api/docs/v2"));
  assertEquals(v2.status, 401);
  assertEquals([...recorder.log], ["api-auth"]);
  recorder.reset();
  const v2Authed = await router.handle(GET("/api/docs/v2", TOKEN));
  assertEquals(v2Authed.status, 404);
  assertEquals(await body(v2Authed), '{"detail":"Not Found"}');
  assertEquals([...recorder.log], ["api-auth"]);
  // 5. Wrong method: auth first, then 405 with Allow.
  recorder.reset();
  const usagePost = await router.handle(POST("/api/acme-corp/usage"));
  assertEquals(usagePost.status, 401);
  assertEquals([...recorder.log], ["api-auth"]);
  recorder.reset();
  const usagePostAuthed = await router.handle(
    POST("/api/acme-corp/usage", TOKEN),
  );
  assertEquals(usagePostAuthed.status, 405);
  assertEquals(usagePostAuthed.headers.get("allow"), "GET");
  assertEquals([...recorder.log], ["api-auth"]);
});

// --- D. tie-break: exact-name folder beats blank-name at equal depth ----------

Deno.test("cascade D: exact-name folder wins the tie deterministically", async () => {
  const { router } = await boot("tie");
  const res = await router.handle(GET("/a/b/x"));
  assertEquals(res.status, 404);
  assertEquals(await body(res), "tie-404-page");
  assertEquals([...recorder.log], ["tie-404"]);
});

// --- E. catch-all middleware ---------------------------------------------------

Deno.test("cascade E: catch-all middleware runs inside, not at the folder edge", async () => {
  const { router } = await boot("dl");
  const inner = await router.handle(GET("/dl/x/y", TOKEN));
  assertEquals(inner.status, 200);
  assertEquals(await body(inner), "dl-body");
  assertEquals([...recorder.log], ["dl-auth", "dl-endpoint"]);
  recorder.reset();
  const edge = await router.handle(GET("/dl/"));
  assertEquals(edge.status, 404);
  assertEquals(await body(edge), '{"detail":"Not Found"}');
  assertEquals([...recorder.log], []);
});

// --- F. tombstones: load-time removals ---------------------------------------

Deno.test("cascade F: overlay tombstone removes the middleware at load", async () => {
  const pre = await boot("tombstone/app");
  // Baseline: without the overlay the auth runs.
  recorder.reset();
  const before = await pre.router.handle(GET("/api/x"));
  assertEquals(before.status, 401);
  assertEquals([...recorder.log], ["log", "api-auth"]);
  // With the overlay the middleware is killed at load: never enters the
  // automaton; sibling dirs keep theirs; the manifest records the row.
  const overlay = tree("tombstone/overlay/endpoints/");
  recorder.reset();
  const killed = await resolveTree({
    layer0: layer0Tree,
    appRoots: [tree("tombstone/app/endpoints/")],
    envRoots: [overlay],
  });
  const res = await killed.router.handle(GET("/api/x"));
  assertEquals(res.status, 404); // no auth short-circuit; Layer-0 answers
  assertEquals(await body(res), '{"detail":"Not Found"}');
  assertEquals([...recorder.log], ["log"]);
  const tombstones = killed.manifest.filter((r) => r.kind === "tombstone");
  assertEquals(tombstones.length >= 2, true, "tombstone rows recorded");
});

Deno.test("cascade F: tombstone with no lower-layer registration is a silent no-op", async () => {
  const ghostOnly = await resolveTree({
    layer0: layer0Tree,
    appRoots: [tree("vacuum/endpoints/")],
    envRoots: [tree("tombstone/overlay/endpoints/")],
  });
  const res = await ghostOnly.router.handle(GET("/api/x"));
  assertEquals(res.status, 404); // nothing registered — no error, no auth
});

// --- F′. vacuum: no middleware/outcome files anywhere --------------------------

Deno.test("cascade F′: vacuum — bare 404 at the root stand, no middleware", async () => {
  const { router } = await boot("vacuum", false);
  const miss = await router.handle(GET("/nope"));
  assertEquals(miss.status, 404);
  assertEquals(await body(miss), "");
  assertEquals([...recorder.log], []);
  const hit = await router.handle(GET("/ping"));
  assertEquals(hit.status, 200);
  assertEquals(await body(hit), "ping-body");
});

// --- G. communico regression (leafless _matrix dir, loader-based) --------------

Deno.test("cascade G: _matrix leafless dir answers deep misses", async () => {
  const { router } = await boot("matrix");
  const res = await router.handle(GET("/_matrix/client/v3/nope"));
  assertEquals(res.status, 404);
  const page = await res.json() as { errcode?: string };
  assertEquals(page.errcode, "M_UNRECOGNIZED");
});
