import { record } from "../../../../recorder.ts";

export default function tie404(): Response {
  record("tie-404");
  return new Response("tie-404-page", { status: 404 });
}
