// SPDX-License-Identifier: LGPL-3.0-only

// cors() — preflight short-circuit + always-run stamping. The always-run
// post-fn model plus the miss-chain rule (deepest-reached directory's
// middleware runs on 404/405/204 too, post-fns run even after errors) is
// exactly the machinery CORS needs: the stamp lands on every response —
// misses, errors, and WebSocket upgrades (in place, via materialize's 101
// rule) alike.

import type { Middleware } from "../router.ts";

/** Cross-origin response headers.
 *
 * ```ts
 * // 00-cors.ts — root middleware, Matrix-style open origin:
 * import { cors } from "@pathfinder/pathfinder";
 * export default cors({ origin: "*", headers: "Authorization, Content-Type" });
 * ```
 */
export interface CorsOptions {
  /** Value for `access-control-allow-origin`. Default `"*"`. */
  origin?: string;
  /** Value for `access-control-allow-methods`. Default covers the common
   * method set (stamped on preflight; stamped everywhere when provided). */
  methods?: string;
  /** Value for `access-control-allow-headers`. */
  headers?: string;
  /** Value for `access-control-max-age` (seconds), preflight only. */
  maxAge?: number;
}

const DEFAULT_METHODS = "GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS";

function isPreflight(request: { method: string; headers: Headers }): boolean {
  return request.method === "OPTIONS" &&
    request.headers.has("access-control-request-method");
}

/** CORS middleware factory. Preflight requests short-circuit in the
 * pre-phase with a 204 carrying the full CORS header set; everything else
 * gets `access-control-allow-origin` (+ methods/headers when configured)
 * stamped via an always-run post-fn. */
export function cors(options: CorsOptions = {}): Middleware {
  const origin = options.origin ?? "*";
  return (request) => {
    if (isPreflight(request)) {
      const response = new Response(null, { status: 204 });
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set(
        "access-control-allow-methods",
        options.methods ?? DEFAULT_METHODS,
      );
      if (options.headers !== undefined) {
        response.headers.set("access-control-allow-headers", options.headers);
      }
      if (options.maxAge !== undefined) {
        response.headers.set("access-control-max-age", String(options.maxAge));
      }
      return response; // pre-phase short-circuit
    }
    return (response) => {
      response.headers.set("access-control-allow-origin", origin);
      if (options.methods !== undefined) {
        response.headers.set("access-control-allow-methods", options.methods);
      }
      if (options.headers !== undefined) {
        response.headers.set("access-control-allow-headers", options.headers);
      }
    };
  };
}
