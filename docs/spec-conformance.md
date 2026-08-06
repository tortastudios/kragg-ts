# Spec conformance

`kragg` exists in two implementations:

- **Python** — `tortastudios/crag`, package `kragg`. The reference
  implementation and, today, the source of truth.
- **TypeScript** — this repo, `tortastudios/kragg-ts`, package `kragg` on npm.

They are siblings, not a port and a fork. An agent or a CI job must be able to
consume either one's output without knowing which produced it.

## Where the spec lives

> **Status: still not created.** `crag/spec/` does not exist as of 2026-08-06.
> `crag/src/kragg/report.py` remains the de facto authority, and this repo's
> `src/engine/reportPayload.ts` was ported from it directly.

Everything below is therefore a description of what the two implementations
*do*, verified against both trees, not a normative document either one was
written against. That gap is the whole reason this file exists.

## The shared surface, as implemented

Five things are shared. Gate *names* and the set of gates offered are not:
`ruff-lint` has no TypeScript analogue and does not need one, and `lint` here
drives whichever of oxlint/biome/eslint the project installed. What is shared
is the shape of the report that carries them.

### 1. The report JSON, `schema_version: 1`

Both sides emit the same keys, in the same nesting, with `null` rather than an
absent key for anything missing — consumers index unconditionally. Keys are
snake_case on the wire in both languages; TypeScript keeps camelCase
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
                violation_count, violations, truncated, raw_output
ViolationPayload  file, line, column, code, message, fix_hint
```

`violation_count` is the true total; `violations` may be capped
(`max_violations_per_gate`, default 25) with `truncated: true` saying so. A
consumer that reads `violations.length` as the count is reading the wrong
field, in either implementation.

### 2. Exit codes

| Code | Meaning |
| --- | --- |
| 0 | all gates passed (a skipped gate is not a failure) |
| 1 | gates ran and found violations |
| 2 | usage error, or unusable config |
| 3 | environment broken — a gate could not run |

Exit 3 outranks exit 1: when the environment is broken, the other findings are
unreliable. Python names the same four constants in `report.py`
(`EXIT_OK`/`EXIT_GATE_FAILURES`/`EXIT_USAGE`/`EXIT_ENVIRONMENT`); TypeScript
re-exports them from `src/index.ts`.

### 3. Pipeline semantics

All FAST gates run even after one fails, so one invocation reveals every
failure. SLOW gates skip once any FAST gate has failed, unless forced
(`--all`). `--fail-fast` halts the pipeline and reports every remaining gate as
skipped with reason `fail-fast` rather than omitting it. See
[`src/engine/gate.ts`](../src/engine/gate.ts), ported from `check.py`.

The three-state outcome is part of the contract, not a rendering detail: a gate
that ran and found nothing (`passed`), a gate that deliberately did not run
(`skipped: true` with a `skip_reason`), and a gate that *could not* run
(`error: true`) are three different facts and must stay three.

### 4. `.kragg/history.jsonl`

Append-only JSON Lines, one entry per run, rotated at 1000 lines down to the
most recent 500. Both sides write the identical entry:

```
schema_version, ts, command, mode, git_sha, git_dirty, passed,
exit_code, duration_ms, gates[]
gates[]: name, passed, skipped, duration_ms, violation_count
```

A half-written final line from an interrupted run is skipped by the reader on
both sides, not treated as corruption of the file.

### 5. `.kragg/criticality.json`, and the sidecar stamp

The file is a **list** of profile records, written by Python's `write_json` as
`{name, fan_in, fan_out, betweenness, is_critical, risk}` and read back by
`read_json` in `crag/src/kragg/gates/criticality.py`:

```python
if not isinstance(data, list):
    return []
