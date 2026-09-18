export function unwrapResult<T>(result: { data?: T; error?: unknown; response: Response }): NonNullable<T> {
  if (result.error || !result.response.ok || result.data == null) throw new Error("OpenCode operation failed");
  return result.data;
}
