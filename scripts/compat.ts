#!/usr/bin/env node
/**
 * `scripts/compat.ts` — execute the compatibility claims this package makes.
 *
 * `package.json` advertises `engines.node: ">=20"`, four published entry
 * points, a CLI binary and a Windows-capable subprocess wrapper. Until this
 * script existed, none of that had been RUN: `pnpm test` imports `src/*.ts`
 * on the single Node in `.node-version`, on whatever host the developer has.
 * A green suite was compatible with a `dist/index.d.ts` that never got
 * emitted, a `bin` nobody could launch on Windows, and a floor of 20 that had
 * never seen a Node 20.
 *
 * Three lanes, deliberately separate because they have different governance:
 *
 *   packaged   Build → pack → install the TARBALL → run the CLI and a
 *              TypeScript consumer on a given Node. Blocking. The matrix
 *              (ubuntu/windows × Node 20/22/24) lives in
 *              `.github/workflows/compat.yml`; this script is one row of it.
 *
 *   scaffolds  `kragg new --kind cli|api|mcp` → install → the generated
 *              project's own `pnpm exec kragg check`. Blocking. A scaffold
 *              that cannot pass the gates it ships is a broken scaffold.
 *
 *   tools      Install the REAL vitest / node / bun / oxlint / biome / eslint
 *              / secretlint and assert kragg's adapters parse their CURRENT
 *              output. NOT blocking, and in its own workflow
 *              (`.github/workflows/external-tools.yml`) — see the header of
 *              `compat/tools.ts` for why external version drift must not be
 *              able to turn every pull request red.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *     node scripts/compat.ts packaged [--node PATH] [--pnpm PATH]
 *     node scripts/compat.ts scaffolds [--only cli] [--only mcp-fastmcp]
 *     node scripts/compat.ts tools [--only vitest+oxlint] [--strict]
 *
 *   --node PATH     the Node the PACKAGED artifact is executed with. Defaults
 *                   to this process. Node 20 and 22 cannot run a `.ts` file,
 *                   so the harness stays on the development Node and hands the
 *                   interpreter under test to the thing under test.
 *   --pnpm PATH     package-manager binary (pnpm only; see AGENTS.md). On
 *                   Windows pass the absolute `pnpm.cmd`: `runner.ts` turns a
 *                   batch shim into `<node> <script>` with no shell, so this
 *                   harness is itself a user of the code it is testing.
 *   --tarball PATH  reuse an existing `pnpm pack` output instead of packing.
 *   --only ROW      run just this matrix row; repeatable.
 *   --strict        a row that had to SKIP (an external tool is not installed)
 *                   or that raised an advisory warning (a published advisory
 *                   against a scaffold's transitive dependency) fails the lane
 *                   instead of being reported as a skip or a warning. This is
 *                   how `external-tools.yml` runs the lanes: nothing is
 *                   tolerated there, and nothing there blocks a merge.
 *   --keep          leave the scratch directories in place for inspection.
 *
 * Exit 0 when every selected row passed, 1 when any row failed, 2 on a usage
 * error. Nothing here writes inside this repository.
 *
 * ── RULES IT KEEPS ─────────────────────────────────────────────────────────
 * No new dependencies: `node:util` parses the arguments and every subprocess
 * goes through `src/engine/runner.ts`, argv array, `shell: false`, exactly as
 * `scripts/calibrate.ts` does. The pinned external tools the `tools` lane
 * installs live in throwaway fixtures outside this repository and never touch
 * `package.json` or the lockfile.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { packagedLane } from "./compat/packaged.ts";
import { scaffoldLane } from "./compat/scaffolds.ts";
import { toolsLane } from "./compat/tools.ts";
import {
  cleanup,
  laneOk,
  laneWarned,
  packTarball,
  renderLanes,
  resolvePackageManager,
  sh,
  type LaneEnvironment,
  type LaneOutcome,
} from "./compat/support.ts";

/** This repository's root — the script lives one level down, in `scripts/`. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const LANES: Readonly<Record<string, (environment: LaneEnvironment) => Promise<LaneOutcome>>> = {
  packaged: packagedLane,
  scaffolds: scaffoldLane,
  tools: toolsLane,
};

const USAGE =
  "usage: node scripts/compat.ts <packaged|scaffolds|tools>... " +
  "[--node PATH] [--pnpm PATH] [--tarball PATH] [--only ROW] [--strict] [--keep]";

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      node: { type: "string" },
      pnpm: { type: "string" },
      tarball: { type: "string" },
      only: { type: "string", multiple: true },
      strict: { type: "boolean" },
      keep: { type: "boolean" },
    },
  });

  const lanes = parsed.positionals;
  if (lanes.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  for (const lane of lanes) {
    if (!Object.hasOwn(LANES, lane)) {
      process.stderr.write(`unknown lane ${JSON.stringify(lane)}\n${USAGE}\n`);
      return 2;
    }
  }

  const nodeUnderTest = parsed.values.node ?? process.execPath;
  if (!existsSync(nodeUnderTest)) {
    process.stderr.write(`--node ${nodeUnderTest} does not exist\n`);
    return 2;
  }

  const pnpm = resolvePackageManager(parsed.values.pnpm ?? "pnpm");
  const keep = parsed.values.keep ?? false;
  const strict = parsed.values.strict ?? false;

  try {
    const tarball = parsed.values.tarball ?? (await packTarball(REPO_ROOT, pnpm));
    const environment: LaneEnvironment = {
      repoRoot: REPO_ROOT,
      nodeUnderTest,
      pnpm,
      tarball,
      keep,
      only: parsed.values.only ?? [],
    };
    await describeHost(environment);

    const outcomes: LaneOutcome[] = [];
    for (const lane of lanes) {
      const run = LANES[lane];
      if (run === undefined) {
        continue;
      }
      process.stdout.write(`\nlane ${lane}\n`);
      outcomes.push(await run(environment));
    }

    process.stdout.write(renderLanes(outcomes));
    const failed = outcomes.some((outcome) => !laneOk(outcome));
    const soft =
      outcomes.some((outcome) => outcome.rows.some((row) => row.skipped !== null)) ||
      outcomes.some(laneWarned);
    if (strict && soft) {
      process.stdout.write("--strict: a skipped row or an advisory warning counts as a failure\n");
    }
    return failed || (strict && soft) ? 1 : 0;
  } finally {
    cleanup(keep);
  }
}

/**
 * Print exactly which interpreter and package manager the run used.
 *
 * A compatibility report whose log does not name the Node it tested is a
 * report nobody can check, and "the matrix said Node 20" is precisely the
 * claim that must not be taken on trust.
 */
async function describeHost(environment: LaneEnvironment): Promise<void> {
  const version = await sh("node --version", [environment.nodeUnderTest, "--version"], REPO_ROOT);
  process.stdout.write(
    `host: platform=${process.platform} arch=${process.arch}\n` +
      `harness node: ${process.version} (${process.execPath})\n` +
      `node under test: ${version.stdout.trim()} (${environment.nodeUnderTest})\n` +
      `package manager: ${environment.pnpm}\n` +
      `tarball: ${environment.tarball}\n`,
  );
}

process.exitCode = await main(process.argv.slice(2));
