// SPDX-License-Identifier: LGPL-3.0-only

// Loader + factory tests against fixture trees: roots/overlay precedence,
// filename grammar, tombstones, middleware ordering, Layer 0, /_status/ guard,
// bodyLimit, custom types.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { resolveTree } from "../src/loader.ts";
import type { ManifestRow } from "../src/loader.ts";
import { envRoots, pathfinder } from "../src/pathfinder.ts";
import type { PathfinderApp } from "../src/pathfinder.ts";
import { GiB, KiB, MiB } from "../src/body_limit.ts";

const FIX = new URL("./fixtures/endpoints/", import.meta.url);
const APP = new URL("app/", FIX);
const OVERLAY = new URL("overlay/", FIX);

async function dispatch(
  app: PathfinderApp,
  path: string,
  init?: RequestInit,
  info?: unknown,
): Promise<Response> {
  return await app(new Request("http://localhost" + path, init), info);
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { error, debug, log, warn } = console;
  console.error = () => {};
  console.debug = () => {};
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.debug = debug;
    console.log = log;
    console.warn = warn;
  }
}

// --- Resolution -----------------------------------------------------------------

Deno.test("loader: fs routes, method uppercasing, open method set", async () => {
  await quiet(async () => {
    const { router, summary } = await resolveTree({ appRoots: [APP] });
    assertEquals(await (await router.handle(GET("/ping"))).text(), "app ping");
    assertEquals(await (await router.handle(GET("/"))).text(), "app root");
    // Open method set — PROPFIND registers like any verb.
    const propfind = await router.handle(
      new Request("http://localhost/api", { method: "PROPFIND" }),
    );
    assertEquals(await propfind.text(), "propfind");
    // Method histogram is the safety net for stray method-shaped files.
    assert(!summary.includes("HELPERS"), summary);
  });
});

Deno.test("loader: typed params flow through fs routes", async () => {
  await quiet(async () => {
    const { router } = await resolveTree({ appRoots: [APP] });
    const res = await router.handle(GET("/items/42"));
    assertEquals(await res.json(), { n: "42" });
    // (int) raw validation: %2D escapes fail (D6).
    const bad = await router.handle(GET("/items/%2D5"));
    assertEquals(bad.status, 404);
  });
});

Deno.test("loader: middleware — parent before child, lexicographic in dir", async () => {
  await quiet(async () => {
    const { router } = await resolveTree({ appRoots: [APP] });
    const res = await router.handle(GET("/api/v1"));
    assertEquals(await res.json(), { auth: true }); // /api middleware ran
    const root = await router.handle(GET("/"));
    assertEquals(await root.text(), "app root"); // root middleware ran too
  });
});

Deno.test("loader: meta named exports reach context.meta", async () => {
  await quiet(async () => {
    const { router } = await resolveTree({ appRoots: [APP] });
    // /api/v1/status/404.ts shadows the Layer-0 404 for that subtree; a miss
    // inside /api/v1/status cascades to it.
    const res = await router.handle(GET("/api/v1/status/none"));
    assertEquals(await res.json(), { detail: "no status page here" });
  });
});

Deno.test("loader: missing app root errors; missing env root warns+skips", async () => {
  await quiet(async () => {
    await assertRejects(
      () => resolveTree({ appRoots: ["/nonexistent/pathfinder-root"] }),
      Error,
      "app root",
    );
    const { router } = await resolveTree({
      appRoots: [APP],
      envRoots: ["/nonexistent/overlay-root"],
    });
    assertEquals(await (await router.handle(GET("/ping"))).text(), "app ping");
  });
});

Deno.test("loader: overlay roots — shadow, tombstone, augment", async () => {
  await quiet(async () => {
    const { router, manifest } = await resolveTree({
      appRoots: [APP],
      envRoots: [OVERLAY],
    });
    // Shadow: overlay ping replaces app ping.
    assertEquals(
      await (await router.handle(GET("/ping"))).text(),
      "overlay ping",
    );
    // Augment: new route from the overlay.
    assertEquals(
      await (await router.handle(GET("/extra"))).text(),
      "overlay extra",
    );
    // Tombstone: GET /api/v1/rooms/#roomId removed; other methods unaffected.
    const gone = await router.handle(GET("/api/v1/rooms/x"));
    assertEquals(gone.status, 404);
    // Manifest carries kind-tagged rows incl. tombstones and shadow chains.
    const tombstones = manifest.filter((r: ManifestRow) =>
      r.kind === "tombstone"
    );
    assertEquals(tombstones.length, 1);
    assert(tombstones[0].pattern!.includes("#roomId"));
    const shadowed = manifest.filter((r) => r.shadows !== undefined);
    assert(shadowed.some((r) => r.file.includes("overlay/ping/get.ts")));
    // Layer tagging: overlay rows are layer 2.
    const overlayRow = manifest.find((r) => r.file.includes("overlay/extra"));
    assertEquals(overlayRow?.layer, 2);
  });
});

