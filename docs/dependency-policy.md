# Dependency policy

This is a standing policy, not a suggestion. It applies to humans and agents
equally. The npm registry is the most actively attacked software supply chain
in wide use; a guardrails tool that is itself casually assembled from
dependencies has no standing to tell anyone else how to build software.

**Every rule below is a hard rule. If you are unsure whether something is
allowed, it is not. Open an issue instead.**

## The rules

### 1. Exactly one runtime dependency

`dependencies` is `{"typescript": "6.0.3"}` and stays that. Everything else
shipped to a user's machine is written here or comes from `node:`. Node 20+
has a good standard library — `node:util`'s `parseArgs`, `node:test`,
`node:child_process`, `node:fs`, `node:path` — and it is enough for a CLI.

**Why `typescript` is a runtime dependency and not a build-time one.** This
started as a zero-runtime-dependency project, and the earlier revision of this
file said so. It is no longer true, for a reason that does not generalize: kragg
analyzes TypeScript source, and **you cannot parse TypeScript without the
TypeScript compiler.** Every gate that reads an AST — `complexity`,
`halstead`, `type-complexity`, `structure`, `boundaries`, `forbidden-calls`,
`nullable-default`, `secret-default`, `criticality`, the test-depth gates —
goes through `ts.createSourceFile` or a `ts.Program`. Hand-rolling a
TypeScript parser to preserve a dependency count would be the worst trade in
the repository: thousands of lines of the hardest code here, wrong on syntax
the language adds every six months, producing confident findings about a
grammar it misread.

This does not weaken the posture, and the specifics are the argument:

- **Zero transitive dependencies.** `typescript@6.0.3` pulls nothing. Adding it
  added exactly one node to the tree.
- **No install scripts**, so `ignoreScripts: true` (rule 5) still means a
  compromised version cannot execute anything by being installed.
- **Microsoft-maintained**, with an enormous number of eyes on it, and it is a
  package every TypeScript project already has anyway — kragg is not asking a
  user to trust a party they did not already trust.
- **The project's own copy is preferred at runtime.**
  `resolveTypeScript` in [`src/analysis/compiler.ts`](../src/analysis/compiler.ts)
  resolves `typescript` from the *target project's* root first, exactly as the
  project's own code would resolve it, and only falls back to the bundled copy
  with a note that every report surfaces. So the bundled version is a floor,
  not the thing doing the analysis. Analyzing a TypeScript 5 project with a
  TypeScript 6 compiler would produce confident results about a language the
  project is not written in; that is the same refusal `environment.py` makes in
  the Python sibling when it will not run pytest on kragg's interpreter.

That combination — unavoidable, transitively empty, script-free, and preferred
from the project rather than from us — is the *only* reason it clears a bar
that almost nothing else does. **It is not a precedent.**

### 2. Minimal dev surface

`devDependencies` is exactly two packages:

| Package | Version | Why |
| --- | --- | --- |
| `@types/node` | `24.12.4` | Types for the `node:` builtins. |
| `oxlint` | `1.73.0` | The linter kragg-ts runs on its own source, through the same `lint` gate every project using kragg gets. |

`@types/node` pulls one transitive package, `undici-types`, from
DefinitelyTyped. Types only, no runtime code. `oxlint` is a single native
binary with **zero** dependencies of its own.

**Why a linter is approved here but not shipped as a runtime dependency.**
kragg-ts checks itself with its own `check --all`. That check includes the
`lint` gate, and the `lint` gate needs a linter to run. Without one installed,
`check --all` on this repo would report `lint` as skipped, which defeats the
point of dogfooding the tool on itself. `oxlint` was the pick: no
dependencies, a single Rust binary, and the fastest of the three linters kragg
supports (oxlint, biome, eslint). It runs only on this repository, at dev
time, through `pnpm exec oxlint`. It is never imported by any file under
`src/`, and it ships to nobody who installs `kragg-ts`.

**The whole installed tree is four packages.** `pnpm list --depth Infinity`,
which agrees with the entries in `pnpm-lock.yaml`'s `packages:` block:

```
kragg-ts@0.1.0
│   dependencies:
├── typescript@6.0.3
│   devDependencies:
├── oxlint@1.73.0
└─┬ @types/node@24.12.4
  └── undici-types@7.16.0

4 packages
```

No bundler. No test framework. No formatter. `node:test` is the test runner
and `tsc` is the build, and `tsc` comes from the runtime dependency above, so
the build needs nothing the shipped package does not already have.

### 3. Pin every version exactly

