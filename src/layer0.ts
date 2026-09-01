// SPDX-License-Identifier: LGPL-3.0-only

// Layer 0 — pathfinder's own root (shipped in the package, loaded first):
// the outcome renderers + the `/_status/` ops subtree with its loopback+no-XFF
// guard. Registered as pre-classified entries so app roots and overlays can
// shadow or tombstone every one of them (last wins, per file).

import { allowedMethods } from "./http.ts";
import type { Entry } from "./loader.ts";
import type { Handler, Middleware, PathfinderRequest } from "./router.ts";

const NOT_FOUND = { detail: "Not Found" } as const;

/** Guard (primary at every rung): allow ⟺ peer ∈ loopback AND no forwarding
 * headers. XFF is a fail-closed *disqualifier* — spoofing can only deny.
 * `remoteAddr` undefined → deny (fail-closed, §11.3). Non-loopback → masked
 * 404. Residue (documented boundary): header-stripping proxies, malicious
 * local processes. */
export const loopbackGuard: Middleware = (request) => {
  const addr = request.remoteAddr;
  const loopback = addr !== undefined &&
    (addr.hostname === "::1" || /^127\.0\.0\.1$/.test(addr.hostname) ||
      /^127\./.test(addr.hostname));
  if (!loopback) return masked404(request);
  if (
    request.headers.has("forwarded") ||
    request.headers.has("x-forwarded-for") ||
    request.headers.has("x-real-ip")
  ) {
    return masked404(request);
  }
};

function masked404(_request: PathfinderRequest): Response {
  return Response.json(NOT_FOUND, { status: 404 });
}

export const status404: Handler = () =>
  Response.json(NOT_FOUND, { status: 404 });

export const status405: Handler = (_request, context) => {
  const miss = context.miss;
  const allowed = miss?.kind === "method-miss"
    ? allowedMethods(miss.allowed)
    : "";
  return Response.json(
    { detail: "Method Not Allowed" },
    { status: 405, headers: allowed ? { allow: allowed } : undefined },
  );
};

export const status204: Handler = (_request, context) => {
  const miss = context.miss;
  const allowed = miss?.kind === "method-miss"
    ? allowedMethods(miss.allowed)
    : "";
  return new Response(null, {
    status: 204,
    headers: allowed ? { allow: allowed } : undefined,
  });
};

export const status500: Handler = () =>
  Response.json({ detail: "Internal Server Error" }, { status: 500 });

export const status413: Handler = () =>
  Response.json({ detail: "Payload Too Large" }, { status: 413 });

/** `/_status/` ops face: manifest JSON + health. The manifest getter is
 * injected at registration (Layer 0 is programmatic; context.app stays the
 * APP's data, not pathfinder's). */
export function statusManifest(getManifest: () => unknown): Handler {
  return () => getManifest();
}

export const statusHealth: Handler = () => ({ status: "ok" });

function methodEntry(
  pattern: string,
  method: string,
  handler: Handler,
): Entry {
  const dir = pattern === "/" ? "" : pattern;
  return {
    kind: "method",
    layer: 0,
    root: "pathfinder",
    file: `layer0${pattern}/<synthetic>`,
    method,
    pattern,
    dir,
    mod: { default: handler },
  };
}

function statusEntry(code: number): Entry {
  const handlers: Record<number, Handler> = {
    204: status204,
    404: status404,
    405: status405,
    413: status413,
    500: status500,
  };
  return {
    kind: "status",
    layer: 0,
    root: "pathfinder",
    file: `layer0/${code}.ts`,
    code,
    dir: "",
    mod: { default: handlers[code] },
  };
}

/** Layer-0 entries: the four(+413) outcome renderers, the `/_status/` guard,
 * manifest and health routes. */
export function layer0Entries(getManifest: () => unknown): Entry[] {
  return [
    statusEntry(404),
    statusEntry(405),
    statusEntry(204),
    statusEntry(500),
    statusEntry(413),
    {
      kind: "middleware",
      layer: 0,
      root: "pathfinder",
      file: "layer0/_status/10-loopback.ts",
      dir: "/_status",
      name: "10-loopback",
      mod: { default: loopbackGuard },
    },
    methodEntry("/_status", "GET", statusManifest(getManifest)),
    methodEntry("/_status/health", "GET", statusHealth),
  ];
}
