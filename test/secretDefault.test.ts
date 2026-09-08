/**
 * Tests for the secret-default gate.
 *
 * Written to BREAK the gate. The Python sibling shipped eight bugs that
 * adversarial review found afterwards, and every one of them was either a
 * false positive from a name that merely looked right or a recall gap where a
 * real binding went unseen. So the cases below are weighted toward those two
 * failure modes:
 *
 *  - MUST MATCH: every spelling of an env read (`process`, `Bun`, `Deno`,
 *    `import.meta`, dotted and bracketed), SCREAMING_SNAKE keys, destructuring
 *    defaults, chained assignment, class fields, private fields, parameter
 *    defaults, object properties, schema `.default()`.
 *  - MUST NOT MATCH: the correct `?? throwIfMissing()` pattern, a `null`
 *    fallback, a non-literal fallback, bare `Key` names, a read through some
 *    other object, and a validate-after guard that already throws.
 *
 * The gate is syntax-only, so there is no program to build: each case is one
 * temporary file scanned through the `paths` narrowing, which also means the
 * `--changed` path is exercised by every single test rather than by one.
 *
 * The fixture sources are strings, never compiled, so they may contain
 * whatever they need to (undeclared `z`, undeclared helpers) — only the
 * parser ever sees them.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import type { Violation } from "../src/engine/models.ts";
import { checkSecretDefaults, SECRET_DEFAULT_CODE } from "../src/gates/secretDefault.ts";
import {
  hasUsableSuffix,
  isSecretName,
  normalizeIdentifier,
} from "../src/gates/secretDefault/names.ts";
import { DEFAULT_POLICY } from "../src/policy/policy.ts";

const SUFFIXES = DEFAULT_POLICY.secretNameSuffixes;

const root = mkdtempSync(join(tmpdir(), "kragg-secret-"));
mkdirSync(join(root, "src"), { recursive: true });

after(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;

/** Write one case file and scan exactly it. */
function scan(
  source: string,
  suffixes: readonly string[] = SUFFIXES,
): readonly Violation[] {
  counter += 1;
  const name = `src/case${String(counter)}.ts`;
  writeFileSync(join(root, name), source);
  const outcome = checkSecretDefaults({
    root,
    sourcePaths: ["src"],
    secretNameSuffixes: suffixes,
    paths: [name],
    api: ts,
  });
  if (!outcome.ok) {
    assert.fail(`gate could not run: ${outcome.message}`);
  }
  return outcome.violations;
}

function flagged(source: string, suffixes: readonly string[] = SUFFIXES): number {
  return scan(source, suffixes).length;
}

