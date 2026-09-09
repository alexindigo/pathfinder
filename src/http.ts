// SPDX-License-Identifier: LGPL-3.0-only

// Engine-internal HTTP contract: HttpError, result coercion (the handler
// return contract), and the allowedMethods helper. Not public API — the
// public surface is the root module plus the namespaced subpaths
// (./response, ./middleware, ./body, ./grammar, ./loader).

import { text } from "./response.ts";

/** Thrown by handlers/middleware to short-circuit to a status + `{"detail"}`
 * JSON body (globnotes/FastAPI shape). Optional headers ride along (e.g.
 * `WWW-Authenticate` on 401). */
export class HttpError extends Error {
  status: number;
  detail: unknown;
  headers?: HeadersInit;

  constructor(status: number, detail?: unknown, headers?: HeadersInit) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** Runtime contract violation (internal) — a handler/middleware returned a
 * value the contract excludes. Renders as a loud 500. */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}

/** `Allow` header value from a set of methods (uppercase, sorted). */
export function allowedMethods(methods: Iterable<string>): string {
  return [...methods].map((m) => m.toUpperCase()).sort().join(", ");
}

// The handler return contract — coercion never interprets intent;
// representable values map to their platform-obvious representation; the
// unrepresentable refuses loudly. Type-switch order is correctness-critical:
// Response → string → ReadableStream (streams ARE async-iterable) →
// async-iterable → binary (before generic object) → array/object → violation.

/** Coerces a handler return value to a Response. Throws ContractViolation on
 * contract violations (null/undefined/primitives/everything unrepresentable). */
export function coerceResult(result: unknown): Response {
  if (result instanceof Response) return result; // identity branch
  if (typeof result === "string") return text(result);
  if (result instanceof ReadableStream) return new Response(result);
  if (
    typeof result === "object" && result !== null &&
    Symbol.asyncIterator in (result as Record<symbol, unknown>)
  ) {
    return new Response(
      ReadableStream.from(result as AsyncIterable<Uint8Array>),
    );
  }
  if (typeof result === "object" && result !== null) {
    if (result instanceof Blob) {
      return new Response(result, {
        headers: { "content-type": result.type || "application/octet-stream" },
      });
    }
    if (
      result instanceof Uint8Array || result instanceof ArrayBuffer ||
      ArrayBuffer.isView(result)
    ) {
      return new Response(result as unknown as BodyInit, {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return Response.json(result); // plain object / array
  }
  // null, undefined, number, boolean, bigint, symbol, function — excluded
  // from the return type; runtime loud 500.
  throw new ContractViolation(
    `handler return contract violation: ${
      result === null ? "null" : typeof result
    } is not a representable return value`,
  );
}
