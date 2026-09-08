# Spec conformance

`kragg` exists in two implementations:

- **Python** — `tortastudios/crag`, package `kragg`. Historically the de facto
  authority (`src/kragg/report.py`).
- **TypeScript** — this repo, `tortastudios/kragg-ts`, package `kragg` on npm.

They are siblings, not a port and a fork. An agent or a CI job must be able to
consume either one's output without knowing which produced it.

## Where the spec lives

`tortastudios/crag`, directory `spec/`, since its **0.9.0** release:

| file | what it is |
| --- | --- |
| `spec/SPEC.md` | the normative, language-neutral contract, binding on both repos |
| `spec/run_conformance.py` | a stdlib-only runner: fixtures in, normalized JSON diff out |
| `spec/fixtures/` | one directory per fixture; `applies_to` says which implementations it runs against |

**The pin is `f76a7d0321ca6498d5c00653c493aa5ffdf2383d`** (crag `Release 0.9.0`).
A full commit SHA, never a branch and never a tag. An upstream edit that turns
an unrelated pull request here red is how people learn to ignore a check;
bumping the pin is a deliberate act, and the SPEC.md and fixture diff between
two SHAs is read the way a schema migration is read. The same SHA appears in
three places, and `test/conformance.test.ts` fails if they disagree:

1. `.github/workflows/ci.yml`, as the `ref:` the sibling is checked out at;
2. every `fixture.json` under `test/fixtures/conformance/`, as
   `recorded_against.crag_commit`;
3. this document.

## Running the two suites

**Cross-language** — this implementation against the sibling's fixtures. Only
two of them declare `applies_to: typescript` (`config-error` and
`ts-missing-tsc`); the rest report `SKIP`. The runner diffs goldens exactly, so
this is where an accidental wire-format change surfaces:

```sh
pnpm run build
cd /path/to/crag && python3 spec/run_conformance.py \
  --impl typescript --tool node /path/to/kragg-ts/dist/cli.js
```

`--tool` consumes the rest of the argv, so it goes last. `--self-test`
exercises the runner's own normalizer and validator and is worth running first:
if it fails, nothing the runner says about kragg-ts means anything.

**Local fixtures** — everything the cross-language suite does not reach:

```sh
pnpm run conformance          # or: node --test test/conformance.test.ts
```

They also run as part of `pnpm test`. `KRAGG_CONFORMANCE_UPDATE=1` re-records
the goldens; that is a contract decision, reviewed as a diff, not a way to get
a red suite green.

CI runs both in one job (`conformance` in `.github/workflows/ci.yml`), against
`dist/cli.js` — the artifact a consumer installs, never `src/cli.ts`.

## The shared surface, as implemented

Six things are shared, plus the config key vocabulary. Gate *names* and the set
of gates offered are **not**: `ruff` has no TypeScript analogue, `lint` here
drives whichever of oxlint/biome/eslint the project installed, and either side
may add a gate without consulting the other. What is shared is the shape of the
report that carries them.

### 1. The report JSON, `schema_version: 1`

Keys are snake_case on the wire in both languages. TypeScript keeps camelCase
internally and translates in exactly one place,
[`src/engine/reportPayload.ts`](../src/engine/reportPayload.ts). Python's
`ReportPayload`/`GatePayload`/`SummaryPayload`/`ViolationPayload` TypedDicts in
`report.py` are the same four shapes.

```
ReportPayload   schema_version, kragg_version, command, mode, targets,
                git_sha, started_at, duration_ms, passed, exit_code,
                summary, gates, next_actions
SummaryPayload  gates_total, gates_passed, gates_failed, gates_skipped,
                violations_total, violations_shown
GatePayload     name, passed, skipped, skip_reason, error, duration_ms,
                violation_count, violations, truncated, raw_output,
                advisories*, advisory_count*
ViolationPayload  file, line, column, code, message, fix_hint
```

**Null, never absent.** Every key above is always present; a value with nothing
to say is `null`. Consumers index unconditionally.

Six values must *derive* from `gates[]`, and both suites re-derive them rather
than trusting the recorded bytes: the four gate counts, `violations_total`,
`violations_shown`, `duration_ms` (the sum of the gate durations), `passed`
(`all(g.passed or g.skipped)`), and `exit_code` (section 3).

