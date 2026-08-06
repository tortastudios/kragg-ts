/**
 * The `cli` kind: a Node command-line tool built on `node:util`'s `parseArgs`.
 *
 * No argument-parsing dependency. `parseArgs` has been stable in Node since
 * v20, and a scaffold that reaches for commander on day one has spent its
 * first supply-chain decision on something the platform already does. The
 * Python sibling makes the same call with `argparse`.
 *
 * The entrypoint RETURNS a result rather than printing and exiting. That keeps
 * the layer honest — an entrypoint that calls `process.exit` cannot be tested
 * without a subprocess — and confines the two impure lines to `bin.ts`.
 */

/** Source and test files for the `cli` kind. */
export function cliFiles(projectName: string): Record<string, string> {
  return {
    "src/entrypoints/cli.ts": cliEntrypoint(projectName),
    "src/entrypoints/bin.ts": CLI_BIN,
    "test/cli.test.ts": CLI_TEST,
  };
}

function cliEntrypoint(projectName: string): string {
  return `/**
 * Entrypoint: command-line interface.
 *
 * Thin by contract: parse, delegate to a service, format. No business logic
 * lives here, and nothing here writes to a stream or exits the process.
 */

import { parseArgs } from "node:util";

import { buildGreeting } from "../services/greeting.ts";

/** What the CLI decided: the text to print and the code to exit with. */
export interface CliResult {
  /** Process exit code: 0 ok, 2 usage error. */
  readonly code: number;
  /** The single line to write to stdout (code 0) or stderr (non-zero). */
  readonly output: string;
}

const USAGE = \`Usage: ${projectName} [name]

Options:
  -h, --help    show this help and exit

Exit codes:
  0  success
  2  usage error\`;

/** Parse arguments and produce the result; never prints, never exits. */
export function run(argv: readonly string[]): CliResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { code: 2, output: \`\${detail}\\n\\n\${USAGE}\` };
  }
  if (parsed.values.help === true) {
    return { code: 0, output: USAGE };
  }
  // \`noUncheckedIndexedAccess\` types this \`string | undefined\`, which is the
  // truth: there may be no positional. \`??\` supplies the default for the
  // missing case only — \`||\` would also rewrite an explicit empty argument.
  const name = parsed.positionals[0] ?? "world";
  return { code: 0, output: buildGreeting(name) };
}
`;
}

const CLI_BIN = `#!/usr/bin/env node
/**
 * Executable shim. The ONLY file that touches the process.
 *
 * Everything testable lives in \`cli.ts\`; this file exists so that the test
 * suite never has to spawn a subprocess to find out what the CLI would do.
 */

import { argv, exit, stderr, stdout } from "node:process";

import { run } from "./cli.ts";

const result = run(argv.slice(2));
const stream = result.code === 0 ? stdout : stderr;
stream.write(\`\${result.output}\\n\`);
exit(result.code);
`;

const CLI_TEST = `import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../src/entrypoints/cli.ts";

describe("run", () => {
  it("greets a positional name", () => {
    assert.deepEqual(run(["Ada"]), { code: 0, output: "Hello, Ada!" });
  });

  it("defaults to world with no arguments", () => {
    assert.equal(run([]).output, "Hello, world!");
  });

  it("exits 0 for --help", () => {
    assert.equal(run(["--help"]).code, 0);
  });

  it("exits 2 for an unknown option", () => {
    assert.equal(run(["--nope"]).code, 2);
  });
});
`;
