// SPDX-License-Identifier: LGPL-3.0-only

// compress() — response compression as a plain response-path middleware:
// `view.pipeThrough(CompressionStream)` + its own semantic headers. The
// framework strips the falsified Content-Length at materialization (the
// causal-knowledge rule). Opt-in by file — no implicit compression anywhere;
// the mount IS the filter. No-op on 101 upgrades (materialize's guard drops
// the queued transform with a debug log) and on bodies that cannot be
// re-framed (204/304, empty, already-encoded).

import type { Middleware } from "../router.ts";

/** Options for {@linkcode compress}.
 *
 * ```ts
 * // 10-compress.ts inside an API subtree:
 * import { compress } from "@pathfinder/pathfinder";
 * export default compress();
 * ```
 */
export interface CompressOptions {
  /** Encodings offered, in preference order — the first one the client's
   * `accept-encoding` allows wins. Default `["gzip"]`. */
  encodings?: ("gzip" | "deflate" | "deflate-raw")[];
}

const NO_BODY_STATUSES = new Set([204, 304, 101]);

/** Accept-encoding check: does the header allow `encoding` with q != 0? */
function accepts(acceptEncoding: string, encoding: string): boolean {
  for (const part of acceptEncoding.split(",")) {
    const [token, ...params] = part.trim().split(";").map((s) => s.trim());
    if (token.toLowerCase() !== encoding && token !== "*") continue;
    const q = params.find((p) => p.startsWith("q="));
    if (q === undefined || parseFloat(q.slice(2)) > 0) return true;
  }
  return false;
}

/** Compression middleware factory. Queues a CompressionStream on the
 * response body when the client accepts one of the offered encodings and
 * the response carries a fresh body; sets `content-encoding` and merges
 * `vary: accept-encoding`. */
export function compress(options: CompressOptions = {}): Middleware {
  const encodings = options.encodings ?? ["gzip"];
  return (request) => {
    const acceptEncoding = request.headers.get("accept-encoding") ?? "";
    const negotiated = encodings.find((e) => accepts(acceptEncoding, e));
    if (negotiated === undefined) return;
    return (response) => {
      // No-op rules: no body to re-frame, client or an upstream already
      // encoded it, or the response is a bare status.
      if (
        NO_BODY_STATUSES.has(response.status) ||
        response._raw.body === null ||
        response.headers.has("content-encoding")
      ) {
        return;
      }
      response.pipeThrough(new CompressionStream(negotiated));
      response.headers.set("content-encoding", negotiated);
      const vary = response.headers.get("vary") ?? "";
      const varyTokens = vary.split(",").map((t) => t.trim().toLowerCase());
      if (!varyTokens.includes("accept-encoding")) {
        response.headers.append("vary", "accept-encoding");
      }
    };
  };
}
