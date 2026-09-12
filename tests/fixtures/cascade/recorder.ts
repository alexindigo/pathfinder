// Shared recorder for the cascade integration matrix. Lives OUTSIDE every
// fixture tree (never walked by the loader — the trees are subdirectories);
// fixture files import it relatively to prove who ran and in what order.
import { HttpError } from "../../../src/http.ts";

export const log: string[] = [];

export function reset(): void {
  log.length = 0;
}

export function record(tag: string): void {
  log.push(tag);
}

/** Auth middleware short-circuit: a 401 Response (middleware pre-phase). */
export function unauthorized(): Response {
  return new Response(
    JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/** Endpoint-side not-found: the throw idiom. Under the always-dict rule the
 * branch's own 404 page renders when the app shipped one; without a page
 * the body renders verbatim. */
export function notFound(): HttpError {
  return new HttpError(404, "nope");
}