describe("secret-default: environment reads", () => {
  it("flags a nullish fallback on process.env", () => {
    const violations = scan('export const t = process.env.API_TOKEN ?? "";');
    assert.equal(violations.length, 1);
    const first = violations[0];
    assert.ok(first !== undefined);
    assert.match(first.message, /secret `API_TOKEN` silently defaults to empty/);
    assert.equal(first.code, SECRET_DEFAULT_CODE);
    assert.equal(first.line, 1);
    assert.equal(first.column, 18);
    assert.ok((first.fixHint ?? "").includes("fails loudly"));
  });

  it("flags a logical-or fallback and names the hardcoded value", () => {
    const violations = scan('export const t = process.env.API_TOKEN || "dev";');
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.message ?? "", /hardcoded fallback default \(`dev`\)/);
  });

  it("truncates a long hardcoded fallback rather than printing the credential", () => {
    const violations = scan(
      'export const t = process.env.API_TOKEN ?? "sk-live-0123456789abcdef";',
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.message ?? "", /`sk-live-0123…`/);
    assert.doesNotMatch(violations[0]?.message ?? "", /abcdef/);
  });

  it("reads the bracketed form a strict project is forced to write", () => {
    assert.equal(flagged('export const t = process.env["HMAC_SECRET"] ?? "";'), 1);
  });

  it("matches SCREAMING_SNAKE keys against PascalCase suffixes", () => {
    // The whole point of normalization: `API_KEY` must match `ApiKey`.
    assert.equal(flagged('export const t = process.env["API_KEY"] ?? "";'), 1);
    assert.equal(flagged('export const t = process.env["SIGNING_KEY"] ?? "";'), 1);
    assert.equal(flagged('export const t = process.env["private-key"] ?? "";'), 1);
  });

  it("reads Bun.env, Deno.env.get and import.meta.env", () => {
    assert.equal(flagged('export const a = Bun.env.API_TOKEN ?? "";'), 1);
    assert.equal(flagged('export const b = Deno.env.get("SIGNING_KEY") ?? "";'), 1);
    assert.equal(flagged('export const c = import.meta.env.VITE_API_TOKEN ?? "";'), 1);
  });

  it("reports an env read with a fallback exactly once", () => {
    // The declaration and the binary expression are separate nodes; only the
    // env detector may claim this site.
    assert.equal(flagged('export const apiToken = process.env.API_TOKEN ?? "";'), 1);
  });

  it("does NOT flag the correct throw-on-missing pattern", () => {
    assert.equal(
      flagged('export const t = process.env.API_TOKEN ?? requireEnv("API_TOKEN");'),
      0,
    );
    assert.equal(
      flagged("export const t = process.env.API_TOKEN ?? (() => { throw new Error(); })();"),
      0,
    );
  });

  it("does NOT flag a read with no fallback, or a null/undefined fallback", () => {
    assert.equal(flagged("export const t = process.env.API_TOKEN;"), 0);
    assert.equal(flagged("export const t = process.env.API_TOKEN ?? null;"), 0);
    assert.equal(flagged("export const t = process.env.API_TOKEN ?? undefined;"), 0);
  });

  it("does NOT flag a fallback it cannot read", () => {
    assert.equal(flagged("export const t = process.env.API_TOKEN ?? FALLBACK;"), 0);
    assert.equal(flagged("export const t = process.env.API_TOKEN ?? `${prefix}-dev`;"), 0);
  });

  it("does NOT flag a read through some other object", () => {
    // No taint analysis: `config` is not the environment.
    assert.equal(flagged('export const t = config.apiToken ?? "";'), 0);
    assert.equal(flagged('export const t = config.get("apiToken", "");'), 0);
    assert.equal(flagged('export const t = other.env.API_TOKEN ?? "";'), 0);
  });

  it("does NOT flag a computed env key", () => {
    assert.equal(flagged('export const t = process.env[keyName] ?? "";'), 0);
  });
});

describe("secret-default: the validate-after guard", () => {
  it("does NOT flag an empty fallback proven fatal by the next statement", () => {
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "";',
          "if (!apiToken) { throw new Error('API_TOKEN is required'); }",
          "export { apiToken };",
        ].join("\n"),
      ),
      0,
    );
  });

  it("accepts the equality and length spellings of the guard", () => {
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "";',
          'if (apiToken === "") throw new Error("x");',
        ].join("\n"),
      ),
      0,
    );
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "";',
          'if (apiToken.length === 0) throw new Error("x");',
        ].join("\n"),
      ),
      0,
    );
  });

  it("still flags a NON-EMPTY fallback, because the guard can never fire", () => {
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "dev";',
          'if (!apiToken) { throw new Error("x"); }',
        ].join("\n"),
      ),
      1,
    );
  });

  it("still flags when the guard logs instead of throwing", () => {
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "";',
          "if (!apiToken) { console.warn('missing'); }",
        ].join("\n"),
      ),
      1,
    );
  });

  it("still flags when the guard is not the very next statement", () => {
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "";',
          "const other = 1;",
          'if (!apiToken) { throw new Error("x"); }',
        ].join("\n"),
      ),
      1,
    );
  });

  it("still flags when the guard tests a different name", () => {
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "";',
          'if (!otherValue) { throw new Error("x"); }',
        ].join("\n"),
      ),
      1,
    );
  });

  it("still flags when the throw is nested inside another branch", () => {
    assert.equal(
      flagged(
        [
          'const apiToken = process.env.API_TOKEN ?? "";',
          'if (!apiToken) { if (strict) { throw new Error("x"); } }',
        ].join("\n"),
      ),
      1,
    );
  });
});

