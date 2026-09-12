import { notFound, record } from "../../../../recorder.ts";

export default function download(): void {
  record("files-endpoint");
  throw notFound();
}
