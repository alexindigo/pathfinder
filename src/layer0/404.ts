// SPDX-License-Identifier: LGPL-3.0-only

// Layer 0 outcome renderer: 404 no-match. Vacuum fallback elsewhere renders
// a bare status; this file gives the default a FastAPI-compatible body.

import type { Handler } from "../router.ts";

export default (() =>
  Response.json({ detail: "Not Found" }, { status: 404 })) satisfies Handler;
