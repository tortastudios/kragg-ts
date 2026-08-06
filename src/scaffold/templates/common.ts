/**
 * Source files every scaffolded project gets, regardless of kind.
 *
 * Ported from the shared half of `kind_files` in `kragg/templates.py`. The
 * layered layout — `entrypoints/` -> `services/` -> `domain/` — is created on
 * the first commit for every kind, so the `boundaries` gate has something real
 * to enforce before any business code exists. A layout introduced later is a
 * layout that gets argued with; a layout that was always there is just how the
 * project works.
 *
 * The greeting slice is deliberately trivial. Its job is to demonstrate the
 * direction of dependencies and the `.ts` import extension, not to be useful.
 */

/** Shared layered source and test files, keyed by project-relative path. */
export function commonFiles(): Record<string, string> {
  return {
    "src/domain/messages.ts": MESSAGES_DOMAIN,
    "src/services/greeting.ts": GREETING_SERVICE,
    "test/greeting.test.ts": GREETING_TEST,
  };
}

const MESSAGES_DOMAIN = `/**
 * Domain layer: pure data and rules.
 *
 * Imports nothing from a higher layer and does no I/O. Everything here is a
 * function of its arguments, which is what makes it testable without a
 * fixture.
 */

/** The canonical greeting template. */
export const GREETING_TEMPLATE = "Hello, {name}!";

/** Render the canonical greeting for a name. */
export function renderGreeting(name: string): string {
  return GREETING_TEMPLATE.replace("{name}", name);
}
`;

const GREETING_SERVICE = `/**
 * Services layer: orchestration. The only layer entrypoints may call.
 *
 * The relative import carries a literal \`.ts\` extension so Node runs this
 * file directly; \`tsc\` rewrites it to \`.js\` on build.
 */

import { renderGreeting } from "../domain/messages.ts";

/**
 * Build the greeting shown to a user.
 *
 * Note what the fallback is NOT written as. \`name || "world"\` would work
 * here by accident and teach the wrong habit: \`||\` falls back on every falsy
 * value, so the same idiom applied to a port number rewrites a configured
 * \`0\`. \`??\` is the right operator for null/undefined, and neither operator
 * covers "empty after trimming" — that case is spelled out.
 */
export function buildGreeting(name: string): string {
  const cleaned = name.trim();
  return renderGreeting(cleaned === "" ? "world" : cleaned);
}
`;

const GREETING_TEST = `import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildGreeting } from "../src/services/greeting.ts";

describe("buildGreeting", () => {
  it("greets a name", () => {
    assert.equal(buildGreeting("Ada"), "Hello, Ada!");
  });

  it("falls back to world for a blank name", () => {
    assert.equal(buildGreeting("   "), "Hello, world!");
  });
});
`;

/**
 * Files for `kragg gen module <name>`: a domain type, a service over it, and
 * a test. Ported from `module_files`.
 */
export function moduleFiles(module: string): Record<string, string> {
  const record = recordName(module);
  const plural = `list${record.replace(/Record$/, "")}`;
  return {
    [`src/domain/${module}.ts`]: moduleDomain(module, record),
    [`src/services/${module}.ts`]: moduleService(module, record, plural),
    [`test/${module}.test.ts`]: moduleTest(module, plural),
  };
}

/** `user-account` -> `UserAccountRecord`, mirroring `_record_name`. */
export function recordName(module: string): string {
  const parts = module.split(/[-_]/).filter((part) => part !== "");
  const pascal = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${pascal === "" ? "Module" : pascal}Record`;
}

function moduleDomain(module: string, record: string): string {
  return `/** Domain: ${module} data and rules. */

/** One ${module} entry. */
export interface ${record} {
  readonly id: string;
  readonly name: string;
}
`;
}

function moduleService(module: string, record: string, plural: string): string {
  return `/** Service: orchestrates ${module} operations. */

import type { ${record} } from "../domain/${module}.ts";

/** Return up to \`limit\` ${module} records. */
export function ${plural}(limit = 100): readonly ${record}[] {
  void limit;
  return [];
}
`;
}

function moduleTest(module: string, plural: string): string {
  return `import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ${plural} } from "../src/services/${module}.ts";

describe("${plural}", () => {
  it("starts empty", () => {
    assert.deepEqual(${plural}(), []);
  });
});
`;
}
