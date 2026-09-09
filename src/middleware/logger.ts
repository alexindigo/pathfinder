// SPDX-License-Identifier: LGPL-3.0-only

// logger() — one request log line per request: method, path, status, ms.

import type { Middleware } from "../router.ts";

/** Request-logging middleware factory.
 *
 * ```ts
 * // 00-logger.ts:
 * import { logger } from "@pathfinder/pathfinder";
 * export default logger();
 * ```
 */
export function logger(): Middleware {
  return (request) => {
    const start = performance.now();
    return (response) => {
      const ms = (performance.now() - start).toFixed(1);
      console.log(
        `[pathfinder] ${request.method} ${request.path} ${response.status} ${ms}ms`,
      );
    };
  };
}
