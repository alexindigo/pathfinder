import { record, unauthorized } from "../../../../recorder.ts";

export default function auth(
  request: { headers: Headers },
): void | Response {
  record("dl-auth");
  if (request.headers.get("authorization") === null) {
    return unauthorized();
  }
}
