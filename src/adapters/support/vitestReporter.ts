/**
 * The reporter kragg adds to every vitest run, so that an error vitest catches
 * OUTSIDE any test reaches the gate.
 *
 * ── THE SIGNAL THIS EXISTS FOR ─────────────────────────────────────────────
 * A timer that fires after its test has finished, a promise rejected with no
 * handler, a listener that throws once the environment is gone: vitest catches
 * each of these as an UNHANDLED ERROR, keeps it out of every test's result,
 * and fails the run with `process.exitCode = 1`. Its json reporter has no field
 * for them — the report still says `success: true`, with every test passing —
 * and vitest prints them only through its console reporters, which kragg
 * replaces with `--reporter=json`. A run that failed on an unhandled error
 * therefore left kragg holding an exit code and nothing else (TOR-1902).
 *
 * This reporter is the missing channel. vitest hands every reporter the same
 * list it sets the exit code from (`_checkUnhandledErrors`), and this one
 * writes that list, as JSON, to the file `UNHANDLED_ERRORS_ENV` names: a path
 * inside the run's own directory (`testCommands.ts`, `RUNS_DIR`), so whatever
 * kragg reads back was written by the process it just spawned.
 *
 * ── TWO HOOKS, BECAUSE THE API MOVED ───────────────────────────────────────
 *  - `onTestRunEnd(testModules, unhandledErrors, reason)`: vitest 3.0 and
 *    later, and the only one vitest 4 and 5 call.
 *  - `onFinished(files, errors)`: the older hook, which vitest 3 still calls
 *    beside the new one, with the same list.
 *
 * Both write the same file from the same list, so under vitest 3 the second
 * write replaces the first with identical content. Verified against vitest
 * 3.0.0, 3.0.9, 3.1.0, 3.1.4, 3.2.0, 3.2.4, 4.1.12 and 5.0.3. vitest 2 is
 * outside kragg's range already: it rejects `--includeTaskLocation`.
 *
 * ── LOADED BY VITEST, NOT BY kragg ─────────────────────────────────────────
 * vitest imports this file, in its own process, from `REPORTER_PATH`: the
 * module's own location, so the source tree and `dist/` each hand vitest the
 * file that is really there. vitest before 3.2 will load a reporter from
 * outside the project only when it sits under `node_modules`, which an
 * installed kragg always does; a kragg run from a source checkout or a link
 * makes vitest 3.0 and 3.1 stop at startup with "Failed to load custom
 * Reporter", which the gate reports as a crash, never a pass. It imports
 * nothing but Node built-ins, and it never throws, because a reporter that
 * throws becomes one more error in the run it is trying to describe. A file it could not write reads, to kragg, as
 * no unhandled error recorded, and the non-zero exit is left to
 * `runnerReportedFailure` (`testEvidence.ts`), as it was before this existed.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The variable that tells the reporter where this run's file goes. */
export const UNHANDLED_ERRORS_ENV = "KRAGG_VITEST_UNHANDLED_ERRORS";

/** This module's own path: what `--reporter=` hands vitest to import. */
export const REPORTER_PATH = fileURLToPath(import.meta.url);

/**
 * One unhandled error, as the reporter writes it and the gate reads it back.
 *
 * Every field is a plain value, `""` when vitest did not supply it, so the
 * file is the same shape whichever kind of error vitest caught.
 */
export interface UnhandledErrorRecord {
  readonly name: string;
  readonly message: string;
  /** The stack as vitest serialized it: source-mapped, absolute paths. */
  readonly stack: string;
  /** vitest's own classification: `Uncaught Exception`, `Unhandled Rejection`, … */
  readonly type: string;
  /** The test FILE that was running when vitest caught it, absolute. */
  readonly testPath: string;
  /** The test vitest last started in that file, which may not be the culprit. */
  readonly testName: string;
  /** vitest caught it after that file's test environment was torn down. */
  readonly afterTeardown: boolean;
}

/**
 * The reporter itself. vitest constructs the default export with `new`.
 *
 * Parameters are typed `unknown` on purpose: kragg does not depend on vitest
 * and does not import its types, and the shapes differ across the majors this
 * has to work with.
 */
export default class UnhandledErrorReporter {
  onTestRunEnd(_testModules: unknown, unhandledErrors: unknown): void {
    record(unhandledErrors);
  }

  onFinished(_files: unknown, errors: unknown): void {
    record(errors);
  }
}

/** Write this run's list where kragg asked for it. Never throws. */
function record(errors: unknown): void {
  const target = process.env[UNHANDLED_ERRORS_ENV];
  if (target === undefined || target === "") {
    return;
  }
  try {
    const list: readonly unknown[] = Array.isArray(errors) ? errors : [];
    writeFileSync(target, `${JSON.stringify({ errors: list.map(unhandledErrorRecord) })}\n`);
  } catch {
    // Nothing is thrown back into vitest: see the module docs.
  }
}

/**
 * Project one error onto the record.
 *
 * Fields are read with `Reflect.get`, not by spreading: an error vitest caught
 * in a worker arrives as a plain serialized object, but one it caught in its
 * own process can be a real `Error`, whose `message` and `stack` are not
 * enumerable and would vanish from a `JSON.stringify` of the object itself.
 */
export function unhandledErrorRecord(error: unknown): UnhandledErrorRecord {
  if (typeof error !== "object" || error === null) {
    return {
      name: "",
      message: String(error),
      stack: "",
      type: "",
      testPath: "",
      testName: "",
      afterTeardown: false,
    };
  }
  const field = (key: string): string => {
    const value: unknown = Reflect.get(error, key);
    return typeof value === "string" ? value : "";
  };
  return {
    name: field("name"),
    message: field("message"),
    stack: field("stack"),
    type: field("type"),
    testPath: field("VITEST_TEST_PATH"),
    testName: field("VITEST_TEST_NAME"),
    afterTeardown: Reflect.get(error, "VITEST_AFTER_ENV_TEARDOWN") === true,
  };
}
