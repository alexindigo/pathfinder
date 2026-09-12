import { record } from "../../../../recorder.ts";

export default function inner404(): Response {
  record("inner-404");
  return new Response("inner-files-page", { status: 404 });
}
