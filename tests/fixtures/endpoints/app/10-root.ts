export default function rootMark(
  _request: unknown,
  context: { state: Record<string, unknown> },
): void {
  context.state.rootMark = true;
}
