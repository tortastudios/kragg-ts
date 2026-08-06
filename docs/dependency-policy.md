# Dependency policy

This is a standing policy, not a suggestion. It applies to humans and agents
equally. The npm registry is the most actively attacked software supply chain
in wide use; a guardrails tool that is itself casually assembled from
dependencies has no standing to tell anyone else how to build software.

**Every rule below is a hard rule. If you are unsure whether something is
allowed, it is not. Open an issue instead.**

## The rules

### 1. Zero runtime dependencies

`dependencies` is `{}` and stays `{}`. Anything shipped to a user's machine is
written here or comes from `node:`. Node 20+ has a good standard library —
`node:util`'s `parseArgs`, `node:test`, `node:child_process`,
`node:fs`, `node:path` — and it is enough for a CLI.

### 2. Minimal dev surface

`devDependencies` is exactly two packages:

| Package | Version | Why |
| --- | --- | --- |
| `typescript` | `6.0.3` | The build (`tsc`) and the typecheck. |
| `@types/node` | `24.12.4` | Types for the `node:` builtins. |

`typescript` is the one large trusted dependency in this project. It is
maintained by Microsoft, has an enormous number of eyes on it, ships no
install scripts, and has no dependencies of its own. That is the *only*
reason it clears a bar that almost nothing else does. It is not a precedent.

`@types/node` pulls one transitive package, `undici-types`, from
DefinitelyTyped. Types only — no runtime code.

No bundler. No test framework. No linter. No formatter.
`node:test` is the test runner and `tsc` is the build.

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

These are the dependencies we can foresee wanting. None is adopted. Each is
listed with what it would buy and what must be vetted first.

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

### `ts-morph`, or the raw TypeScript compiler API — type-aware gates

**For:** anything needing real type information — the `typing-strictness`
gate, `any` detection, unsafe-cast detection, public API surface extraction.

**Vet before adopting:** prefer the **raw compiler API**, which is already in
`typescript` and adds no new package. `ts-morph` is a convenience wrapper: it
is a real additional dependency and a real additional maintainer to trust, so
adopt it only if the ergonomics savings are measured and large. Whichever we
pick, program construction is slow — it belongs strictly in the SLOW tier.

### `graphology` — call-graph betweenness centrality

**For:** the criticality analysis (which functions are load-bearing), ported
from the Python implementation's `critical.py`.

**Vet before adopting:** check its transitive tree — the graphology ecosystem
is split across many small packages (`graphology-metrics`, `graphology-types`,
…) and each is separate trust. Betweenness centrality is a
well-specified algorithm (Brandes'); implementing it directly is on the order
of a hundred lines and may well be cheaper than the trust cost.

### `vitest` — test framework

**For:** nothing yet. `node:test` covers what we need.

**Vet before adopting:** only if `node:test` provably falls short (the likely
triggers are coverage reporting or snapshot ergonomics). Vitest brings a large
transitive tree including a bundler. Measure the gap first; do not adopt it
because it is familiar.
