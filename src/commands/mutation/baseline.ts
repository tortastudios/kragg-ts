/**
 * The accepted-mutant baseline — `.kragg/mutants.baseline`.
 *
 * Some surviving mutants are EQUIVALENT: the mutated program is semantically
 * identical to the original, so no test can possibly kill them and no amount
 * of work will. Equivalence is undecidable in general, so a human decides, once
 * — and that decision has to be recorded somewhere or every subsequent run
 * re-reports it and the surface becomes noise.
 *
 * ── THIS FILE IS GIT-TRACKED, AND THAT IS THE POINT ────────────────────────
 * It is the ONE thing under `.kragg/` that is deliberately committed. Every
 * other artifact there (the run journal, the coverage report, the criticality
 * graph, Stryker's incremental cache) is per-machine derived state. This one is
 * a REVIEWED, SHARED PROPERTY OF THE CODEBASE: "we looked at this mutant and
 * agreed no test can kill it". A local-only baseline would mean each developer
 * and CI re-litigating the same mutants forever, and — worse — someone could
 * silence a REAL survivor on their machine and nobody would see it in review.
 * Tracking it puts every acceptance in a diff.
 *
 * THE GITIGNORE IMPLICATION IS NOT OPTIONAL. Git cannot re-include a file
 * inside an EXCLUDED DIRECTORY, so a `.gitignore` containing
 *
 *     .kragg/
 *
 * makes the negation below impossible — the directory is never descended into
 * and `!.kragg/mutants.baseline` has no effect whatsoever. The pattern must
 * exclude the directory's CONTENTS and then re-include this one file, exactly
 * as the Python sibling's own `.gitignore` does:
 *
 *     .kragg/*
 *     !.kragg/mutants.baseline
 *
 * A repo that gets this wrong does not fail loudly; it silently loses the
 * baseline on every clone. Scaffolding must emit the two-line form.
 *
 * ── WHY THE SIGNATURE IS NOT STRYKER'S MUTANT ID ───────────────────────────
 * Stryker's `id` is a per-run counter. `MutantCollector` hands out
 * `nextMutantId++` starting at 0 across the whole run, and Stryker's own
 * incremental differ documents the consequence: "the ids of tests and mutants
 * can differ across reports (they are only unique within 1 report)". Baselining
 * by `id` would silence a different mutant after any edit.
 *
 * Stryker's own cross-report key is
 * `file@startLine:startCol-endLine:endCol\nmutatorName: replacement`, which it
 * can afford because `--incremental` re-maps every location through
 * diff-match-patch before comparing. A baseline read from disk has no such
 * diff, so an absolute line number would invalidate every entry the moment
 * anyone inserted a line above it.
 *
 * So the signature is the direct analogue of Python's
 * `file::operator::occurrence`, refined with the replacement:
 *
 *     <file>::<mutatorName>::<replacement>::<occurrence>
 *
 * — no line number, so unrelated edits elsewhere in the file do not
 * invalidate it. `replacement` is included because one Stryker mutator name
 * covers several substitutions at a single site (`ConditionalExpression`
 * produces both `true` and `false`), and Python's operator name did not.
 *
 * KNOWN LIMITATION, the same one Python carries: `occurrence` counts prior
 * identical-mutator-and-replacement survivors in that file, so ADDING such a
 * mutant earlier in the file shifts the index and un-baselines the ones after
 * it. They come back as survivors, which is the safe direction — a stale
 * acceptance is reported for review rather than silently extended to code
 * nobody looked at.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Survivor } from "./report.ts";

/** Repo-relative path of the baseline, shared with the Python sibling. */
export const BASELINE_RELATIVE = ".kragg/mutants.baseline";

/** The two `.gitignore` lines a project needs. See the module docs. */
export const GITIGNORE_LINES: readonly string[] = [
  ".kragg/*",
  `!${BASELINE_RELATIVE}`,
];

export function baselinePath(root: string): string {
  return join(root, ".kragg", "mutants.baseline");
}

/**
 * A stable identity for one accepted mutant. See the module docs for why it
 * is built from these four parts and from no line number.
 */
export function signature(survivor: Survivor): string {
  return [
    survivor.file,
    survivor.mutatorName,
    survivor.replacement,
    String(survivor.occurrence),
  ].join("::");
}

/**
 * Read the accepted signatures; an EMPTY SET when the file is absent or
 * unreadable.
 *
 * Degrading to empty is the fail-closed direction: with no baseline every
 * survivor is reported, which is noisy but correct. The opposite degradation —
 * treating an unreadable baseline as "accept everything" — would turn a
 * corrupted file into a silently passing gate.
 */
export function loadBaseline(root: string): ReadonlySet<string> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(baselinePath(root), "utf8"));
  } catch {
    return new Set();
  }
  if (!Array.isArray(data)) {
    return new Set();
  }
  return new Set(data.filter((item): item is string => typeof item === "string"));
}

/**
 * Record the given survivors as the accepted baseline, replacing any previous
 * one, and return how many signatures were written.
 *
 * REPLACES rather than merges, deliberately: a merge would let accepted
 * mutants accumulate for code that no longer exists, and the file would only
 * ever grow. Rewriting means a deleted acceptance shows up in the diff as a
 * deletion, which is what review is for.
 *
 * Sorted and `indent: 1` with a trailing newline, byte-for-byte matching
 * Python's `json.dumps(signatures, indent=1) + "\n"`, so a polyglot repo
 * running both tools sees no spurious diff.
 */
export function writeBaseline(root: string, survivors: readonly Survivor[]): number {
  const signatures = [...new Set(survivors.map(signature))].sort();
  const path = baselinePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(signatures, null, 1)}\n`, "utf8");
  return signatures.length;
}

/** Drop survivors whose signature is in the accepted baseline. */
export function filterBaselined(
  survivors: readonly Survivor[],
  baseline: ReadonlySet<string>,
): readonly Survivor[] {
  return survivors.filter((survivor) => !baseline.has(signature(survivor)));
}

/**
 * Signatures in the baseline that no current survivor claims.
 *
 * Reported, never auto-removed. A stale entry usually means the code was fixed
 * or deleted, but it can also mean the scope of this run simply did not include
 * that file — and quietly dropping an acceptance the team agreed on, because a
 * narrowed run did not happen to re-derive it, would lose real review work.
 */
export function staleSignatures(
  survivors: readonly Survivor[],
  baseline: ReadonlySet<string>,
): readonly string[] {
  const present = new Set(survivors.map(signature));
  return [...baseline].filter((entry) => !present.has(entry)).sort();
}
