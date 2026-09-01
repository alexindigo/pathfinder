// SPDX-License-Identifier: LGPL-3.0-only

// Health probe (consumer: globnotes healthcheck).

import type { Handler } from "../../../router.ts";

export default (() => ({ status: "ok" })) satisfies Handler;
