// SPDX-License-Identifier: LGPL-3.0-only

/**
 * The response face (`./response`): response factories
 * (`json`, `html`, `text`, `redirect`) and the post-fn
 * `ResponseView` type.
 *
 * @module
 */
export type { ResponseView } from "./router.ts";

/** JSON response; auto Content-Length via the platform. */
export function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

/** HTML response (platform default would be text/plain). */
export function html(body: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  return new Response(body, { ...init, headers });
}

/** Plain-text response. */
export function text(body: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/plain;charset=UTF-8");
  }
  return new Response(body, { ...init, headers });
}

/** Redirect — accepts relative URLs (platform `Response.redirect` rejects
 * them). Defaults to 302 like the platform. */
export function redirect(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}
