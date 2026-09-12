// SPDX-License-Identifier: LGPL-3.0-only

// Body size limits (#45): the meta key holds a plain byte number; exported
// constants are honest binary names. One counting transform guards both
// consumption styles (accessors and .stream); 413 joins the outcome map.

/** One kibibyte (1024 bytes) — body-limit arithmetic. */
export const KiB = 1024;
/** One mebibyte — body-limit arithmetic (`10 * MiB`). */
export const MiB = 1024 * KiB;
/** One gibibyte — body-limit arithmetic. */
export const GiB = 1024 * MiB;

/** Mid-stream / pre-parse signal that the request body crossed its limit.
 * Maps to the 413 outcome (subtree `413.ts` customizes). */
export class BodyLimitError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds the ${maxBytes}-byte limit`);
    this.name = "BodyLimitError";
  }
}

export function limitTransform(
  maxBytes: number,
): TransformStream<Uint8Array, Uint8Array> {
  let count = 0;
  return new TransformStream({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > maxBytes) {
        controller.error(new BodyLimitError(maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