describe("secret-default: bindings", () => {
  it("flags declarations, class fields and private fields", () => {
    assert.equal(flagged('export const apiToken = "";'), 1);
    assert.equal(flagged('export let signingKey: string = "";'), 1);
    assert.equal(flagged('export class C { private apiToken = ""; }'), 1);
    assert.equal(flagged('export class C { #apiToken = ""; }'), 1);
    assert.equal(flagged('export class C { static readonly apiSecret = ""; }'), 1);
  });

  it("flags assignment to a field, a member and a bracketed member", () => {
    assert.equal(
      flagged('export class C { reset() { this.apiToken = ""; } }'),
      1,
    );
    assert.equal(flagged('cfg["apiToken"] = "";'), 1);
    assert.equal(flagged('cfg.apiToken ??= "";'), 1);
    assert.equal(flagged('cfg.apiToken ||= "";'), 1);
  });

  it("flags BOTH targets of a chained assignment", () => {
    // The recall gap review found in the Python original.
    const violations = scan('apiToken = sessionToken = "";');
    assert.equal(violations.length, 2);
    assert.deepEqual(
      violations.map((violation) => violation.message).sort(),
      [
        "secret `apiToken` silently defaults to empty",
        "secret `sessionToken` silently defaults to empty",
      ],
    );
  });

  it("flags object-literal properties, including quoted keys", () => {
    assert.equal(flagged('export const c = { apiKey: "" };'), 1);
    assert.equal(flagged('export const c = { "api-key": "" };'), 1);
  });

  it("flags parameter defaults on functions, arrows and methods", () => {
    assert.equal(flagged('export function f(signingKey = "") { return signingKey; }'), 1);
    assert.equal(flagged('export const f = (signingKey = "") => signingKey;'), 1);
    assert.equal(flagged('export class C { m(apiSecret = "") { return apiSecret; } }'), 1);
  });

  it("flags destructuring defaults, renamed or not", () => {
    assert.equal(flagged('const { apiSecret = "" } = process.env;'), 1);
    assert.equal(flagged('const { API_TOKEN: t = "" } = process.env;'), 1);
    assert.equal(flagged('function f({ apiKey = "" }) { return apiKey; }'), 1);
    assert.equal(flagged('const [apiToken = ""] = parts;'), 1);
  });

  it("flags a substitution-free template but not one with a substitution", () => {
    assert.equal(flagged("export const apiToken = ``;"), 1);
    assert.equal(flagged("export const apiToken = `${prefix}`;"), 0);
  });

  it("flags a schema builder default anywhere in the chain", () => {
    assert.equal(flagged('export const schema = { apiKey: z.string().default("") };'), 1);
    assert.equal(
      flagged('export const apiToken = z.string().default("").optional();'),
      1,
    );
    // Non-literal argument: nothing to read, nothing reported.
    assert.equal(flagged("export const apiToken = z.string().default(fallback);"), 0);
    // `.catch()` is deliberately NOT recognised; documented as a miss.
    assert.equal(flagged('export const apiToken = z.string().catch("");'), 0);
  });

  it("does NOT flag a non-literal initializer", () => {
    assert.equal(flagged("export const apiToken = readToken();"), 0);
    assert.equal(flagged("export const apiToken = other;"), 0);
    assert.equal(flagged("export let apiToken: string;"), 0);
  });

  it("does NOT flag shorthand properties or bindings with no default", () => {
    assert.equal(flagged("export const c = { apiKey };"), 0);
    assert.equal(flagged("const { apiSecret } = process.env;"), 0);
    assert.equal(flagged("export function f(signingKey: string) { return signingKey; }"), 0);
  });
});

describe("secret-default: name matching", () => {
  it("does NOT treat a bare `key` as a secret", () => {
    // The reason the policy excludes bare `Key`: these are not credentials.
    assert.equal(flagged('export const sortKey = "";'), 0);
    assert.equal(flagged('export const cacheKey = "";'), 0);
    assert.equal(flagged('export const t = process.env["SORT_KEY"] ?? "";'), 0);
  });

  it("does NOT match a suffix that is not at the end of the name", () => {
    assert.equal(flagged('export const tokenizer = "";'), 0);
    assert.equal(flagged('export const secretariat = "";'), 0);
    assert.equal(flagged('export const passwordPrompt = "";'), 0);
  });

  it("matches the bare form of a suffix", () => {
    assert.equal(flagged('export const secret = "";'), 1);
    assert.equal(flagged('export const password = "";'), 1);
  });

  it("does NOT strip trailing digits — a documented recall gap", () => {
    assert.equal(flagged('export const t = process.env["API_KEY_2"] ?? "";'), 0);
  });

  it("honours a narrowed suffix list", () => {
    assert.equal(flagged('export const apiToken = "";', ["Password"]), 0);
    assert.equal(flagged('export const dbPassword = "";', ["Password"]), 1);
  });
});

