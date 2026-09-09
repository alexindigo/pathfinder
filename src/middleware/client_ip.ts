// SPDX-License-Identifier: LGPL-3.0-only

// clientIp() — client IP into context.state, XFF handling under the
// loopback guard's fail-closed discipline: a peer that is not on the trust
// list can never influence the extracted IP (spoofing can only deny, never
// grant). With no trust list configured, XFF is never honored.

import type { Middleware } from "../router.ts";

/** Options for {@linkcode clientIp}.
 *
 * ```ts
 * // 10-client-ip.ts — behind a known reverse proxy:
 * import { clientIp } from "@pathfinder/pathfinder";
 * export default clientIp({ trust: ["127.0.0.1", "::1"] });
 *
 * // Typing the state slice (module augmentation, the one idiom):
 * // declare module "@pathfinder/pathfinder" {
 * //   interface State { clientIp?: string }
 * // }
 * ```
 */
export interface ClientIpOptions {
  /** Peers allowed to speak for the client via `x-forwarded-for` (exact
   * hostnames as seen in `request.remoteAddr.hostname`). Any other peer's
   * XFF header is ignored — spoofing can only deny. Default: none. */
  trust?: string[];
  /** The state field to write. Default `"clientIp"`. */
  as?: string;
}

/** Client-IP middleware factory. Writes the client IP to
 * `context.state.clientIp`: the immediate peer's hostname, or — when the
 * immediate peer is trusted and sent `x-forwarded-for` — the rightmost
 * untrusted entry of that list. Undefined when the host provides no
 * `remoteAddr` (e.g. unix-socket serving). */
export function clientIp(options: ClientIpOptions = {}): Middleware {
  const trust = new Set(options.trust ?? []);
  const field = options.as ?? "clientIp";
  return (request, context) => {
    const peer = request.remoteAddr;
    if (peer === undefined) return;
    let ip = peer.hostname;
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded !== null && trust.has(peer.hostname)) {
      // Walk right-to-left, skipping trusted proxies; the first untrusted
      // entry is the client. All-trusted chains fall back to the leftmost
      // entry. An untrusted peer never gets this far (guard above).
      const entries = forwarded.split(",").map((e) => e.trim());
      let chosen: string | null = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!trust.has(entries[i])) {
          chosen = entries[i];
          break;
        }
      }
      ip = chosen ?? entries[0];
    }
    (context.state as Record<string, unknown>)[field] = ip;
  };
}
