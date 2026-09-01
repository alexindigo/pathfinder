// SPDX-License-Identifier: LGPL-3.0-only

// Guard (primary at every rung): allow ⟺ peer ∈ loopback AND no forwarding
// headers. XFF is a fail-closed *disqualifier* — spoofing can only deny.
// `remoteAddr` undefined → deny (fail-closed). Non-loopback →
// masked 404. Residue (documented boundary): header-stripping proxies,
// malicious local processes.

import type { Middleware, PathfinderRequest } from "../../router.ts";

const NOT_FOUND = { detail: "Not Found" } as const;

function masked404(_request: PathfinderRequest): Response {
  return Response.json(NOT_FOUND, { status: 404 });
}

export default ((request) => {
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
}) satisfies Middleware;
