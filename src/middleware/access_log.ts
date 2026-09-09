// SPDX-License-Identifier: LGPL-3.0-only

// accessLog() — access log built on `request.completed` for honest
// time-to-last-byte and disposition (ledger §11.3 rider): the post-fn line
// reports header-sent facts; the `completed` continuation reports what
// actually happened on the wire (sent vs aborted).

import type { Middleware } from "../router.ts";

/** Access-log middleware factory. One line when the response head ships,
 * one disposition line when the response has fully left (or died):
 *
 * ```
 * [pathfinder] GET /path 200 +12.3ms
 * [pathfinder] GET /path sent 45.6ms    (time-to-last-byte)
 * [pathfinder] GET /path aborted 30.1ms
 * ```
 *
 * Without `request.completed` (host without the info object) only the
 * head line ships, disposition `unknown`.
 *
 * ```ts
 * // 00-access-log.ts:
 * import { accessLog } from "@pathfinder/pathfinder";
 * export default accessLog();
 * ```
 */
export function accessLog(): Middleware {
  return (request) => {
    const start = performance.now();
    return (response) => {
      const head = (performance.now() - start).toFixed(1);
      console.log(
        `[pathfinder] ${request.method} ${request.path} ${response.status} +${head}ms`,
      );
      const done = (disposition: string) => {
        const total = (performance.now() - start).toFixed(1);
        console.log(
          `[pathfinder] ${request.method} ${request.path} ${disposition} ${total}ms`,
        );
      };
      if (request.completed === undefined) {
        done("unknown");
        return;
      }
      request.completed
        .then(() => done("sent"))
        .catch(() => done("aborted"));
    };
  };
}
