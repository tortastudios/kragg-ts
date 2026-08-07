/**
 * Package-name derivation and import-shadowing guard for `kragg new`.
 *
 * Ported from `kragg/src/kragg/naming.py`. The Python original refuses a
 * package name that collides with a stdlib module or a widely-installed
 * distribution, because the collision surfaces as an import that silently
 * resolves to the wrong code — "an error no gate can point at".
 *
 * The JavaScript analogue is narrower but sharper. Node resolves a bare
 * specifier to a builtin BEFORE it ever looks in `node_modules`, so a package
 * published as `fs` or `path` is unreachable by its own name: `import "fs"`
 * inside it returns the builtin. `node:`-prefixed specifiers are builtin-only
 * by definition. Beyond the builtins, taking a name already occupied by a very
 * common dependency guarantees a collision the moment both end up in one
 * dependency tree — and, for anything published, guarantees the name is taken.
 *
 * On top of shadowing this module enforces the npm registry's own name rules,
 * which are stricter than the Python identifier rules and which `npm publish`
 * will reject on much later. Failing at scaffold time is the cheap failure.
 */

import { builtinModules } from "node:module";

/**
 * Top-level names of very common npm packages.
 *
 * Deliberately SHORT and curated, mirroring `COMMON_DISTRIBUTIONS` in the
 * Python original. This is not an attempt to mirror the registry — a long list
 * would refuse names that are perfectly fine while still missing most of it.
 * The point is to catch the handful of names an agent is actually likely to
 * reach for when naming a project in this ecosystem.
 */
export const COMMON_PACKAGES: ReadonlySet<string> = new Set<string>([
  "axios",
  "commander",
  "eslint",
  "esbuild",
  "express",
  "fastify",
  "fastmcp",
  "hono",
  "kragg",
  "lodash",
  "next",
  "node",
  "npm",
  "oxlint",
  "pnpm",
  "prettier",
  "react",
  "rollup",
  "svelte",
  "typescript",
  "vite",
  "vitest",
  "vue",
  "webpack",
  "zod",
]);

/** Every Node builtin, with and without the `node:` prefix. */
const BUILTINS: ReadonlySet<string> = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/** npm's hard cap on a package name, scope included. */
const MAX_NAME_LENGTH = 214;

/** Characters npm permits in a name segment. Everything else is replaced. */
const UNSAFE = /[^a-z0-9._~-]+/g;

/**
 * Return a valid npm package name derived from a free-form project name.
 *
 * Lowercases, replaces every character npm does not permit with `-`, collapses
 * runs, and strips the leading `.`/`_` npm forbids. A scoped input keeps its
 * scope: `@Acme/My App` becomes `@acme/my-app`. An input that normalizes away
 * to nothing becomes `app`, matching the Python fallback.
 */
export function normalizePackageName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("@") && trimmed.includes("/")) {
    const slash = trimmed.indexOf("/");
    const scope = normalizeSegment(trimmed.slice(1, slash));
    const rest = normalizeSegment(trimmed.slice(slash + 1));
    return `@${scope}/${rest}`;
  }
  return normalizeSegment(trimmed);
}

/** Normalize one name segment (a scope, or an unscoped name). */
function normalizeSegment(segment: string): string {
  const cleaned = segment
    .toLowerCase()
    .replace(UNSAFE, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[.-]+$/, "");
  if (cleaned === "") {
    return "app";
  }
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/**
 * Return why a name is not a legal npm package name, or `null` if it is.
 *
 * Checked against the registry's published rules rather than a regex someone
 * remembered: length cap, no uppercase, no leading dot or underscore, no
 * URL-unsafe characters, and — for a scoped name — both halves present and
 * individually legal.
 */
export function validatePackageName(name: string): string | null {
  if (name === "") {
    return "package name is empty";
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `package name is longer than ${String(MAX_NAME_LENGTH)} characters`;
  }
  if (name !== name.toLowerCase()) {
    return "package name contains uppercase characters; npm names are lowercase";
  }
  if (name.trim() !== name) {
    return "package name has leading or trailing whitespace";
  }
  if (name.startsWith("@")) {
    return validateScoped(name);
  }
  return validateSegment(name, "package name");
}

/** Validate `@scope/name`, which must have exactly one slash and two halves. */
function validateScoped(name: string): string | null {
  const slash = name.indexOf("/");
  if (slash === -1) {
    return "scoped package name is missing the `/name` half (expected `@scope/name`)";
  }
  const scope = name.slice(1, slash);
  const rest = name.slice(slash + 1);
  if (rest.includes("/")) {
    return "package name has more than one `/`";
  }
  return validateSegment(scope, "scope") ?? validateSegment(rest, "package name");
}

/** Validate one segment's characters and leading punctuation. */
function validateSegment(segment: string, label: string): string | null {
  if (segment === "") {
    return `${label} is empty`;
  }
  if (segment.startsWith(".") || segment.startsWith("_")) {
    return `${label} may not start with '.' or '_'`;
  }
  const bad = segment.replace(/[a-z0-9._~-]/g, "");
  if (bad !== "") {
    return `${label} contains characters npm does not allow: ${[...new Set(bad)].join("")}`;
  }
  return null;
}

/**
 * Return what this package name would shadow, or `null` if it is safe.
 *
 * Only the unscoped half can shadow anything: `@acme/fs` resolves to the
 * package, never to the builtin, because a scoped specifier is never a builtin
 * and never a bare top-level name.
 */
export function shadowConflict(name: string): string | null {
  if (name.startsWith("@")) {
    return null;
  }
  if (BUILTINS.has(name)) {
    return `the Node builtin module '${name}'`;
  }
  if (COMMON_PACKAGES.has(name)) {
    return `the '${name}' package on npm`;
  }
  return null;
}

/**
 * Return the copy-pasteable refusal message for a shadowing package name.
 *
 * The Python original names all three ways out in the message itself, so an
 * agent that hits the refusal can act on it without reading any docs. Keep
 * that property: the message IS the documentation.
 */
export function shadowRefusal(name: string, conflict: string): string {
  return (
    `package name '${name}' would shadow ${conflict}; a bare import of ` +
    `'${name}' resolves to that, not to this project, so the collision ` +
    "surfaces as code silently running against the wrong module.\n" +
    "Fix: choose a different project name, pass --package <npm-name> to keep " +
    "this directory name, or pass --allow-shadowing to proceed anyway."
  );
}
