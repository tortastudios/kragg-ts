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
  --file <path>          scope to this file or directory (repeatable; a
                         directory scopes to the source files under it, and a
                         path that does not exist is a usage error)
  --format text|json     output format (default: text)
  --max-violations <n>   cap violations shown per gate
  --no-journal           do not append to .kragg/history.jsonl

Options for check only:
  --changed              only files changed against HEAD
  --since <ref>          only files changed since <ref>
  --fail-fast            stop at the first failing gate
  --all                  run slow gates even after a fast gate failed

--changed and --since run a FULL check instead when the change set includes a
configuration or dependency input (kragg.json, tsconfig*.json, package.json, a
lockfile, a linter or test-runner config, the secret baseline) or when its only
source change is a deletion: all of those change what every gate concludes.
The report says mode "full", and the reason is printed on stderr. A change set
with nothing to check is exit 0; git being unable to answer is exit 3.

Options for fix:
  --file <path>          format and fix only this file (repeatable)

Options for status:
  --format text|json     output format (default: text)
  --last <n>             how many runs to read (default: 10)

Options for map and spec:
  --path <path>          only this file or directory (repeatable)
  --symbol <name>        map: an exported name, Class.method, or the exact
                         <module>#<name>; spec: a case-insensitive substring
                         of a test or describe title (repeatable)
  --changed              only files changed against HEAD
  --limit <n>            how many entries to print (default: 100)
  --all                  print every entry (the same as --limit 0)
  --format text|json     output format (default: text); json carries total,
                         shown and truncated beside the entries

Options for map only:
  --write                also write the FULL inventory to .kragg/map.md
                         (not with --path, --symbol or --changed, whose
                         output is a view and not the project's inventory;
                         --limit is fine and never trims the file)

Options for brief:
  --since <ref>          digest the changes since <ref>
  --path <path>          only changed files under this path (repeatable)
  --limit <n>            how many changed files to list (default: 100)
  --all                  list every changed file (the same as --limit 0)

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
  --last <n>             journal entries to mine (default: 10)
  --rerun <n>            instead: re-run the suite n times, under the same
                         test_runner and test_paths as check's test gate, and
                         tally each test. Exit 3 if any run did not complete
                         the suite; exit 1 if any test failed.

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
