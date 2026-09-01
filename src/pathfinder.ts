// SPDX-License-Identifier: LGPL-3.0-only

// The `pathfinder()` factory — returns the main loop itself as a callable app
// (Express-style function-with-properties):
//
//   Deno.serve(await pathfinder("./endpoints/"));
//
// No public Router class; public register()/shorthands postponed; the
// `.fetch` alias is RESERVED (additive) for Workers/Bun `export default`
// compat — not shipped in v1.

import { resolveTree } from "./loader.ts";
import type { Loaded, ManifestRow } from "./loader.ts";
import { layer0Entries } from "./layer0.ts";
import type { LookupResult } from "./matcher.ts";
import type { TypeSpec } from "./grammar.ts";

export interface PathfinderOptions {
  /** Layer 1 app roots (Layer 0 ships in the package; Layer 2+ is
   * `PATHFINDER_USER_ENDPOINTS`, always on). Missing app root → error. */
  roots?: (string | URL)[];
  /** Long-lived app data — `context.app`. Fields open; plugins/overlays may
   * self-register. */
  app?: object;
  /** Custom type registry (`#(uuid)x`), immutable after boot; built-ins are
   * the examples of the mechanism. */
  types?: Record<string, TypeSpec>;
}

/** Effective file table — kind-tagged rows (route/middleware/status/
 * tombstone — tombstones first-class = heartbleed verification). */
export type { ManifestRow };

export interface PathfinderApp {
  (request: Request, info?: unknown): Promise<Response>;
  manifest(): readonly ManifestRow[];
  /** Rich lookup: match | method-miss{allowed} | no-match. */
  lookup(method: string, path: string): LookupResult;
}

const RESERVED_ENDPOINTS_ENV = "PATHFINDER_USER_ENDPOINTS";

/** Overlay roots from the environment — PATH-style, colon-separated,
 * layered after app roots, left→right, last wins. ALWAYS ON, unconditional.
 * Unset = zero extra FS access. */
export function envRoots(): (string | URL)[] {
  const value = Deno.env.get(RESERVED_ENDPOINTS_ENV);
  if (value === undefined || value.trim() === "") return [];
  return value.split(":").filter((part) => part.trim() !== "").map((part) =>
    part.trim()
  );
}

export async function pathfinder(
  options: string | PathfinderOptions,
): Promise<PathfinderApp> {
  const opts: PathfinderOptions = typeof options === "string"
    ? { roots: [options] }
    : options;

  // Late-bound: Layer 0 registers before resolution, but the manifest is only
  // READ at request time — by then the snapshot below exists (post-boot
  // static: v1 makes no post-boot mutability promise).
  let manifestRows: ManifestRow[] = [];
  const loaded: Loaded = await resolveTree({
    layer0: layer0Entries(() => manifestRows),
    manifest: () => manifestRows,
    appRoots: opts.roots ?? [],
    envRoots: envRoots(),
    app: opts.app,
    types: opts.types,
  });
  manifestRows = loaded.manifest;

  const { router, summary } = loaded;

  const app =
    ((request: Request, info?: unknown) =>
      router.handle(request, info)) as PathfinderApp;
  app.manifest = () => manifestRows;
  app.lookup = (method: string, path: string) => router.lookup(method, path);

  // The startup summary line IS the observability: the method histogram is
  // the safety net that surfaces stray method-shaped files (HELPERS 1).
  console.log(`[pathfinder] ${summary}`);
  return app;
}
