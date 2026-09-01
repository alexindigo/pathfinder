// SPDX-License-Identifier: LGPL-3.0-only

// Layer 0 outcome renderer: 500 (handler threw). Internals never leaked —
// the thrown value is already logged server-side by the dispatch loop.

import type { Handler } from "../router.ts";

export default (() =>
  Response.json({ detail: "Internal Server Error" }, {
    status: 500,
  })) satisfies Handler;
