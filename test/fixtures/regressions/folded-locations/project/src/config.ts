/**
 * The SAME-FILE half of the defect.
 *
 * Two secrets with the same name, in one file, at two different lines. They
 * produce the identical `(code, message)` pair, so the old dedupe folded the
 * second one into the first one's prose — `… (+1 more at src/config.ts:27:18)`
 * — and the payload carried one `line` where two lines had been flagged. A
 * consumer working from `file` and `line` had no way to reach the second.
 *
 * `process` is declared locally rather than pulled in from `@types/node`: the
 * fixture must have exactly the findings it is about, and an unresolved global
 * would add two `tsc` violations of its own.
 */

interface Environment {
  readonly env: Record<string, string | undefined>;
}

declare const process: Environment;

export function readPrimary(): string {
  const apiKey = process.env["API_KEY"] || "";
  return apiKey;
}

export function readFallback(): string {
  const apiKey = process.env["API_KEY"] || "";
  return apiKey.trim();
}
