/**
 * `kragg gen module <name>` — generate the slots for a new feature area.
 *
 * Ported from `generate_module`. The point is not to save typing: it is that
 * an agent adding a feature has exactly one place to put each piece, decided
 * before the feature existed. A domain type, a service over it, and a test —
 * generated together, in the layers the `boundaries` gate enforces.
 */

import { parseArgs } from "node:util";

import { EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import { generateModule, ScaffoldError } from "../scaffold/project.ts";

/** Usage text, printed on `--help` and on every usage error. */
export const GEN_USAGE = `Usage: kragg gen module <name> [options]

Options:
      --root <dir>   project root (default: the current directory)
  -h, --help         show this help and exit

Generates src/domain/<name>.ts, src/services/<name>.ts and test/<name>.test.ts.
Refuses if any of them already exists.`;

/**
 * Generate a module and print the paths written.
 *
 * Returns `0` on success and `2` for a usage error or a refusal — including
 * the module-already-exists case, which is a request the tool declined, not a
 * failure it suffered.
 */
export function runGen(argv: readonly string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error: unknown) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${GEN_USAGE}\n`);
    return EXIT_OK;
  }
  const subcommand = parsed.positionals[0];
  if (subcommand === undefined) {
    return usageError("kragg gen requires a subcommand");
  }
  if (subcommand !== "module") {
    return usageError(`unknown gen subcommand '${subcommand}'`);
  }
  const name = parsed.positionals[1];
  if (name === undefined) {
    return usageError("kragg gen module requires a module name");
  }
  if (parsed.positionals.length > 2) {
    return usageError("kragg gen module takes exactly one module name");
  }
  return generate(parsed.values.root ?? process.cwd(), name);
}

/** Run the generator and report, or translate a refusal into exit code 2. */
function generate(root: string, name: string): number {
  try {
    const result = generateModule(root, name);
    for (const path of result.written) {
      process.stdout.write(`created ${path}\n`);
    }
    process.stdout.write(
      "\nWire the service into an entrypoint, then run `pnpm exec kragg check`.\n",
    );
    return EXIT_OK;
  } catch (error: unknown) {
    if (error instanceof ScaffoldError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

/** Print a usage error with the usage text, and return exit code 2. */
function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${GEN_USAGE}\n`);
  return EXIT_USAGE;
}
