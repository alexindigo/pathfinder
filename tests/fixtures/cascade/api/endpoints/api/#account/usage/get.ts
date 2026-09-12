import { record } from "../../../../../recorder.ts";

export default function usage(): Response {
  record("usage-handler");
  return new Response("usage-body");
}
