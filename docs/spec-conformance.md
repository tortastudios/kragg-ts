# Spec conformance

`kragg` exists in two implementations:

- **Python** — `tortastudios/crag`, package `kragg`. The reference
  implementation and, today, the source of truth.
- **TypeScript** — this repo, `tortastudios/kragg-ts`, package `kragg` on npm.

They are siblings, not a port and a fork. An agent or a CI job must be able to
consume either one's output without knowing which produced it.

## The shared contract

Both implementations MUST agree on:

1. **The report JSON schema**, at `schema_version: 1`. Key names, nesting,
   and null-vs-absent semantics are identical. Keys are snake_case on the
   wire in both languages; the TypeScript side keeps camelCase internally and
   translates in exactly one place, `src/engine/report.ts`.
2. **Exit codes.**

   | Code | Meaning |
   | --- | --- |
   | 0 | all gates passed (a skipped gate is not a failure) |
   | 1 | gates ran and found violations |
   | 2 | usage error |
   | 3 | environment broken — a gate could not run |

   Exit 3 outranks exit 1: when the environment is broken, the other findings
   are unreliable.
3. **Gate pipeline semantics** — the fast/slow tiers, "all fast gates run so
   one invocation reveals every failure", "slow gates skip when a fast gate
   failed unless forced", and fail-fast halting. See `src/engine/gate.ts`.
4. **The journal format** — `.kragg/history.jsonl`, append-only, one entry
   per run.

Gate *names* and the specific gates offered are language-specific and are NOT
part of the contract. `ruff-lint` has no TypeScript analogue and does not need
one; the shape of the report that carries it does.

## Where the spec will live

> **Status: not yet created.** `crag/spec/` does not exist as of 2026-08-06.
> Until it does, `crag/src/kragg/report.py` is the de facto authority, and
> this repo's `src/engine/report.ts` was ported from it directly.

The plan is for the Python repo to grow a `spec/` directory holding:

- `spec/SPEC.md` — the normative, language-neutral description of the schema,
  the exit codes, and the pipeline semantics.
- `spec/fixtures/` — golden input/output pairs. Each fixture is a set of gate
  results plus the exact JSON and text output they must render to. Both
  implementations run the same fixtures.
- A version tag per schema version, so a conformance run pins a spec revision
  rather than tracking a moving branch.

## How CI will use it

Eventually, this repo's CI will clone `tortastudios/crag` at a **pinned spec
tag** (not `main`), feed `spec/fixtures/` through this implementation, and
diff the output. Until `spec/` exists, that job cannot be written, and CI
runs typecheck + build + test only.

When adding the job, pin by tag or commit SHA. A conformance suite that
tracks a moving branch turns an upstream edit into a red build on an
unrelated PR, and people learn to ignore it.

## Changing the contract

Any change to the report schema, the exit codes, or the pipeline semantics is
a change to **both** repos and needs a `schema_version` bump. Do not make one
implementation "temporarily" divergent — that is how the two stop being
siblings.