Deno.test("loader: duplicate shape within one root is a build error", async () => {
  await quiet(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      // Same shape within ONE root: a/#x/get.ts and a/#y/get.ts → both
      // GET /a/# (param names don't create routes).
      await Deno.mkdir(`${tmp}/a/#x`, { recursive: true });
      await Deno.mkdir(`${tmp}/a/#y`, { recursive: true });
      await Deno.writeTextFile(`${tmp}/a/#x/get.ts`, "export default () => 1");
      await Deno.writeTextFile(`${tmp}/a/#y/get.ts`, "export default () => 2");
      await assertRejects(
        () => resolveTree({ appRoots: [tmp] }),
        Error,
        "duplicate route shape",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

Deno.test("loader: filename grammar — build errors on non-route files", async () => {
  await quiet(async () => {
    for (
      const name of [
        "_private.ts",
        "get.test.ts",
        "999.ts",
        "readme.md",
        "helper.tsx",
      ]
    ) {
      const tmp = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(`${tmp}/${name}`, "export default () => 1");
        await assertRejects(
          () => resolveTree({ appRoots: [tmp] }),
          Error,
          undefined,
          name,
        );
      } finally {
        await Deno.remove(tmp, { recursive: true });
      }
    }
  });
});

Deno.test("loader: .d.ts files are ignored by the loader", async () => {
  await quiet(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        `${tmp}/$types.d.ts`,
        "export interface Params {}",
      );
      await Deno.mkdir(`${tmp}/x`, { recursive: true });
      await Deno.writeTextFile(
        `${tmp}/x/$types.d.ts`,
        "export interface Params {}",
      );
      await Deno.writeTextFile(`${tmp}/x/get.ts`, "export default () => 'x'");
      const { router } = await resolveTree({ appRoots: [tmp] });
      assertEquals(await (await router.handle(GET("/x"))).text(), "x");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

// --- Factory + Layer 0 -----------------------------------------------------------

Deno.test("factory: pathfinder() returns the callable app with properties", async () => {
  await quiet(async () => {
    const app = await pathfinder({ roots: [APP] });
    const res = await dispatch(app, "/ping");
    assertEquals(await res.text(), "app ping");
    // lookup — the public rich lookup
    const lookup = app.lookup("GET", "/ping");
    assertEquals(lookup.kind, "match");
    // manifest — effective file table
    const rows = app.manifest();
    assert(rows.some((r) => r.kind === "route" && r.method === "GET"));
  });
});

Deno.test("factory: Layer 0 — 404 JSON, 405 Allow, 204 OPTIONS reflection", async () => {
  await quiet(async () => {
    const app = await pathfinder({ roots: [APP] });
    const notFound = await dispatch(app, "/nope");
    assertEquals(notFound.status, 404);
    assertEquals(await notFound.json(), { detail: "Not Found" });

    const methodMiss = await dispatch(app, "/ping", { method: "DELETE" });
    assertEquals(methodMiss.status, 405);
    assertEquals(methodMiss.headers.get("allow"), "GET");
    assertEquals(await methodMiss.json(), { detail: "Method Not Allowed" });

    const options = await dispatch(app, "/ping", { method: "OPTIONS" });
    assertEquals(options.status, 204);
    assertEquals(options.headers.get("allow"), "GET");

    // Errors render via Layer-0 500 without leaking internals.
    const rows = app.manifest();
    assert(rows.some((r) => r.kind === "status" && r.code === 500));
  });
});

Deno.test("factory: /_status/ guard — loopback allow, XFF + remote deny, masked 404", async () => {
  await quiet(async () => {
    const app = await pathfinder({ roots: [APP] });
    const loopback = { transport: "tcp", hostname: "127.0.0.1", port: 1 };

    const ok = await dispatch(app, "/_status", {}, { remoteAddr: loopback });
    assertEquals(ok.status, 200);
    const manifest = await ok.json();
    assert(Array.isArray(manifest));

    const health = await dispatch(app, "/_status/health", {}, {
      remoteAddr: loopback,
    });
    assertEquals(await health.json(), { status: "ok" });

    // XFF disqualifier: fail-closed even from loopback.
    const spoof = await dispatch(app, "/_status", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    }, { remoteAddr: loopback });
    assertEquals(spoof.status, 404);
    assertEquals(await spoof.json(), { detail: "Not Found" }); // masked

    // Non-loopback → masked 404.
    const remote = await dispatch(app, "/_status", {}, {
      remoteAddr: { transport: "tcp", hostname: "10.0.0.9", port: 2 },
    });
    assertEquals(remote.status, 404);

    // No remoteAddr (unix socket etc.) → deny.
    const noAddr = await dispatch(app, "/_status");
    assertEquals(noAddr.status, 404);
  });
});

Deno.test("factory: PATHFINDER_USER_ENDPOINTS — always on, last wins", async () => {
  await quiet(async () => {
    // Unset = zero extra FS access, normal run.
    Deno.env.delete("PATHFINDER_USER_ENDPOINTS");
    assertEquals(envRoots(), []);
    const bare = await pathfinder({ roots: [APP] });
    assertEquals(await (await dispatch(bare, "/ping")).text(), "app ping");

    // Set: layered after app roots, left→right.
    Deno.env.set("PATHFINDER_USER_ENDPOINTS", `${OVERLAY.pathname}`);
    try {
      const app = await pathfinder({ roots: [APP] });
      assertEquals(await (await dispatch(app, "/ping")).text(), "overlay ping");
      assertEquals(
        await (await dispatch(app, "/extra")).text(),
        "overlay extra",
      );
      const gone = await dispatch(app, "/api/v1/rooms/x");
      assertEquals(gone.status, 404);
    } finally {
      Deno.env.delete("PATHFINDER_USER_ENDPOINTS");
    }

    // Missing env root: warn+skip, boot never hostage.
    Deno.env.set("PATHFINDER_USER_ENDPOINTS", "/nonexistent/overlay-root");
    try {
      const app = await pathfinder({ roots: [APP] });
      assertEquals(await (await dispatch(app, "/ping")).text(), "app ping");
    } finally {
      Deno.env.delete("PATHFINDER_USER_ENDPOINTS");
    }
  });
});

Deno.test("factory: custom types register into the grammar, immutable after boot", async () => {
  await quiet(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${tmp}/by-uuid/#(uuid)id`, { recursive: true });
      await Deno.writeTextFile(
        `${tmp}/by-uuid/#(uuid)id/get.ts`,
        "export default (request) => request.params.id",
      );
      const app = await pathfinder({
        roots: [tmp],
        types: {
          uuid: {
            validate: (value) => /^[0-9a-f-]{36}$/.test(value),
            parse: (value) => value,
          },
        },
      });
      const res = await dispatch(
        app,
        "/by-uuid/01234567-89ab-cdef-0123-456789abcdef",
      );
      assertEquals(await res.text(), "01234567-89ab-cdef-0123-456789abcdef");
      const bad = await dispatch(app, "/by-uuid/not-a-uuid");
      assertEquals(bad.status, 404);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

Deno.test("bodyLimit: meta battery — 413 outcome on oversized bodies", async () => {
  await quiet(async () => {
    const tmp = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${tmp}/upload`, { recursive: true });
      await Deno.writeTextFile(
        `${tmp}/upload/post.ts`,
        "export const bodyLimit = 8;\nexport default async (request) => await request.body.text()",
      );
      const app = await pathfinder({ roots: [tmp] });
      // Under the limit → passes through.
      const ok = await dispatch(app, "/upload", {
        method: "POST",
        body: "12345678",
      });
      assertEquals(await ok.text(), "12345678");
      // Over the limit via accessors → 413 outcome (Layer-0 default).
      const over = await dispatch(app, "/upload", {
        method: "POST",
        body: "123456789",
      });
      assertEquals(over.status, 413);
      assertEquals(await over.json(), { detail: "Payload Too Large" });
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});

Deno.test("bodyLimit: constants are honest binary sizes", () => {
  assertEquals(KiB, 1024);
  assertEquals(MiB, 1024 * KiB);
  assertEquals(GiB, 1024 * MiB);
});

function GET(path: string): Request {
  return new Request("http://localhost" + path);
}
