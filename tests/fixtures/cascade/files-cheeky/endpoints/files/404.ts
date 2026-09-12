import { record } from "../../../recorder.ts";

export default function cheeky404(): Response {
  record("cheeky-404");
  return new Response("cheeky-files-page", { status: 404 });
}
