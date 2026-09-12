import { record } from "../../../../../recorder.ts";

export default function docsV1(): Response {
  record("v1-handler");
  return new Response("docs-v1-body");
}
