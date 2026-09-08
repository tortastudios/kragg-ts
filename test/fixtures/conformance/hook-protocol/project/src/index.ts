/**
 * One real violation, so the blocking path has something honest to block on.
 *
 * `apiKey` defaults to the empty string, which is exactly the silent fallback
 * `secret-default` exists to find.
 */
export function sign(payload: string, apiKey = ""): string {
  return `${payload}:${apiKey}`;
}