return [entry for entry in data if isinstance(entry, dict)]
```

**This is why kragg-ts's freshness fingerprint is not in that file.** The top
level is a list, so there is nowhere to put a metadata object that Python
would not hand straight back to its callers as a profile record — the filter
above keeps any dict it finds, and a record with no `name` would flow into
gates that expect one. Repeating a whole-tree fact across all N records instead
would still change what Python reads.

So kragg-ts writes a **separate file**, `.kragg/criticality.stamp.json`
(`version`, `scan_paths`, `files`, `bytes`, `newest_mtime_ms`), and
`criticality.json` stays byte-compatible with what both tools already write.
Python cannot observe the difference: it never opens the sidecar, and the file
it does open is unchanged. See
[`src/gates/criticality/freshness.ts`](../src/gates/criticality/freshness.ts)
for the full argument and the two known gaps in the fingerprint.

A conformance suite should assert exactly this: that a kragg-ts run leaves
`criticality.json` readable by `read_json` with the same records, and that the
presence or absence of the sidecar changes nothing Python can see.

### 6. The `hook claude` stdin protocol

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
  shape whose `reason` reaches the model;
- `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}`
  for SessionStart.

Output is truncated at 9000 characters with an in-band marker, because the
harness spills over-long hook output to a file where the model never sees it.
The hook returns 0 on *any* internal failure — the one deliberate fail-open in
kragg, since a broken guardrail must not become a broken editing session. See
[`src/hooks/protocol.ts`](../src/hooks/protocol.ts) and
[`src/hooks/claude.ts`](../src/hooks/claude.ts).

## Intentional divergences a conformance suite must encode

These are not bugs to converge; a suite that diffs the two implementations
naively will flag every one of them. They are enumerated with their evidence in
[README.md](../README.md#differences-from-the-python-sibling) and
[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md).

| Divergence | Why it is intentional |
| --- | --- |
| `complexity`: a `switch` scores **+1 total, not +1 per `case`** | Measured: per-case failed 5% of blocks, worst offenders flat dispatch tables. A deliberate departure from McCabe, radon and Python. |
| `nullable-default` is a **redesign** | `.get(k, default)` has no JS analogue; the gate targets `\|\|` mis-coalescing instead, and is calibrated *below* the Python original's hit rate. |
| `forbidden-calls` resolves through `ts.TypeChecker` | Closes cases Python leaves unresolved (subclass overrides, unannotated receivers, re-export chains). Same gate name, strictly larger recall. |
| `structure` counts real `export` declarations | Python uses the leading-underscore convention, which JavaScript does not have. `export *` is enumerated. |
| `halstead` thresholds are the same numbers but not the same gate | Radon's worst effort across the entire Python implementation is 446 against a 50,000 limit; ported literally onto TypeScript's wider operator/operand partition it fires on ~0.3–0.6% of blocks. |
| `detect-secrets` / `lint` / `audit` bundle nothing | Python bundles ruff and driving a bundled tool is not portable to npm. Tools are resolved from the project's own `node_modules/.bin`, and absence is a visible skip. |
| `secret_name_suffixes` includes `ServiceKey` | Python's default list lacks `_service_key`. Listed in KNOWN_LIMITATIONS as a Python gap found during the port. |
| criticality freshness | kragg-ts refuses stale data via the sidecar stamp; Python consumes a stale `criticality.json` as if current. The *file* is identical; the trust decision is not. |
| module naming in the syntax tier | kragg-ts names modules relative to the repo root, Python relative to the package root, because a TypeScript relative specifier is a filesystem path and a Python one is not. |

Four defects found in the Python implementation during the port are recorded in
[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md#found-in-the-python-implementation-during-this-port).
They are gaps to fix upstream, not divergences to encode.

## What a conformance suite should look like

Fixture project in, expected report JSON out, run against **both**
implementations:

1. `spec/fixtures/<name>/project/` — a small, self-contained source tree plus a
   `kragg.json`. It must not depend on an installed external tool, or the
   fixture is testing the tool. Gates that would drive one are expected to
   report a *skip*, and the skip is part of the expected output.
2. `spec/fixtures/<name>/expected.json` — the full report payload, with the
   fields that legitimately vary (`kragg_version`, `started_at`,
   `duration_ms`, `git_sha`, per-gate `duration_ms`) normalized away by the
   runner rather than absent from the file.
3. A runner that executes `kragg check --format json` in the fixture project
   with each implementation and diffs against `expected.json`, asserting the
   **exit code** separately — a run that produces the right JSON with the wrong
   exit code has failed.
4. `spec/SPEC.md` — the normative, language-neutral prose: the schema, the exit
   codes, the pipeline semantics, the journal, the criticality file, and the
   hook protocol. Today that prose exists only as this file and as doc comments
   in both repos.
5. A tag per schema version, so a conformance run pins a spec revision. Pin by
   tag or commit SHA, never a moving branch: an upstream edit turning an
   unrelated PR red is how people learn to ignore a check.

Divergence fixtures belong in the same suite, in their own directory, asserting
that each row of the table above *stays* divergent. An intentional difference
nobody tests becomes an accidental one on the next refactor.

Until `spec/` exists that job cannot be written. `.github/workflows/ci.yml`
runs install, an assertion that `allowBuilds` is still empty, typecheck, build
and test — and carries a `TODO(spec)` where the conformance job goes, with the
pinned-tag requirement written into it so it cannot be added carelessly.

## Changing the contract

Any change to the report schema, the exit codes, the pipeline semantics, the
journal, the criticality file or the hook protocol is a change to **both**
repos and needs a `schema_version` bump. Do not make one implementation
"temporarily" divergent — that is how the two stop being siblings.
