import { record } from "../../../../recorder.ts";

export default function download(): Response {
  record("dl-endpoint");
  return new Response("dl-body");
}
