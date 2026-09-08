/**
 * The two gates that are not a straight walk over the syntax tier.
 *
 * Split out of `measure.ts` so each file stays readable and under the
 * repository's 500-line budget — `scripts/` is not `source_paths`, so the
 * `structure` gate does not enforce that here, but a maintenance script that
 * ignores the project's own rule is a poor advertisement for it.
 *
 * Both gates need something the other measurers do not:
 *
 *  - `type-complexity` has no "report everything" mode and its annotation walk
 *    is private to the gate, so its DENOMINATOR is obtained by running the
 *    same gate a second time at budget `0/0` — every annotation site becomes a
 *    violation, over the same walk, the same sites and the same suppression
 *    handling as the real run. The depth and length are then read out of the
 *    gate's own message rather than recomputed, so the numbers reported here
 *    are literally the numbers the gate judged.
 *  - `nullable-default` needs the shared `ts.Program`, which is built from ONE
 *    tsconfig, while its candidate sites are counted over `source_paths`. On a
 *    workspace those are different file sets, and that difference is a real
 *    property of the type-aware tier rather than an artifact of this script.
 *
 * Nothing from a sample is copied out: violation messages are read (to
 * classify a finding and to recover its numbers) and then dropped, because
 * they quote source.
 */

import type ts from "typescript";

import { analysisProgram, programSourceFiles } from "../../src/analysis/program.ts";
import type { ParsedSource, TypeScriptApi } from "../../src/analysis/sourceFile.ts";
import { checkNullableDefaults } from "../../src/gates/nullableDefault.ts";
import { checkTypeComplexity } from "../../src/gates/typeComplexity.ts";
import { bucketize, gate, type Finding, type GateMeasurement } from "./model.ts";
import type { SampleSpec } from "./spec.ts";

// ── type-complexity ────────────────────────────────────────────────────────

/** `(depth=3, length=57)` out of the gate's own message. */
const ANNOTATION = /\(depth=(\d+), length=(\d+)\)$/u;

interface Annotation {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly depth: number;
  readonly length: number;
}

export function measureTypeComplexity(
  spec: SampleSpec,
  api: TypeScriptApi,
): readonly GateMeasurement[] {
  // Budget 0/0 makes every annotation site a violation, so the gate's own walk
  // hands back the population its real run was judged against. See the module
  // doc: this is the only place the script asks a gate for something a real
  // check never asks for.
  const all = annotations(spec, api, 0, 0);
  const failed = annotations(spec, api, spec.maxDepth, spec.maxLength);

  const both = failed.filter(
    (site) => site.depth > spec.maxDepth && site.length > spec.maxLength,
  ).length;
  const depthOnly = failed.filter(
    (site) => site.depth > spec.maxDepth && site.length <= spec.maxLength,
  ).length;

  return [
    gate(
      "type-complexity",
      "annotation",
      [],
      {
        "depth-only": depthOnly,
        "length-only": failed.length - depthOnly - both,
        both,
      },
      failed.map((site) => typeFinding(site, spec)),
      all.length,
    ),
    gate(
      "type-complexity:depth",
      "annotation",
      all.map((site) => site.depth),
      bucketize(
        all.map((site) => site.depth),
        [0, 1, 2, 3],
      ),
      [],
      all.length,
      depthOnly + both,
    ),
    gate(
      "type-complexity:length",
      "annotation",
      all.map((site) => site.length),
      bucketize(
        all.map((site) => site.length),
        [20, 40, 60, 100],
      ),
      [],
      all.length,
      all.filter((site) => site.length > spec.maxLength).length,
    ),
  ];
}

function typeFinding(site: Annotation, spec: SampleSpec): Finding {
  const overDepth = site.depth > spec.maxDepth;
  return {
    file: site.file,
    symbol: site.symbol,
    line: site.line,
    metric: overDepth ? "depth" : "length",
    value: overDepth ? site.depth : site.length,
    threshold: overDepth ? spec.maxDepth : spec.maxLength,
    ratio: overDepth ? site.depth / spec.maxDepth : site.length / spec.maxLength,
  };
}