describe("secret-default: suppression and outcome", () => {
  it("honours a trailing `// kragg: ignore`", () => {
    assert.equal(flagged('export const apiToken = ""; // kragg: ignore'), 0);
    assert.equal(
      flagged('export const t = process.env.API_TOKEN ?? ""; /* kragg: ignore */'),
      0,
    );
  });

  it("honours a marker on any line the finding spans", () => {
    assert.equal(
      flagged(
        [
          "export const t =",
          "  process.env.API_TOKEN ??",
          '  ""; // kragg: ignore',
        ].join("\n"),
      ),
      0,
    );
  });

  it("does not accept a near-miss spelling of the marker", () => {
    assert.equal(flagged('export const apiToken = ""; // kragg:ignore'), 1);
    assert.equal(flagged('export const apiToken = ""; // KRAGG: IGNORE'), 1);
  });

  it("finds the same violation on the whole-project walk", () => {
    const whole = mkdtempSync(join(tmpdir(), "kragg-secret-walk-"));
    mkdirSync(join(whole, "src", "config"), { recursive: true });
    writeFileSync(
      join(whole, "src", "config", "env.ts"),
      'export const apiToken = process.env.API_TOKEN ?? "";\n',
    );
    const outcome = checkSecretDefaults({
      root: whole,
      sourcePaths: ["src", "lib"],
      secretNameSuffixes: SUFFIXES,
      api: ts,
    });
    rmSync(whole, { recursive: true, force: true });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.violations.length, 1);
    assert.equal(outcome.violations[0]?.file, "src/config/env.ts");
  });

  it("FAILS CLOSED when no suffix can ever match", () => {
    const outcome = checkSecretDefaults({
      root,
      sourcePaths: ["src"],
      secretNameSuffixes: ["", "   "],
      api: ts,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.match(outcome.message, /secret_name_suffixes is empty/);
  });

  it("FAILS CLOSED when no configured source path exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "kragg-secret-empty-"));
    const outcome = checkSecretDefaults({
      root: empty,
      sourcePaths: ["src"],
      secretNameSuffixes: SUFFIXES,
      api: ts,
    });
    rmSync(empty, { recursive: true, force: true });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.match(outcome.message, /scanned no files/);
  });

  it("is silent, not failed, when a narrowed scan matches nothing", () => {
    const outcome = checkSecretDefaults({
      root,
      sourcePaths: ["src"],
      secretNameSuffixes: SUFFIXES,
      paths: ["README.md", "other/elsewhere.ts", "src/missing.ts"],
      api: ts,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.violations.length, 0);
  });

  it("drops a narrowed path outside the configured source paths", () => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "seed.ts"), 'export const apiToken = "";\n');
    const outcome = checkSecretDefaults({
      root,
      sourcePaths: ["src"],
      secretNameSuffixes: SUFFIXES,
      paths: ["scripts/seed.ts"],
      api: ts,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.violations.length, 0);
  });
});

/**
 * The matcher itself, including the two inputs the gate above cannot show it.
 *
 * A POLICY TYPO IS THE FAILURE MODE THAT MATTERS HERE, in both directions: an
 * empty suffix that matched everything would turn every identifier in the repo
 * into a credential, and an identifier that normalizes to nothing must not be
 * made to match a suffix by the empty-string `endsWith` rule. Both would be
 * discovered as a wall of noise on somebody else's repository, so both are
 * pinned on the function.
 */
describe("isSecretName", () => {
  it("matches across every casing and separator convention", () => {
    for (const name of ["API_KEY", "api-key", "apiKey", "ApiKey", "api.key"]) {
      assert.equal(isSecretName(name, ["ApiKey"]), true, name);
    }
    assert.equal(normalizeIdentifier("API_KEY"), "apikey");
  });

  it("answers false for an identifier that normalizes to nothing", () => {
    // `_`, `$` and `#` carry no alphanumerics, so there is no name left to
    // compare. Without the early return, `"".endsWith("")` would be true for a
    // policy that also carried an empty suffix.
    assert.equal(isSecretName("_", ["ApiKey"]), false);
    assert.equal(isSecretName("", ["ApiKey"]), false);
    assert.equal(isSecretName("$$_$$", [""]), false);
    assert.equal(isSecretName("__", ["", "Secret"]), false);
  });

  it("skips an empty suffix instead of letting it match everything", () => {
    assert.equal(isSecretName("sortOrder", [""]), false);
    assert.equal(isSecretName("sortOrder", ["_", "-"]), false);
    assert.equal(isSecretName("sortOrder", ["", "SortOrder"]), true);
  });

  it("reports whether a suffix list can ever match anything", () => {
    assert.equal(hasUsableSuffix(["ApiKey"]), true);
    assert.equal(hasUsableSuffix([]), false);
    assert.equal(hasUsableSuffix(["", "_", "--"]), false);
  });
});
