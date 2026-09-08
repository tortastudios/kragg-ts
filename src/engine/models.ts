/**
 * Shared result/context data types.
 *
 * Ported from `kragg/src/kragg/models.py`. The Python and TypeScript
 * implementations are siblings: they MUST agree on the JSON wire format.
 * Field names are camelCase in TypeScript and snake_case on the wire; the
 * translation happens once, in `report.ts`. Nothing else may serialize these.
 *
 * These are plain data interfaces, not classes, so that every value is
 * trivially structurally-cloneable and JSON-serializable. Behaviour that the
 * Python dataclasses expose as properties/methods lives here as free
 * functions (`violationLocation`, `commandOutput`, ...).
 */

/** One actionable finding produced by a gate. */
export interface Violation {
  readonly message: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly code?: string | undefined;
  readonly fixHint?: string | undefined;
}

/**
 * Render a violation's position as `file:line:column`.
 *
 * Returns `""` when there is no file, matching `Violation.location()` in
 * Python. Column is only emitted when a line is present, because a bare
 * column is meaningless to a human or an agent following the pointer.
 */
export function violationLocation(violation: Violation): string {
  if (violation.file === undefined) {
    return "";
  }
  const parts: string[] = [violation.file];
  if (violation.line !== undefined) {
    parts.push(String(violation.line));
    if (violation.column !== undefined) {
      parts.push(String(violation.column));
    }
  }
  return parts.join(":");
}

/** Result produced by one guardrail gate. */
export interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly output: string;
  readonly command: readonly string[];
  readonly skipped: boolean;
  readonly skipReason: string | null;
  /** Wall-clock duration, filled in by `runGates`; 0 before it runs. */
  readonly durationMs: number;
  /** Violations to display. May be capped relative to `violationCount`. */
  readonly violations: readonly Violation[];
  /** Total violations found, including any not present in `violations`. */
  readonly violationCount: number;
  /**
   * INFORMATION, NOT FINDINGS. Things a reader should see that must not change
   * the verdict: a deliberate escape hatch in a config, a severity floor that
   * filtered something out.
   *
   * Deliberately NOT consulted by `reportPassed`, `reportExitCode` or
   * `violationCount`. An advisory that moved the exit code would be a
   * violation with extra steps, and the split exists precisely so a gate can
   * say "look at this" without saying "you are blocked".
   *
   * `Violation` is reused as the carrier because an advisory has the identical
   * shape — file, line, code, message, fix hint — and the severity lives in
   * WHICH LIST it is in, not in a field. That keeps `Violation` byte-identical
   * to the Python sibling's; see `reportPayload.ts` for the wire decision.
   */
  readonly advisories: readonly Violation[];
  /**
   * The gate could not run at all (missing tool, broken environment) as
   * opposed to running and finding problems. Drives exit code 3.
   */
  readonly error: boolean;
}

/**
 * What `gateResult` needs from a caller: the two fields with no sensible
 * default, plus any of the rest.
 *
 * A named interface rather than an inline
 * `Pick<GateResult, …> & Partial<GateResult>` intersection: the shape is
 * identical, and naming it keeps the parameter annotation readable at the
 * call site and in the emitted `.d.ts`.
 */
interface GateResultInit extends Partial<GateResult> {
  readonly name: string;
  readonly passed: boolean;
}

/**
 * Build a `GateResult`, filling in the same defaults as the Python dataclass.
 * Always construct through this so a new field cannot be silently omitted.
 */
export function gateResult(init: GateResultInit): GateResult {
  return {
    name: init.name,
    passed: init.passed,
    output: init.output ?? "",
    command: init.command ?? [],
    skipped: init.skipped ?? false,
    skipReason: init.skipReason ?? null,
    durationMs: init.durationMs ?? 0,
    violations: init.violations ?? [],
    violationCount: init.violationCount ?? 0,
    advisories: init.advisories ?? [],
    error: init.error ?? false,
  };
}

/** Captured result for an external command. */
export interface CompletedCommand {
  readonly name: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * True when `runCommand` itself terminated the process — the timeout
   * elapsed, or the output buffer overflowed. Absent otherwise. A command that
   * did not get to finish cannot have written a complete report, whatever is
   * on disk; adapters that read a report file check this before reading it.
   */
  readonly killed?: boolean;
}

/** Combined stdout/stderr, trimmed — what a human or agent should read. */
export function commandOutput(result: CompletedCommand): string {
  return [result.stdout, result.stderr].filter((part) => part).join("\n").trim();
}

export function commandPassed(result: CompletedCommand): boolean {
  return result.returncode === 0;
}

/** Lift a raw command result into an unparsed gate result. */
export function completedToGateResult(result: CompletedCommand): GateResult {
  return gateResult({
    name: result.name,
    passed: commandPassed(result),
    output: commandOutput(result),
    command: result.command,
  });
}

/** Resolved project root and active policy. */
export interface ProjectContext {
  readonly root: string;
  readonly policyName: string;
}
