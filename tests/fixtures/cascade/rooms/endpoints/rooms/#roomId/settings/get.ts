import { record } from "../../../../../recorder.ts";

export default function settings(): Response {
  record("settings");
  return new Response("settings-body");
}
