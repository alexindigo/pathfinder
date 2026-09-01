// SPDX-License-Identifier: LGPL-3.0-only

// Layer 0 outcome renderer: 413 body limit (map grows additively per §10.5).

import type { Handler } from "../router.ts";

export default (() =>
  Response.json({ detail: "Payload Too Large" }, {
    status: 413,
  })) satisfies Handler;
