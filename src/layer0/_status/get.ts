// SPDX-License-Identifier: LGPL-3.0-only

// `/_status/` ops face: the effective file table of this router instance.
// The manifest arrives through context._manifest() — a file module cannot
// close over the router (Amendment 1).

import type { Handler } from "../../router.ts";

export default ((_request, context) => context._manifest()) satisfies Handler;