`violation_count` is the true total of raw findings. `violations` is a
*display* list: findings sharing a `(code, message)` may be collapsed into one
entry that names the extra locations, and the list is capped at
`max_violations_per_gate` (default 25) with `truncated: true` when the cap
dropped entries. So `truncated: false` does **not** imply
`violations.length === violation_count` — the `security-violations` fixture
pins exactly that case. A consumer reading `violations.length` as the count is
reading the wrong field, in either implementation.

### 2. Additive keys, and the rule that makes them legal

`*` marks the two **TypeScript-only** keys. An advisory is something a gate
reports without failing on it — `skipLibCheck`, non-null assertions, `audit`
findings below the severity floor. Advisories use the `ViolationPayload` shape
but ride in their own list, because every consumer today treats an entry in
`violations` as something to go and fix. Nothing in `passed`, `exit_code` or
`violation_count` reads them, and none reaches the journal.

They are legal at `schema_version` 1 because they are **additive and provably
unread**. The proof, which any future additive key must repeat:

1. Find every place the other implementation *reads* the structure — not where
   it writes one. For gate objects that is `src/kragg/journal.py`, which
   indexes five named keys (`name`, `passed`, `skipped`, `duration_ms`,
   `violation_count`) and ignores everything else. `report.py` only ever
   writes.
2. Run the other implementation's readers against a real payload from yours.
3. Confirm no key it declares went missing and anything it persists is
   byte-shape-identical.

That was done for `advisories`/`advisory_count`. **Do not assume the next one
is equally safe.** Renaming, repurposing or retyping an existing key is never
additive; neither is adding an entry to a structure a consumer *iterates*
rather than indexes, which is why the criticality freshness stamp is a sidecar
file (section 5) and not a record in `criticality.json`.

The cross-language runner reports an unknown gate key as a *note*, because it
cannot prove "unread" — a human must. `test/conformanceContract.ts` is
deliberately stricter and **fails** on a third additive key, so a new wire key
cannot reach `main` without someone redoing the proof above.

### 3. Exit codes

| Code | Meaning |
| --- | --- |
| 0 | all gates passed — a skipped gate is not a failure |
| 1 | gates ran and found violations |
| 2 | usage error, or unusable config |
| 3 | environment broken — a gate could not run |

Exit 3 outranks exit 1: when the environment is broken the other findings are
unreliable, so `exit_code = 3 if any(error) else (0 if passed else 1)`. Config
errors are 2, not 3 — a file the implementation cannot parse is the user's
input being wrong, not the machine being broken, and exit 3 would send the
reader off to reinstall a toolchain over a missing brace. When a report is
emitted the process status equals `report.exit_code`. Python names the four
constants in `report.py` (`EXIT_OK`/`EXIT_GATE_FAILURES`/`EXIT_USAGE`/
`EXIT_ENVIRONMENT`); TypeScript re-exports them from `src/index.ts`.

### 4. Pipeline semantics

All FAST gates run even after one fails, so one invocation reveals every
failure. SLOW gates skip once any FAST gate has failed — reason `static gates
failed` — unless forced with `--all`. `--fail-fast` halts the pipeline and
reports every remaining gate as skipped with reason `fail-fast` rather than
omitting it: the report always lists the whole pipeline. See
[`src/engine/gate.ts`](../src/engine/gate.ts), ported from `check.py`.

"Has failed" means **ran and did not pass** — `!passed && !skipped`, the same
arithmetic `summary.gates_failed` uses. A skip never halts the SLOW tier and
never trips `--fail-fast`; an error does both, because nothing was learned and
the slow tier would be measuring the same broken environment. A gate whose
`run` throws is reported as that gate's `error: true` result and the rest of
the pipeline still runs. This is where the two implementations differ today:
Python's `run_gates` branches on `if not result.passed`, which counts a visible
skip as a failure, and has no `try` around a gate. See rows 13 and 14 of the
divergence table.

The three-state outcome is contract, not rendering: a gate that ran clean
(`passed`), a gate that deliberately did not run (`skipped` with a
`skip_reason`), and a gate that *could not* run (`error: true`) are three
different facts and must stay three. A gate whose policy input is empty — no
layers for `boundaries`, no `forbidden_calls`, no `secret_name_suffixes` —
skips **visibly**, with a reason naming what is unconfigured.

