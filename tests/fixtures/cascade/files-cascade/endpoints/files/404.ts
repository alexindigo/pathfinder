import { record } from "../../../recorder.ts";

export default function files404(): Response {
  record("files-404");
  return new Response("cascade-files-page", { status: 404 });
}
