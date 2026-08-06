/**
 * The agent-facing contract documents written into every scaffolded project.
 *
 * `AGENTS.md` is the product. Everything else in the scaffold — the layered
 * directories, the pinned versions, the hook registration — exists so that the
 * rules stated here are checkable rather than aspirational, and the gates
 * exist so the rules are enforced rather than read once and forgotten.
 *
 * This is a REWRITE of the Python `AGENTS_MD`, not a translation. The
 * structure and the enforcement tone are the same; every rule is restated in
 * terms of things that are actually true about TypeScript. A rule about
 * Pydantic or `dict.get` in a TypeScript project teaches an agent that the
 * contract is decorative.
 */

/** The canonical agent contract, written to `AGENTS.md`. */
export const AGENTS_MD = `# Agent Contract

This project is guarded by \`kragg\`. Gates are enforced, not advisory: if a
gate fails, fix the failure before moving on to unrelated work.

## Commands

Always run through the project's own toolchain (\`pnpm exec\`), never a global
install — a globally-resolved \`kragg\` reads a different config and a
different TypeScript than the project does.

| When | Command |
| --- | --- |
| Before writing new code (discover what exists) | \`pnpm exec kragg map\` |
| Adding a feature area | \`pnpm exec kragg gen module <name>\` |
| After editing TypeScript files (inner loop) | \`pnpm exec kragg check --changed\` |
| Before claiming a task is done | \`pnpm exec kragg check\` |
| Machine-readable results | \`pnpm exec kragg check --format json\` |
| What failed last run (without re-running) | \`pnpm exec kragg status\` |
| Summarize the change set for review | \`pnpm exec kragg brief\` |

## Exit codes

- \`0\` all gates passed
- \`1\` gates ran and found violations — fix the reported \`file:line\` findings
- \`2\` usage error — fix the command invocation
- \`3\` environment broken — a gate could not run; fix the reported tool or
  config problem. A gate that cannot run is NEVER a pass.

## Layout

Layered architecture, enforced by the \`boundaries\` gate. A lower layer may
never import a higher one:

- \`src/entrypoints/\` — CLI / HTTP / MCP surfaces. Thin. Parse input, call a
  service, format output. No business logic.
- \`src/services/\` — orchestration. The only layer entrypoints may call.
- \`src/domain/\` — pure data and rules. Imports nothing above it, and nothing
  that does I/O.

Create new modules with \`pnpm exec kragg gen module <name>\` — it generates the
domain, service, and test slots, so everything has exactly one place to live.

Relative imports carry a literal \`.ts\` extension (\`./greeting.ts\`). That is
what lets Node run the sources directly; \`tsc\` rewrites the specifier to
\`.js\` on build. Do not "fix" it to \`.js\` in source, and do not drop it.

## Typing rules

The \`typing-strictness\` gate audits \`tsconfig.json\` AND scans for escape
hatches. These are violations, not style preferences:

- No \`any\` — not as an annotation, not as \`x as any\`, not as \`<any>x\`.
- No \`x as unknown as T\`. A double cast launders any value into any type; it
  is the strongest lie available in the language.
- No \`@ts-ignore\` and no \`@ts-nocheck\`. If a suppression is genuinely
  unavoidable, use \`@ts-expect-error <reason>\` WITH a reason — a bare one is
  itself a violation, because it hides the next error too.
- No \`Function\` as a type; write the call signature out.
- Prefer a named \`interface\` or \`type\` over an inline shape that nests. The
  \`type-complexity\` gate fails annotations that nest or run long instead of
  being given a name.
- Prefer early returns over nested conditionals. Keep functions short.

## External and nullable data

**Everything that crosses a boundary is \`unknown\` until it is validated.**
This is the bug class the gates exist for, and TypeScript makes it easy to get
wrong because its guarantees stop at the edge of the program.

- \`JSON.parse\` returns \`any\`. So does an untyped \`await response.json()\`.
  Assigning that to a typed variable is a type ASSERTION with no check behind
  it: the shape is whatever the server sent. Parse every API, JSON, env, queue,
  or database payload through a runtime schema (a validation library, or a
  hand-written type predicate \`function isX(v: unknown): v is X\`) at the
  boundary where it enters, and pass the validated type inward.
- Nullable fields are typed \`T | null\` or \`T | undefined\` and narrowed
  before use — never asserted away with \`!\`.
- \`noUncheckedIndexedAccess\` is ON, and it is load-bearing:
  \`process.env.PORT\` is \`string | undefined\`, an array index is
  \`T | undefined\`, and a \`Record<string, T>\` lookup is \`T | undefined\`.
  When the compiler starts complaining about a \`| undefined\` you did not
  expect, it is right. Handle the missing case; do not assert it away.
- **\`??\` versus \`||\`.** \`||\` falls back on every falsy value, so
  \`Number(process.env.PORT) || 8000\` silently rewrites a configured port
  \`0\`, \`timeout || 30\` rewrites a deliberate \`0\`, and \`name || "world"\`
  rewrites a deliberate empty string. Use \`??\`, which falls back only on
  \`null\` and \`undefined\`. The \`nullable-default\` gate flags the falsy
  cases it can see; the ones it cannot are yours to test.
- Every nullable field gets a test for its null/missing case. The gates enforce
  the modeled cases; a value typed non-null that is really nullable is the
  residual, and only a test finds it.

## Security contracts

- **Secrets are required, never defaulted.** Read them with no fallback so a
  missing value fails loudly at startup, and validate them non-empty at the
  boundary:

  \`\`\`ts
  const apiToken = process.env["API_TOKEN"];
  if (apiToken === undefined || apiToken === "") {
    throw new Error("API_TOKEN is required");
  }
  \`\`\`

  \`process.env["API_TOKEN"] ?? ""\` is the bug: the process starts, signs with
  an empty key, and fails somewhere far away with an unrelated message. The
  \`secret-default\` gate fails blank and hardcoded fallbacks.
- Never hardcode a credential, in source or in a test fixture.
- **Wrapper discipline.** When an unsafe API needs a bounded or validated
  wrapper — raw SQL, \`child_process\`, unbounded request-body reads,
  \`eval\` — build the wrapper in \`src/services/\`, ban the raw API in
  \`kragg.json\` under \`forbidden_calls\` with a hint naming the wrapper, and
  mark the wrapper's OWN call site with a trailing \`// kragg: ignore\`. One
  audited call site, banned everywhere else. The \`forbidden-calls\` gate
  enforces the ban on every change; the ignore comment is the single documented
  exception, not a way to quiet the gate wherever it is inconvenient.
- Never suppress a security or typing finding without an explicit written
  reason at the suppression site.

## Critical code

Before editing any function listed in \`CRITICALITY.md\`, apply extra scrutiny:
full parameter and return types, a doc comment stating the contract, and a test
for every behavior you changed. Those functions are the ones the rest of the
program depends on most; a regression there is not local.
`;

/** `CLAUDE.md` — a pointer, so there is exactly one contract to maintain. */
export const CLAUDE_MD = `Follow the rules in AGENTS.md. It is the canonical
agent contract for this repository.
`;

/** `CRITICALITY.md` placeholder, replaced once the criticality gate runs. */
export const CRITICALITY_MD = `# Critical Functions

> Generated by \`kragg criticality --write\`.

No critical functions have been analyzed yet.
`;