No `^`. No `~`. No `latest`. No `*`. No prereleases, betas, canaries, `next`
or `dev` tags. A caret range is a standing authorization for a stranger to run
code on your machine at some unspecified future date. `save-exact=true` in
`.npmrc` enforces this for anything installed via npm; check the manifest by
eye for anything else.

### 4. No bleeding edge — 30-day minimum release age

Every package must be on a stable release published **at least 30 days ago**.
Malicious versions are typically detected and unpublished within days, so a
cooldown converts most registry compromises into a non-event.

Prefer the latest patch of a *settled* minor line over the newest minor.

Verify before adding, with read-only registry metadata:

```sh
npm view <pkg> versions --json
npm view <pkg> time --json
```

This is also enforced mechanically: `minimumReleaseAge: 43200` (minutes) in
`pnpm-workspace.yaml`, with `minimumReleaseAgeStrict: true` so a violation
fails the install rather than quietly resolving to something newer, and
`minimumReleaseAgeIgnoreMissingTime: false` so a package with no `time`
metadata cannot bypass the check.

### 5. Never run dependency lifecycle scripts

`ignoreScripts: true` in `pnpm-workspace.yaml`. This is the single most
important control here: with it, a malicious version cannot execute anything
merely by being installed — it has to be imported and called.

- Do **not** run `pnpm approve-builds`.
- Do **not** add entries to `allowBuilds`. It is `{}` and must stay `{}`.
- Do **not** set `dangerouslyAllowAllBuilds`.
- Install with `pnpm install --ignore-scripts` as well, belt and braces.

If a package genuinely cannot function without a postinstall step, that is a
reason to **not adopt it**, not a reason to make an exception.

### 6. pnpm only, pinned via corepack

No `npm install`, no `yarn`, no `bun` for installs in this repo. pnpm is
pinned in `package.json#packageManager` with an integrity hash so corepack
verifies the package manager binary itself before running it:

```
"packageManager": "pnpm@11.9.0+sha512.<hex digest of the tarball>"
```

Note that corepack expects the digest as **hex**, while
`npm view pnpm@<v> dist.integrity` reports base64. Convert it; do not paste
the base64 value in, and do not let a tool fetch "whatever is newest".

### 7. Settings live in `pnpm-workspace.yaml`, not `.npmrc`

As of pnpm v11, pnpm reads **only auth and registry settings from `.npmrc`**.
Any other pnpm setting placed there is silently ignored — which is worse than
omitting it, because it creates false confidence. All hardening for this repo
is in `pnpm-workspace.yaml`.

Also note that pnpm v11 **removed** `onlyBuiltDependencies`,
`onlyBuiltDependenciesFile`, `neverBuiltDependencies`, `ignoredBuiltDependencies`
and `ignoreDepScripts`, replacing all of them with `allowBuilds`. Guides
written against pnpm 10 will tell you to use the old keys. They do nothing now.

### 8. Review the lockfile

`pnpm-lock.yaml` is marked `linguist-generated` so it collapses in diffs, but
it is **in review scope**. A dependency change is a change to what code runs
on every contributor's machine and in CI. Read it.

## Adding a dependency

1. Establish it cannot be done with the standard library. Usually it can.
2. Get explicit written approval from a maintainer. Agents may not add a
   dependency on their own initiative under any circumstances.
3. Check every rule above, including the 30-day age, for the package **and
   its full transitive tree**.
4. Confirm it has no install scripts:
   `npm view <pkg> scripts --json` — reject if `preinstall`, `install`,
   `postinstall` or `prepare` are present.
5. Record the decision in this file.

## Deliberately deferred candidates

These were the four dependencies this project expected to want. **None was
adopted, and — now that the tool is complete — none turned out to be needed.**

That is the strongest available evidence that this policy is workable rather
than merely austere. The whole of `kragg check` (18 gates, 165 modules under
`src/`) was built with `typescript` and the Node standard library:

- the AST work that `oxc-parser` and `ts-morph` were for is done through the
  TypeScript compiler API — the cheap `ts.createSourceFile` tier in
  `src/analysis/sourceFile.ts` and the one shared `ts.Program` in
  `src/analysis/program.ts` (see [architecture.md](architecture.md));
- the graph work `graphology` was for is **Brandes' betweenness implemented
  directly**, in `src/analysis/betweenness.ts` — 385 lines, the majority of
  them the comment recording which networkx conventions it matches and why
  (endpoints excluded, `1 / ((n-1)(n-2))` normalization), because criticality
  is a *threshold* on that float and a different convention silently moves
  functions across it;