Modes: `full`, `file` (`--file`), `changed` (`--changed`/`--since`). The latter
two are incremental and SLOW gates skip with reason `incremental mode`.

### 5. `.kragg/criticality.json` and the sidecar stamp

The file is a **list** of profile records, written by Python's `write_json` as
`{name, fan_in, fan_out, betweenness, is_critical, risk}` and read back by
`read_json` in `crag/src/kragg/gates/criticality.py`:

```python
if not isinstance(data, list):
    return []
return [entry for entry in data if isinstance(entry, dict)]
```

**This is why kragg-ts's freshness fingerprint is not in that file.** The top
level is a list, so there is nowhere to put a metadata object that Python would
not hand straight back to its callers as a profile record — a record with no
`name` would flow into gates that expect one. Repeating a whole-tree fact
across all N records instead would still change what Python reads.

So kragg-ts writes a **separate file**, `.kragg/criticality.stamp.json`
(`version`, `scan_paths`, `files`, `bytes`, `newest_mtime_ms`), and
`criticality.json` stays byte-compatible with what both tools already write.
Python cannot observe the difference: it never opens the sidecar, and the file
it does open is unchanged. See
[`src/gates/criticality/freshness.ts`](../src/gates/criticality/freshness.ts)
for the full argument and the two known gaps in the fingerprint.

The numbers are the contract. `betweenness` is normalized betweenness
centrality to 4 decimal places (kragg-ts reproduces networkx's algorithm; a
Python `0.0` and a TypeScript `0` are the same number). Records are sorted by
descending `(betweenness, fan_in)` and truncated to the top 20; **order among
ties is implementation-defined**, so both suites sort canonically before
diffing. The `criticality-sidecar` fixture pins both files; every other fixture
validates whichever of them a run happens to leave behind.

### 6. `.kragg/history.jsonl` (the journal)

Append-only JSON Lines, one entry per run, written by every `check`/`security`
run unless `--no-journal`, rotated at 1000 lines down to the most recent 500.
Both sides write the identical entry:

```
schema_version, ts, command, mode, git_sha, git_dirty, passed,
exit_code, duration_ms, gates[]
gates[]: name, passed, skipped, duration_ms, violation_count
```

Those five gate keys are the **entire read surface of a gate object** in either
sibling, which is what makes additive gate keys safe (section 2). A
half-written final line from an interrupted run is skipped by the reader on
both sides, not treated as corruption; the `journal-reader` fixture ships a
journal that ends mid-token and asserts `status --format json` returns the two
complete entries. Journal writes never fail a check.

### 7. The `hook claude` stdin protocol

Both CLIs expose `kragg hook claude` (Python: `cli.py`'s `hook` subparser with
`choices=("claude",)`; TypeScript: `src/commands/hook.ts`). It reads one Claude
Code hook payload from stdin and answers on stdout.

Consumed from the payload, all optional and all narrowed rather than trusted:
`hook_event_name`, `tool_name`, `tool_input.file_path`, `stop_hook_active`,
`source`, `cwd`. Unknown keys are ignored; a payload that is not a JSON object
degrades to a no-op rather than crashing.

Emitted, on **exit 0 only** — Claude Code parses hook stdout JSON at exit 0 and
nowhere else:

- `{"decision":"block","reason":...}` for PostToolUse and Stop, which is the
  shape whose `reason` reaches the model. A Stop carrying `stop_hook_active` is
  a no-op, or a repo with one unfixable violation would block every stop
  forever;
- `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}`
  for SessionStart — see divergence 11 below.

Output is truncated at 9000 characters with an in-band marker, because the
harness spills over-long hook output to a file where the model never sees it.
The hook returns 0 on *any* internal failure — the one deliberate fail-open in
kragg, since a broken guardrail must not become a broken editing session. See
[`src/hooks/protocol.ts`](../src/hooks/protocol.ts) and
[`src/hooks/claude.ts`](../src/hooks/claude.ts).

### 8. Configuration

