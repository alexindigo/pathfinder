import { notFound, record } from "../../../../recorder.ts";

export default function download(): void {
  record("inner-endpoint");
  throw notFound();
}
