// SPDX-License-Identifier: LGPL-3.0-only

// Layer 0 outcome renderer: 405 method-miss (verb ≠ OPTIONS). Allow derives
// from the leaf map delivered with the miss.

import { allowedMethods } from "../http.ts";
import type { Handler } from "../router.ts";

export default ((_request, context) => {
  const miss = context.miss;
  const allowed = miss?.kind === "method-miss"
    ? allowedMethods(miss.allowed)
    : "";
  return Response.json(
    { detail: "Method Not Allowed" },
    { status: 405, headers: allowed ? { allow: allowed } : undefined },
  );
}) satisfies Handler;