Same key vocabulary, snake_case, on both sides; only the carrier differs —
`kragg.toml` / `pyproject.toml [tool.kragg]` in Python, `kragg.json` /
`package.json` `"kragg"` here. The standalone file wins outright; there is no
merging. kragg-ts adds tool-selection keys (`lint_tool`, `test_runner`,
`secret_scanner`, `audit_severity`) that have no Python analogue, where `"off"`
is a deliberate, visible disable: the gate SKIPs with a reason saying so.
Malformed *values* fail closed to the stricter default; a file that cannot be
parsed at all is a usage error (exit 2).

## 9. Fixtures in this repository

`test/fixtures/conformance/<name>/` holds `fixture.json` (the manifest: the
spec revision and crag commit it was recorded against, the argv, the expected
exit, the setup, and any divergence records), `project/` (a self-contained
source tree), and `expected.json` (the golden). `test/conformance.test.ts`
copies each project to a temp directory **outside this checkout** — a fixture
run from inside it would find kragg-ts's own `node_modules/.bin/tsc` and
`git_sha`, and stop testing what it claims to — drives the CLI through
`runCommand`, and diffs.

| fixture | what it pins |
| --- | --- |
| `security-clean` | exit 0; `git_sha: null` survives normalization; two skip reasons; a skipped gate is not a failure |
| `security-violations` | exit 1; dedupe vs. `truncated` vs. `violation_count` (section 1); `static gates failed` on the SLOW tier |
| `check-missing-tsc` | exit 3; the whole 18-gate pipeline; a gate that cannot run is `error`, with remediation in `raw_output` and a `Fix:` line in `next_actions`; non-null `git_sha` |
| `config-error` | exit 2; no report; the reason on stderr |
| `criticality-sidecar` | the shared list, the six record keys, the numbers, and the sidecar beside it |
| `journal-reader` | the reader half of section 6: a half-written final line is skipped, not fatal |
| `hook-protocol` | six stdin payloads: invalid JSON, a non-object, unknown keys, a non-source edit, the stop-loop guard, the SessionStart envelope, and the blocking shape — all exit 0 |

Every run's `.kragg/history.jsonl`, `.kragg/criticality.json` and
`.kragg/criticality.stamp.json` are validated wherever they appear, not only in
the fixtures that are about them.

**One limitation, stated.** `hook-protocol` does not spawn a process. The hook
needs a payload on stdin and `src/engine/runner.ts` — the repository's single
sanctioned subprocess wrapper — has no stdin channel, because gates never take
input. Widening it for a test would be the wrong trade, so the hook cases call
`cmdHook` with the same `runCheck`/`ensureCriticality` the CLI wires and the
`readStdin` seam that module already exposes. What that misses is the process
boundary; crag's own `hook` fixture covers the spawned form from the Python
side.

## 10. What is normalized, and why

Both suites diff **normalized** payloads, and the rule list is SPEC.md
section 9's, unchanged. Everything not listed here is compared exactly —
including gate order, violation order, skip-reason text, messages, counts,
`targets`, `next_actions` wording, and the null-vs-absent distinction
everywhere.

| field | rule | why it varies between conforming runs |
| --- | --- | --- |
| `kragg_version` | → `"<kragg-version>"` | changes every release; the contract is "a string", not its value |
| `started_at` | → `"<started-at>"` | wall clock |
| `duration_ms`, report and per gate | → `0` | wall clock. Normalized only **after** the validator has checked that the report total equals the sum of the gates, so this cannot hide a broken total |
| `git_sha` | → `"<git-sha>"` when it matches `[0-9a-f]{7,40}` | the fixture repository is created at run time. `null` stays `null`: null-vs-present is contract, and `security-clean` pins the null |
| absolute paths in any string | fixture root → `<project>`, this repo → `<kragg-repo>`, macOS `/private` aliases included | the temp directory differs per run and per machine. The messages embedding them — remediations, tsc output — are otherwise contractual and stay exact |
| criticality record order | sorted by `(-betweenness, -fan_in, name)` | tie order is implementation-defined (section 5) |
| `newest_mtime_ms` in the stamp | → `0` | the mtime of the copied fixture tree |
| `(N.Ns)` inside hook stdout | → `(0.0s)`, and **only** for a case whose manifest sets `live_durations` | wall clock rendered into a block reason by gates that just ran. The SessionStart case does not set it: its numbers are read back out of the committed journal, are fixed, and stay pinned. The cross-language runner normalizes both, because every payload it records comes from a live run |

