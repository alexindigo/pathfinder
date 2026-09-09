// SPDX-License-Identifier: LGPL-3.0-only

// timing() — Server-Timing-style header via post-fn. The framework strips a
// falsified Content-Length itself (causal knowledge in materialize); the
// semantic header belongs to this middleware.

import type { Middleware } from "../router.ts";

/** Server-Timing middleware factory — stamps
 * `server-timing: total;dur=<ms>` on every response it rides.
 *
 * ```ts
 * // 00-timing.ts:
 * import { timing } from "@pathfinder/pathfinder";
 * export default timing();
 * ```
 */
export function timing(): Middleware {
  return () => {
    const start = performance.now();
    return (response) => {
      const ms = (performance.now() - start).toFixed(1);
      response.headers.set("server-timing", `total;dur=${ms}`);
    };
  };
}