- `node:test` never fell short of what `vitest` would have given us.

The entries are kept because the reasoning is the reusable part, and because
a future need would face the same vetting.

### `oxc-parser` — fast syntax-only parsing

**For:** the fast tier of gates (complexity, file size, forbidden calls,
public-surface counting) needs to parse TypeScript quickly and does not need
type information. `oxc-parser` is dramatically faster than the TypeScript
compiler for this.

**Vet before adopting:**
- It is a **native N-API addon**. Native modules are the highest-risk
  category under our no-lifecycle-scripts rule and the hardest to audit.
- Confirm it installs and runs with `ignoreScripts: true` and an empty
  `allowBuilds` — i.e. that it ships prebuilt platform binaries as optional
  dependencies rather than compiling in a postinstall. **If it needs a
  postinstall, it is disqualified.**
- Confirm it works under **both Node and Bun**, on macOS arm64/x64 and Linux
  x64/arm64. A parser that silently fails on one platform turns gates off.
- Confirm the prebuilt binaries are reproducible / published from CI.
- Understand what its optional platform packages do to the lockfile.

**Alternative if it does not clear the bar:** use the TypeScript compiler's
own scanner/parser. Slower, but it is a dependency we already have.

**Outcome: the alternative was taken and is sufficient.**
`ts.createSourceFile` is the syntax tier (`src/analysis/sourceFile.ts`), and it
is cheap — the expensive thing in TypeScript is not parsing, it is building a
`ts.Program` with a type checker. Splitting those two tiers, rather than
speeding up the parser, is what made the inner loop fast. Nothing here needs a
native addon, and `resolveTypeScript` gets a further property no third-party
parser could give us: the syntax tier parses with the *project's own*
compiler, so it agrees with the project's `tsc` about what is valid syntax.

### `ts-morph`, or the raw TypeScript compiler API — type-aware gates

**For:** anything needing real type information — the `typing-strictness`
gate, `any` detection, unsafe-cast detection, public API surface extraction.

**Vet before adopting:** prefer the **raw compiler API**, which is already in
`typescript` and adds no new package. `ts-morph` is a convenience wrapper: it
is a real additional dependency and a real additional maintainer to trust, so
adopt it only if the ergonomics savings are measured and large.

**Outcome: raw compiler API, and `ts-morph` was never needed.**
`forbidden-calls`, `nullable-default` and `criticality` all resolve through
`ts.TypeChecker` directly. One correction to the note above, which said program
construction "belongs strictly in the SLOW tier": that turned out to be the
wrong lever. Program construction is expensive *once*, not per gate, so the
answer was **one lazily-built program shared across the run**
(`src/analysis/program.ts`, `src/catalog/context.ts`) — which lets type-aware
gates sit in the FAST tier where they belong, while a run that reaches none of
them still pays nothing.

### `graphology` — call-graph betweenness centrality

**For:** the criticality analysis (which functions are load-bearing), ported
from the Python implementation's `critical.py`.

**Vet before adopting:** check its transitive tree — the graphology ecosystem
is split across many small packages (`graphology-metrics`, `graphology-types`,
…) and each is separate trust. Betweenness centrality is a
well-specified algorithm (Brandes'); implementing it directly is on the order
of a hundred lines and may well be cheaper than the trust cost.

**Outcome: implemented directly, in `src/analysis/betweenness.ts`.** The trust
argument held, and a second one appeared that settles it permanently: the
Python sibling uses networkx, and criticality is a *threshold* on the resulting
float (`betweenness >= 0.1 || fanIn >= 3`). Adopting any third-party
implementation would mean adopting its normalization conventions too, and a
convention mismatch does not produce slightly different numbers — it silently
moves functions across the threshold and the two siblings start disagreeing
about what is critical. Writing it ourselves is what let us match networkx's
conventions deliberately and record the verification.

### `vitest` — test framework

**For:** nothing yet. `node:test` covers what we need.

**Vet before adopting:** only if `node:test` provably falls short (the likely
triggers are coverage reporting or snapshot ergonomics). Vitest brings a large
transitive tree including a bundler. Measure the gap first; do not adopt it
because it is familiar.

**Outcome: `node:test` never fell short.** Neither predicted trigger fired.
Coverage reporting was not a gap because kragg *consumes* coverage reports
rather than producing them — `src/coverage/` normalizes istanbul JSON (vitest)
and lcov (`node --test`, `bun test`) into one line model, so the tool has to
read every runner's format regardless of which one it is tested with.