Nothing else. Adding a rule here is a contract decision: an over-normalized
diff hides real breaks, an under-normalized one cries wolf and gets switched
off. In particular, **a semantic mismatch is never normalized away** — it is
recorded in section 11 if it is intentional, or in section 12 if it is a bug.

## 11. Intentional divergences

A conformance runner must not flag these; a suite that diffs the two
implementations naively will flag every one. Rows 1–9 are this repository's
original table, re-verified against both trees while the spec was written; rows
10–12 were added by that verification and are also SPEC.md section 10's rows
10–12; rows 13–16 were introduced by TOR-1358, TOR-1363 and TOR-1361 on this branch. Fixtures that exercise a row carry a `divergences` entry naming its id.

| # | Divergence | Why it is intentional |
| --- | --- | --- |
| 1 | `complexity`: a `switch` scores **+1 total, not +1 per `case`** | Measured: per-case failed 5% of blocks, worst offenders flat dispatch tables. A deliberate departure from McCabe, radon and Python. |
| 2 | `nullable-default` is a **redesign** | `.get(k, default)` has no JS analogue; the gate targets `\|\|` mis-coalescing instead, calibrated *below* the Python original's hit rate. |
| 3 | `forbidden-calls` resolves through `ts.TypeChecker` | Closes cases Python leaves unresolved (subclass overrides, unannotated receivers, re-export chains). Same gate name, strictly larger recall. |
| 4 | `structure` counts real `export` declarations | Python uses the leading-underscore convention, which JavaScript does not have. `export *` is enumerated. |
| 5 | `halstead` thresholds are the same numbers but not the same gate | Ported literally onto TypeScript's wider operator/operand partition they fire on ~0.3–0.6% of blocks. |
| 6 | TS bundles no tools: `lint`, `detect-secrets`, `audit` and `test-coverage` resolve from the project | npm cannot ship another ecosystem's tools. Absence is a **visible skip**, never a silent pass. Pinned by `security-clean` and `check-missing-tsc`. |
| 7 | `secret_name_suffixes` includes `ServiceKey` | Python's default list lacks `_service_key`. A Python gap found during the port; see KNOWN_LIMITATIONS.md. |
| 8 | criticality freshness: TS refuses stale data via the sidecar stamp; Python consumes a stale file as current | The *file* is identical; the trust decision is not. Pinned by `criticality-sidecar`. |
| 9 | module naming: TS repo-root-relative `module#name`, Python package-relative dotted | A TypeScript relative specifier is a filesystem path; a Python one is not. Pinned by `criticality-sidecar`. |
| 10 | criticality-dependent gates with missing or stale data: **TS derives it on demand** and the gates run; **Python skips them visibly** | Both refuse to trust stale data. TS can afford to recompute because the check pipeline already holds a `ts.Program` (`src/catalog/criticalityCache.ts`). Pinned by `check-missing-tsc`, which leaves derived data behind. |
| 11 | SessionStart hook output: TS emits the `hookSpecificOutput` envelope; Python prints plain-text context lines | Both are consumed by Claude Code, but only the envelope injects `additionalContext`. Predates the spec; a candidate for convergence. Pinned by `hook-protocol`. |
| 12 | `next_actions` fix wording: Python says "auto-fix N **ruff** violations", TS says "auto-fix N violations" | Tool vocabulary is implementation-specific. |
| 13 | a SKIP does not halt the SLOW tier or `--fail-fast` | Python's `run_gates` branches on `if not result.passed`, and a visible skip is `passed=False, skipped=True`, so one gate stepping aside from inside its own run skips every slow gate with `static gates failed`. `crag/spec/SPEC.md` §2.3/§4.1 make the three states a contract and define `gates_failed` as not-passed-and-not-skipped; kragg-ts follows the spec. Recorded as a Python gap in KNOWN_LIMITATIONS. |
| 14 | a gate that THROWS is an errored gate, not a dead process | Python's `run_gates` has no `try`, so an exception inside a gate kills the process and takes the consolidated report with it. `crag/spec/SPEC.md` §4.3 already names the outcome for a gate that could not run — `error: true`, `passed: false`, remediation in `raw_output`, exit 3 — and kragg-ts produces exactly that, so the remaining gates still run and still report. Recorded as a Python gap in KNOWN_LIMITATIONS. |
| 15 | config values are validated, not defaulted | SPEC §8 describes Python: a type-mismatched value falls back to the default and a malformed `forbidden_calls` hint degrades to `""`. kragg-ts rejects a wrong type, an out-of-range budget, a non-string list element or hint, a wrong-shaped `package.json#kragg` and any unknown key with exit 2, naming the setting (`kragg.json#forbidden_calls[1] must be a string (got 7)`). A ban list read as *no bans* and a misspelled key that configures nothing are the fail-open cases this closes. Strictly narrower: everything Python reads as written loads identically. `kragg.schema.json` mirrors the rules for editors. |
| 16 | `criticality.json` holds the **whole** ranked graph | Python's `analyze_criticality(top_n=20)` truncates the analysis itself, so its sidecar — the input every criticality gate enforces on — carries at most twenty records. kragg-ts truncates only the `CRITICALITY.md` tables and the terminal table, and persists every ranked function. Record SHAPE, key order and ranking are unchanged; only the number of records differs, and the `criticality` fixture is `applies_to: ["python"]`, so no TypeScript golden covers it. |

