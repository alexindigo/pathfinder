import { record } from "../../../../../recorder.ts";

export default function messages(): Response {
  record("messages");
  return new Response("messages-body");
}
