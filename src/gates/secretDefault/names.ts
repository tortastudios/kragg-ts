/**
 * Secret-name matching for the secret-default gate.
 *
 * The Python original compares `name.lower()` against snake_case suffixes
 * (`"_secret"`), with a special case so a bare `secret` matches too. That
 * spelling does not survive the port: JavaScript identifiers are camelCase
 * (`hmacSecret`) but the environment variables they read are
 * SCREAMING_SNAKE (`HMAC_SECRET`), and one gate has to match BOTH — a
 * `process.env.API_KEY ?? ""` is the single most common form of the bug this
 * gate exists to catch, and a naive `endsWith("apikey")` misses it because of
 * the underscore.
 *
 * So names and suffixes are both normalized to bare lowercase alphanumerics
 * before comparison. `API_KEY`, `api-key`, `apiKey` and `ApiKey` all reduce to
 * `apikey`, and the policy carries one PascalCase spelling of each concept
 * instead of one per casing convention. Normalization also subsumes Python's
 * bare-form special case for free: `secret` and `hmacSecret` both end with
 * `secret`.
 *
 * Digits are kept, so `API_KEY_2` does NOT match `ApiKey`. That is a recall
 * gap, and it is deliberate: stripping trailing digits would be a guess about
 * what the author meant by them.
 */

/** Reduce an identifier to bare lowercase alphanumerics for comparison. */
export function normalizeIdentifier(name: string): string {
  return name.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
}

/**
 * True when a name ends with any configured secret suffix, casing- and
 * separator-insensitively.
 *
 * An empty suffix is skipped rather than matching everything — a policy typo
 * must not turn every identifier in the repo into a secret.
 */
export function isSecretName(name: string, suffixes: readonly string[]): boolean {
  const normalized = normalizeIdentifier(name);
  if (normalized === "") {
    return false;
  }
  return suffixes.some((entry) => {
    const suffix = normalizeIdentifier(entry);
    return suffix !== "" && normalized.endsWith(suffix);
  });
}

/** True when at least one configured suffix can ever match something. */
export function hasUsableSuffix(suffixes: readonly string[]): boolean {
  return suffixes.some((entry) => normalizeIdentifier(entry) !== "");
}
