/**
 * The `--help` text.
 *
 * IT IS A CONTRACT, NOT A BLURB. Every flag listed here must reach a handler
 * that reads it, and every flag a command accepts must be listed here — the
 * per-command tables in `cli.ts` are what enforce the other direction, by
 * making an unlisted flag an exit-2 usage error instead of a silent no-op.
 * `test/cli.test.ts` walks this text against those tables so the two cannot
 * drift apart unnoticed.
 *
 * Split out of `cli.ts` because the per-command option lists pushed that file
 * against the 500-line budget the `structure` gate enforces, and thinning the
 * help text to fit would have been the exactly wrong trade: the reason this
 * lives in one string is so a reader can see the entire surface at once.
 */

export const USAGE = `kragg — guardrails for AI-assisted TypeScript projects

Usage:
  kragg <command> [options]

Gates:
  check          run the quality gates
  security       run the security gates only
  fix            format and safely fix lint findings

Inventory and review:
  map            exported symbols, so nothing gets reinvented
  spec           the test suite rendered as a documentation tree
  brief          a reviewable digest of the change set
  status         show recent run history
  policy show    print the effective policy
  doctor         verify this project's setup

Test depth (on-demand, never the inner loop):
  coverage       uncovered lines in critical functions, ranked by fan-in
  criticality    call-graph risk -> CRITICALITY.md + .kragg/criticality.json
  mutation       mutation-test critical files with Stryker
  flaky          gates that flipped on an unchanged commit
  audit          dead code and dependency drift

Scaffolding:
  new <name>     a new project (--kind cli|api|mcp)
  gen module <n> service/domain/test slots in the layered layout
  init           add guardrails to an existing project

Harness integration:
  hook claude    hook adapter; reads hook JSON on stdin

Options for check and security:
  --file <path>          scope to this file (repeatable)
  --format text|json     output format (default: text)
  --max-violations <n>   cap violations shown per gate
  --no-journal           do not append to .kragg/history.jsonl

Options for check only:
  --changed              only files changed against HEAD
  --since <ref>          only files changed since <ref>
  --fail-fast            stop at the first failing gate
  --all                  run slow gates even after a fast gate failed
  --update-baseline      record this run's findings from the metric, structure
                         and test-quality gates as reviewed legacy debt in the
                         file kragg.json#baseline names (full runs only; the
                         security, compiler and evidence gates are refused)

Options for fix:
  --file <path>          format and fix only this file (repeatable)

Options for status:
  --format text|json     output format (default: text)
  --last <n>             how many runs to read (default: 10)

Options for map:
  --write                also write the inventory to .kragg/map.md

Options for brief:
  --since <ref>          digest the changes since <ref>

Options for criticality:
  --write                write CRITICALITY.md and .kragg/criticality.json
  --path <path>          scope the call graph to this file or directory
                         (repeatable; not with --write, whose output is the
                         whole project's critical set)

Options for mutation:
  --path <glob>          mutate these files instead of the critical set
                         (repeatable)
  --since <ref>          intersect the scope with the files changed since <ref>
  --all                  re-test every mutant instead of reusing Stryker's
                         incremental results
  --update-baseline      record the current survivors as accepted mutants

Options for flaky:
  --last <n>             how many journal runs to mine (default: 10)
  --rerun <n>            re-run the suite <n> times and rank tests by failure
                         ratio (default: 0, mine the journal only)

Options for init:
  --dry-run              print the changes init would make, and write nothing

Global options:
  -h, --help             show this help and exit
  -v, --version          print the version and exit

Every <n> above is a non-negative integer; anything else is a usage error, as
is a flag the command does not accept and an argument it has no use for.

Exit codes:
  0  all gates passed
  1  gates ran and found violations
  2  usage error (bad flags, unknown command, unusable config)
  3  environment broken (a gate could not run)
`;
