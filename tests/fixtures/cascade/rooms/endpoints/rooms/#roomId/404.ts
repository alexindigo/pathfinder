import { record } from "../../../../recorder.ts";

export default function room404(): Response {
  record("rooms-404");
  return new Response("room-404-page", { status: 404 });
}
