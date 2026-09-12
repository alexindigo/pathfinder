// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The body face (`./body`): `parseJson` convenience,
 * `ParseError`, body-limit constants, and the request-body view.
 *
 * @module
 */
import type { PathfinderRequest } from "./router.ts";

export { BodyLimitError, GiB, KiB, MiB } from "./body_limit.ts";
export type { PathfinderBody } from "./router.ts";

/** Thrown by {@linkcode parseJson} when the request body is not valid JSON —
 * a distinct, catchable type so a handler can map a client fault to its own
 * shaped response. The framework default stays: uncaught parse errors map
 * to the 500 outcome by design (see docs/error-shapes.md). */
export class ParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ParseError";
  }
}

/** Endpoint-side parse convenience: `request.body.json()` with
 * `SyntaxError` wrapped into {@linkcode ParseError}. Other errors (guard
 * violations, body limits) pass through untouched.
 *
 * ```ts
 * import { json, parseJson, ParseError } from "@pathfinder/pathfinder/body";
 *
 * export default async (request) => {
 *   try {
 *     // `await` matters: a bare `return parseJson(request)` would skip
 *     // the catch (the promise rejection never enters the try block).
 *     return await parseJson(request);
 *   } catch (error) {
 *     if (error instanceof ParseError) {
 *       return json({ errcode: "M_NOT_JSON", error: "Content not JSON." }, {
 *         status: 400,
 *       });
 *     }
 *     throw error;
 *   }
 * };
 * ```
 */
export async function parseJson(request: PathfinderRequest): Promise<unknown> {
  try {
    return await request.body.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ParseError("request body is not valid JSON", { cause: error });
    }
    throw error;
  }
}
