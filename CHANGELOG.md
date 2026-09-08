# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because kragg's output is consumed by CI jobs and coding agents, two things
count as **breaking** here even though they are not API changes in the usual
sense:

- a change to the report JSON (`schema_version`, key names, value shapes), and
- a change to what an exit code means.

Both are a contract shared with the Python implementation. New *gates* and new
*violation codes* are additive and are not breaking, even though they can turn
a previously green run red — see [Gate additions](#gate-additions) below.

## [Unreleased]

### Fixed

- TOR-1360: `test-coverage` and `critical-coverage` accept only complete
  evidence from the current invocation. The runner writes into a private
  `.kragg/runs/` directory created for the run (so concurrent runs cannot read
  each other's artifacts); a runner that crashes, is killed by the timeout, or
  leaves a partial report (truncated JSON, an lcov ending inside a record, TAP
  with no summary) is `error: true` / exit 3 — previously a stale
  `.kragg/test-report.json` or `coverage/coverage-final.json` from an earlier
  run could pass the gate. Green tests with no usable coverage artifact are
  likewise an error (with any test failures still listed), not a plain
  failure. `critical-coverage` now consumes the coverage `test-coverage` just
  measured instead of re-reading disk, so switching from vitest to `node
  --test`/`bun test` can no longer select the older istanbul report over this
  run's lcov. The coverage artifact is published to `coverage_report_path`
  afterwards for `kragg coverage`. `kragg mutation` refuses to start Stryker
  while an earlier report it could not remove is still at the report path.

## [0.0.0] — unreleased

Initial implementation. Not published to npm.

### Added

**The engine and its contract**

- `kragg check` / `kragg security`, running a fixed pipeline of 18 gates in two
  tiers. All fast gates run even after one fails, so a single invocation
  surfaces every failure; slow gates skip once a fast gate has failed.
- Exit codes `0` pass / `1` violations / `2` usage or config error / `3`
  environment broken. Exit 3 outranks exit 1.
- `--format json` emitting `schema_version` 1 with snake_case keys, matching
  the Python implementation byte for byte.
- `.kragg/history.jsonl` run journal, and `kragg status` to read it back.

**Native gates** (no external tool, built on the TypeScript compiler API)

- `typing-strictness` — audits that `tsconfig.json` meets the strict floor,
  carries no escape hatches (`@ts-ignore`, `as any`, double casts,
  `@ts-nocheck`), **and covers every source file**.
- `complexity`, `maintainability`, `halstead` — radon's metrics over the
  TypeScript AST.
- `type-complexity` — annotation nesting and length budgets.
- `boundaries` — the layered import contract, resolving tsconfig `paths`
  aliases and following barrel re-export chains.
- `structure` — file-length and public-symbol budgets, enumerating `export *`.
- `forbidden-calls` — project-banned APIs resolved through `ts.TypeChecker`.
- `nullable-default` — `||` mis-coalescing a legitimate `0` / `""` / `false`.
- `secret-default` — secrets given silent fallback values.
- `critical-tests`, `test-quality`, `critical-coverage` — the test-depth gates.

**External tool adapters**, each resolved from the project's own
`node_modules/.bin` and skipping visibly with an install command when absent

- `lint` — oxlint, biome or eslint, auto-detected from project config.
- `tsc` — the project's own compiler.
- `test-coverage` — vitest, `node --test` or `bun test`; istanbul JSON and lcov.
- `audit` — npm, pnpm, yarn or bun.
- `detect-secrets` — gitleaks or secretlint. **No scanner is bundled.**

**Commands**

- `map`, `spec`, `brief`, `coverage`, `criticality`, `mutation`, `flaky`,
  `audit`, `doctor`, `policy show`, `fix`.
- `new` (`cli` | `api` | `mcp`), `gen module`, `init`.
- `hook claude` — reads hook JSON on stdin; fails open by design.

### Deliberate divergences from the Python implementation

Each is documented at the site, and collected in `README.md`.

- `forbidden-calls` resolves through the type checker, so subclass overrides,
  unannotated receivers and re-export chains are caught.
- `nullable-default` is a redesign; `.get(k, default)` has no JS analogue.
- Cyclomatic complexity scores a `switch` **once**, not once per `case`, on
  measured evidence that flat dispatch tables were failing the gate without
  being complex.
- `structure` counts real `export` declarations rather than a
  leading-underscore convention.
- `secret_name_suffixes` includes `ServiceKey`.
- Criticality data carries a sidecar freshness stamp so stale call-graph data
  is re-derived rather than trusted. `criticality.json` itself stays readable
  by the Python implementation.

### Known limitations

Stated in full in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). The short
version: complexity thresholds are Python's and were never recalibrated;
`nullable-default` is high-precision and low-recall by design; scaffold
templates for hono, fastmcp and `@modelcontextprotocol/sdk` were never
compiled; Stryker's handshake has never been executed; Windows is untested.

### Supply chain

- One runtime dependency (`typescript`) and one dev dependency
  (`@types/node`), both pinned to exact versions. No bundler, no test
  framework.
- pnpm pinned via corepack, dependency lifecycle scripts disabled, empty build
  allowlist, and a 30-day minimum release age enforced mechanically.

---

## Gate additions

A new gate, or a new violation code on an existing gate, can turn a
previously green run red without anything in your code changing. That is the
tool working, not a regression — but it is disruptive, so:

- New gates and codes are listed in the release notes, always.
- A new gate that requires configuration **skips visibly** until configured,
  rather than failing a project that has not opted in.
- Existing violation codes are not repurposed. If the meaning of a check
  changes, it gets a new code.
