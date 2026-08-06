/**
 * Run metadata that every report carries: which kragg produced it, and when.
 *
 * Split out of `report.ts`, which re-exports both functions. Neither depends
 * on a report, and both are read by the journal and the CLI as well, so they
 * sit below the reporting machinery rather than inside it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cachedVersion: string | null = null;

/**
 * This package's own version, read from its package.json.
 *
 * `dist/engine/reportMeta.js` and `src/engine/reportMeta.ts` are both two
 * directories below the package root, so one relative path serves the built
 * and the type-stripped source form. Failure is not fatal: reporting
 * "unknown" beats crashing a check run over metadata.
 */
export function kraggVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }
  cachedVersion = readVersion();
  return cachedVersion;
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return declaredVersion(parsed) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The `version` field, if the manifest has one that is a string. */
function declaredVersion(manifest: unknown): string | null {
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    return null;
  }
  const version: unknown = manifest.version;
  return typeof version === "string" ? version : null;
}

/**
 * UTC timestamp to second precision.
 *
 * Formatted as `YYYY-MM-DDTHH:MM:SS+00:00` to match Python's
 * `datetime.now(UTC).isoformat(timespec="seconds")` — NOT `toISOString()`,
 * which emits milliseconds and a `Z` suffix. The two implementations write
 * to the same journal format, so this has to agree.
 */
export function utcNow(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}+00:00`;
}
