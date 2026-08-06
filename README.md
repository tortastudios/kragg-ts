# kragg

Opinionated guardrails framework and CLI for AI-assisted TypeScript projects.

> **Status: 0.0.0 — scaffold.** The engine contract is ported and tested; no
> gates are wired up yet. `kragg check` and `kragg status` exit 2 and tell you
> they are not implemented. They will never print a passing report before
> they can actually check something.

This is the JS/TS sibling of the Python [`kragg`](https://github.com/tortastudios/crag).
Both emit the same report JSON schema and the same exit codes, so a CI job or
an agent can consume either without knowing which ran. See
[docs/spec-conformance.md](docs/spec-conformance.md).

## Why

Agents write a lot of code quickly. The bottleneck is not generation, it is
knowing whether what was generated is safe to keep. `kragg` is a single
command that runs a fixed pipeline of gates and reports every failure at once,
in a format an agent can act on directly — file, line, code, message, and a
concrete fix hint.

Two properties matter more than the gate list:

- **One invocation reveals every failure.** All fast (static) gates run even
  after one fails, so an agent never has to re-run to discover problem #2.
  Slow gates are skipped once a fast gate has failed, because their results
  would be invalidated by the fix anyway.
- **The output is honest.** A gate that could not run is exit code 3, not a
  pass. A skipped gate is reported as skipped, not omitted.

## Install

Not published yet.

## Usage

```
kragg <command> [options]

Commands:
  check      run the quality gates            (NOT IMPLEMENTED)
  status     show recent run history          (NOT IMPLEMENTED)

Options:
  -h, --help       show this help and exit
  -v, --version    print the version and exit
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | all gates passed (a skipped gate is not a failure) |
| 1 | gates ran and found violations |
| 2 | usage error |
| 3 | environment broken — a gate could not run |

Exit 3 outranks exit 1: when the environment is broken, the other findings
are unreliable.

## Configuration

Config is **data, not code** — there is no `kragg.config.ts` and there will
not be one. A config file that executes arbitrary TypeScript at load time
means the tool meant to guard your project runs untrusted project code before
any gate has looked at it.

Put settings in `kragg.json`, or under a `"kragg"` key in `package.json`.
A standalone `kragg.json` wins outright; the two are never merged.

```json
{
  "source_paths": ["src"],
  "test_paths": ["test"],
  "max_file_lines": 500,
  "forbidden_calls": {
    "child_process.exec": "use src/engine/runner.ts — it never uses a shell"
  }
}
```

Keys are snake_case, matching the Python implementation.

## Supply chain

This project has **zero runtime dependencies** and exactly two dev
dependencies (`typescript`, `@types/node`), both pinned to exact versions.
Installs run with dependency lifecycle scripts disabled, and no package is
permitted to run a build script. A 30-day minimum release age is enforced
mechanically, so a compromised version that is caught and unpublished within
the usual window is never installable here.

The full standing policy, and the list of deliberately-deferred candidate
dependencies, is in [docs/dependency-policy.md](docs/dependency-policy.md).
Read it before touching `package.json`.

## Development

Requires **Node 24** (see `.node-version`) and pnpm, pinned via corepack from
`package.json#packageManager`. The published package targets Node 20+; the
dev loop needs 24 because the tests import `.ts` sources directly through
Node's native type stripping, with no build step.

```sh
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run build
pnpm run test
```

`AGENTS.md` holds the contract for agents working in this repo, including the
hard rules that are not open to interpretation.

## License

MIT © Torta Studios, LLC
