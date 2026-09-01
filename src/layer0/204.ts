// SPDX-License-Identifier: LGPL-3.0-only

// Layer 0 outcome renderer: 204 method-miss (verb = OPTIONS) — the capability
// reflection. Its own file per the §8.3 ruling.

import { allowedMethods } from "../http.ts";
import type { Handler } from "../router.ts";

export default ((_request, context) => {
  const miss = context.miss;
  const allowed = miss?.kind === "method-miss"
    ? allowedMethods(miss.allowed)
    : "";
  return new Response(null, {
    status: 204,
    headers: allowed ? { allow: allowed } : undefined,
  });
}) satisfies Handler;