Four defects found in the Python implementation during the port are recorded in
[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md#found-in-the-python-implementation-during-this-port).
They are gaps to fix upstream, not divergences to encode.

## 12. Recorded drift in the Python sibling

SPEC.md section 11 lists five places an implementation violates the spec. These
are bugs to fix upstream, **not** contract, and nothing here is changed to
match them. Two are pinned from this side, because kragg-ts implements the
contract and Python has not converged:

1. **Malformed config exits 1 with a traceback, not 2.** `load_policy` lets
   `tomllib.TOMLDecodeError` escape. kragg-ts maps `PolicyError` → exit 2;
   crag's own `config-error` fixture carries a `known_failure.python` marker,
   and this repo's `config-error` fixture pins the correct behaviour.
2. **`detect-secrets` scans nothing outside a git repository** and never sees
   untracked files, because it enumerates targets via `git ls-files` — so the
   gate can pass having checked nothing.
3. **Hook output is not truncated.** A very large failure report silently loses
   its blocking message's content in the harness. kragg-ts caps at 9000
   characters with an in-band marker; `hook-protocol` records that as drift, so
   nobody removes the cap to "match Python".
4. **`criticality.json` tie order is not deterministic** — it falls back to
   `set` iteration order, which varies with `PYTHONHASHSEED`. Both runners sort
   canonically; the instability at the top-20 cut is not absorbable and needs a
   total sort key upstream.
5. **This document used to be wrong**, and SPEC.md section 11 item 5 said so:
   it omitted row 10 above and described SessionStart as a shared emitted
   shape. Both are fixed here.

## 13. Found in kragg-ts while building this suite

**A FAST gate that skipped at RUN time used to trip the SLOW tier as if it had
failed.** SPEC.md section 4.1 says SLOW gates skip once any FAST gate has
*failed*, reason `static gates failed`; `runGates` set `fastFailed` from
`!result.passed`, and a skipped gate is `passed: false` by contract, so on this
repository (no secret scanner installed) `detect-secrets` skipping silently
skipped `test-coverage`, `critical-coverage` and `audit` under "0 failed", exit
0. Found while building this suite and **fixed by TOR-1358** in the same
release: the halt condition is now `!passed && !skipped` (section 4, divergence
row 13), and `test/engine.test.ts` / `test/catalog.test.ts` pin it. No
conformance fixture pins the old behaviour.

## 14. Changing the contract

Any change to the six surfaces — the report schema, the exit codes, the
pipeline semantics, the journal, the criticality file, the hook protocol — is a
change to **both** repos and needs a `schema_version` bump, a new spec
revision, and regenerated goldens on both sides (`run_conformance.py --update`
there, `KRAGG_CONFORMANCE_UPDATE=1` here), each reviewed as a diff. Do not make
one implementation "temporarily" divergent — that is how the two stop being
siblings. The single carve-out is the additive-key rule in section 2, and the
bar is not "additive" but **additive and provably unread**, with the three-step
proof performed rather than assumed.