/** Run the gate at the given budget and reduce each violation to numbers. */
function annotations(
  spec: SampleSpec,
  api: TypeScriptApi,
  maxDepth: number,
  maxLength: number,
): readonly Annotation[] {
  const found: Annotation[] = [];
  for (const violation of checkTypeComplexity({
    root: spec.root,
    sourcePaths: spec.sourcePaths,
    maxDepth,
    maxLength,
    api,
  })) {
    const match = ANNOTATION.exec(violation.message);
    if (match === null) {
      continue;
    }
    found.push({
      file: violation.file ?? "",
      line: violation.line ?? 0,
      // The message opens with the site's context ("parameter `x`", "return
      // type of f"), which names the symbol without quoting the annotation.
      symbol: violation.message.slice(0, violation.message.indexOf(": annotation")),
      depth: Number(match[1]),
      length: Number(match[2]),
    });
  }
  return found;
}

// ── nullable-default ───────────────────────────────────────────────────────

/**
 * THE ONE GATE WHOSE DENOMINATOR CAN DISAGREE WITH ITS NUMERATOR.
 *
 * The candidate sites are counted over `sourcePaths`, the way every other gate
 * here walks. The violations come from the shared `ts.Program`, which is built
 * from ONE tsconfig — so on a workspace with no root config, the gate looks at
 * whatever that one config includes and the two numbers describe different
 * file sets. That is not a defect in the harness, it is the type-aware tier's
 * real coverage on a monorepo, and the `program files` bucket is here so a
 * reader sees it instead of reading "0 violations" as "0 problems".
 */
export function measureNullableDefault(
  spec: SampleSpec,
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): GateMeasurement {
  const sites = candidateSites(sources, api);
  const measured = sites.coalesce + sites.arithmetic;
  const program = analysisProgram(
    spec.tsconfigPath === null
      ? { root: spec.root }
      : { root: spec.root, tsconfigPath: spec.tsconfigPath },
  );
  const load = program.load();
  const buckets = {
    "|| sites": sites.coalesce,
    "arithmetic sites": sites.arithmetic,
    "program files": load.ok ? programSourceFiles(load.program).length : 0,
  };
  const outcome = checkNullableDefaults({ program });
  if (!outcome.ok) {
    return {
      gate: "nullable-default",
      unit: "site",
      measured,
      violations: 0,
      rate: 0,
      buckets,
      summary: null,
      findings: [],
      findingsTruncated: 0,
      blocked: outcome.message.split("\n")[0] ?? outcome.message,
    };
  }
  const findings: Finding[] = outcome.violations.map((violation) => ({
    file: violation.file ?? "",
    // The message quotes source, so only its RULE is kept: rule 1 opens with
    // the operator, rule 2 with the word "arithmetic".
    symbol: violation.message.startsWith("arithmetic") ? "untyped-payload" : "falsy-coalesce",
    line: violation.line ?? 0,
    metric: "site",
    value: 1,
    threshold: 0,
    ratio: 1,
  }));
  return gate("nullable-default", "site", [], buckets, findings, measured);
}

/**
 * The two syntactic families the gate's rules draw from: `||`/`||=` sites and
 * arithmetic sites. This is the denominator, NOT a second implementation of
 * the rules — a site here is a place the gate looked, not a place it fired.
 */
interface CandidateSites {
  /** `||` and `||=` expressions — where rule 1 looks. */
  readonly coalesce: number;
  /** `+ - * / % **` expressions — where rule 2 looks. */
  readonly arithmetic: number;
}

function candidateSites(
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): CandidateSites {
  const arithmetic = new Set<ts.SyntaxKind>([
    api.SyntaxKind.PlusToken,
    api.SyntaxKind.MinusToken,
    api.SyntaxKind.AsteriskToken,
    api.SyntaxKind.SlashToken,
    api.SyntaxKind.PercentToken,
    api.SyntaxKind.AsteriskAsteriskToken,
  ]);
  const coalesce = new Set<ts.SyntaxKind>([
    api.SyntaxKind.BarBarToken,
    api.SyntaxKind.BarBarEqualsToken,
  ]);
  const counts = { coalesce: 0, arithmetic: 0 };
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (api.isBinaryExpression(node)) {
        const kind = node.operatorToken.kind;
        if (coalesce.has(kind)) {
          counts.coalesce += 1;
        } else if (arithmetic.has(kind)) {
          counts.arithmetic += 1;
        }
      }
      api.forEachChild(node, visit);
    };
    api.forEachChild(source.sourceFile, visit);
  }
  return counts;
}
