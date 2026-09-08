#!/usr/bin/env node
/**
 * `scripts/calibrate.ts` — measure kragg's metric gates against real samples.
 *
 * The metric thresholds in this repository (`CC_MAX_GRADE`, `MI_MIN_GRADE`,
 * `MAX_EFFORT`/`MAX_DIFFICULTY`/`MAX_BUGS`, `type_max_nesting_depth`,
 * `type_max_length`) are radon's and Python kragg's, ported onto a language
 * they were never drawn against. Whether they are USEFUL in TypeScript is an
 * empirical question, and this script is how it gets answered repeatably:
 * point it at a set of TypeScript projects and it emits the violation counts,
 * the distribution the counts came out of, and the findings themselves.
 *
 * IT CHANGES NOTHING. There is no `--fix`, no threshold argument, and no
 * writing back into `kragg.json`. Retuning a gate is a policy decision with a
 * conformance consequence for the Python sibling; this script exists to give
 * that decision evidence, not to take it.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *     node scripts/calibrate.ts [--format json|markdown] [--out FILE] SAMPLE...
 *
 * where SAMPLE is `[label=]root[:srcA,srcB][@tsconfig]` — see
 * `calibrate/spec.ts` for the grammar and what each part defaults to. Example:
 *
 *     node scripts/calibrate.ts \
 *       self=. \
 *       workspace=/path/to/monorepo:apps,packages@apps/web/site/tsconfig.json \
 *       --format markdown --out docs/calibration-run.md
 *
 * ── NO NEW DEPENDENCIES, NO SHELL, NO WRITES OUTSIDE `--out` ───────────────
 * Argument parsing is `node:util`'s `parseArgs`. The one subprocess is `git
 * rev-parse`, run through `src/engine/runner.ts` — the repository's single
 * approved spawn point, argv array, `shell: false` — because a table of
 * numbers with no commit beside it cannot be re-derived later. A sample that
 * is not a git repository records `null` and is measured anyway.
 *
 * Runs under Node 24's type stripping like the test suite: no build step.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CC_MAX_GRADE, MI_MIN_GRADE } from "../src/gates/complexity.ts";
import { MAX_BUGS, MAX_DIFFICULTY, MAX_EFFORT } from "../src/gates/halstead.ts";
import { runCommand } from "../src/engine/runner.ts";
import { measureSample } from "./calibrate/measure.ts";
import type { CalibrationRun, SampleMeasurement } from "./calibrate/model.ts";
import { renderMarkdown } from "./calibrate/render.ts";
import { parseSampleSpec, type SampleSpec } from "./calibrate/spec.ts";

/** This repository's root — the script lives one level down, in `scripts/`. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const USAGE =
  "usage: node scripts/calibrate.ts [--format json|markdown] [--out FILE] " +
  "[label=]root[:srcA,srcB][@tsconfig] ...";

/**
 * The thresholds every sample is judged against, spelled out in the report.
 *
 * Read from the gate modules rather than retyped, so a table that says "effort
 * > 50000" is saying what the code does and not what a comment once said.
 */
function thresholds(specs: readonly SampleSpec[]): Readonly<Record<string, string>> {
  const budgets = specs.map((spec) => `${spec.maxDepth}/${spec.maxLength}`);
  return {
    complexity: `worst permitted grade ${CC_MAX_GRADE}`,
    maintainability: `minimum grade ${MI_MIN_GRADE}`,
    halstead: `effort > ${MAX_EFFORT}, difficulty > ${MAX_DIFFICULTY}, bugs > ${MAX_BUGS}`,
    "type-complexity": `depth/length budgets per sample: ${[...new Set(budgets)].join(", ")}`,
    "nullable-default": "no threshold — rule-based, see src/gates/nullableDefault.ts",
  };
}

/** `git rev-parse --short HEAD` in the sample, or `null` if it is not a repo. */
async function commitOf(root: string): Promise<string | null> {
  const result = await runCommand("git", ["git", "rev-parse", "--short", "HEAD"], root);
  return result.returncode === 0 ? result.stdout.trim() : null;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      format: { type: "string", default: "markdown" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return parsed.values.help ? 0 : 2;
  }
  const format = parsed.values.format;
  if (format !== "json" && format !== "markdown") {
    process.stderr.write(`unknown --format ${format}\n${USAGE}\n`);
    return 2;
  }

  const specs = parsed.positionals.map(parseSampleSpec);
  const samples: SampleMeasurement[] = [];
  for (const spec of specs) {
    process.stderr.write(`measuring ${spec.label} (${spec.root})...\n`);
    samples.push(measureSample(spec, await commitOf(spec.root)));
  }

  const run: CalibrationRun = {
    date: new Date().toISOString().slice(0, 10),
    kraggCommit: (await commitOf(REPO_ROOT)) ?? "unknown",
    thresholds: thresholds(specs),
    samples,
  };
  const text =
    format === "json" ? `${JSON.stringify(run, null, 2)}\n` : `${renderMarkdown(run)}\n`;
  const out = parsed.values.out;
  if (out === undefined) {
    process.stdout.write(text);
  } else {
    writeFileSync(out, text, "utf8");
    process.stderr.write(`wrote ${out}\n`);
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
