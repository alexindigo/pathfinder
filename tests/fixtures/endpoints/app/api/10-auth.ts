export default function auth(
  _request: unknown,
  context: { state: Record<string, unknown> },
): void {
  context.state.auth = true;
}
