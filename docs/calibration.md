# Metric-gate calibration

kragg-ts's four numeric gates — `complexity`, `maintainability`, `halstead`
and `type-complexity` — reimplement radon's formulas over the TypeScript AST,
and their thresholds are **radon's numbers and Python kragg's, ported onto a
language they were never drawn against**. Each gate module says so in its own
doc comment. What none of them could say, until this document existed, is
whether those numbers are *useful* on real TypeScript.

This file records the measurement. It is evidence, not a decision.

> **Nothing in this document has changed a threshold, a grade band, a profile
> or a default.** The proposals in
> [What the numbers argue for](#what-the-numbers-argue-for) are written up with
> their measured justification and are
> explicitly **NOT APPLIED**: every one of them is a change to a number that
> Python kragg also ships, so it is a policy and conformance decision for a
> human, taken in both repositories at once. See `docs/spec-conformance.md`.

---

## How to reproduce this

`scripts/calibrate.ts` calls the same gate entry points `catalog/check.ts`
calls — `fileComplexity`, `fileMaintainability`, `fileHalstead`,
`checkTypeComplexity`, `checkNullableDefaults` — over the same `parsedSources`
walk, and adds the one thing the gates do not report: the **denominator**. A
violation count with no population behind it cannot distinguish a well-placed
threshold from a lucky one.

```
node scripts/calibrate.ts [--format json|markdown] [--out FILE] SAMPLE...
```

where each `SAMPLE` is `[label=]root[:srcA,srcB][@tsconfig]`:

| Part | Meaning |
| --- | --- |
| `label=` | name in the report; defaults to the root's basename |
| `root` | the project to measure |
| `:srcA,srcB` | override `source_paths`; without it the sample's own `kragg.json` (then `package.json#kragg`, then the defaults) decides, exactly as a real `kragg check` would |
| `@tsconfig` | the config the type-aware tier builds its program from, for a project whose config is not `<root>/tsconfig.json` |

Budgets are never taken from the command line: they come from each sample's
effective policy, because a run that let the operator pick the threshold would
measure the operator. The script writes nothing except its `--out` file, adds
no dependency, and spawns exactly one subprocess — `git rev-parse`, through
`src/engine/runner.ts`, so each row can name the commit it describes.

The run below was:

```
node scripts/calibrate.ts \
  kragg-ts=. \
  scaffold-cli=<scratch>/sample-cli \
  scaffold-api=<scratch>/sample-api \
  scaffold-mcp=<scratch>/sample-mcp \
  'dashboard=<dashboard>:app,components,lib,types' \
  'bakery=<bakery>:apps,packages,modules@apps/web/tortastudios/tsconfig.json' \
  --format markdown
```

The two application samples are private checkouts and are named by repository
and commit rather than by local path; substitute your own roots. The three
`scaffold-*` samples are reproducible anywhere: `node dist/cli.js new
sample-cli --kind cli` (and `api`, `mcp`), with no `install` run.

### Two measurement techniques worth knowing about

1. **`type-complexity`'s denominator comes from running the gate twice.** The
   gate has no "report everything" mode and its annotation walk is private, so
   the script runs it a second time at budget `0/0`, which makes every
   annotation site a violation — the same walk, the same sites, the same
   suppression handling as the real run.
2. **`nullable-default`'s denominator and numerator describe different file
   sets, on purpose.** Candidate sites (`||`/`||=` and arithmetic) are counted
   over `source_paths`; violations come from the one `ts.Program`. On a
   workspace those differ, and the `program files` bucket is reported so the
   gap is visible instead of hiding inside a zero.

---

## The samples

Measured **2026-09-08**, kragg-ts at commit `b2cdd67`.

| Sample | Shape | Commit | Source paths | Files | Lines | Compiler |
| --- | --- | --- | --- | --- | --- | --- |
| `kragg-ts` | CLI (this repo — written to pass its own gates) | `b2cdd67` | `src` | 165 | 32,816 | typescript 6.0.3 (bundled) |
| `scaffold-cli` | `kragg new --kind cli`, uninstalled | — | `src` | 4 | 108 | typescript 6.0.3 (bundled) |
| `scaffold-api` | `kragg new --kind api`, uninstalled | — | `src` | 4 | 87 | typescript 6.0.3 (bundled) |
| `scaffold-mcp` | `kragg new --kind mcp`, uninstalled | — | `src` | 4 | 81 | typescript 6.0.3 (bundled) |
| `dashboard` | Next.js 16 / React 19 app + route handlers | `066b3097` | `app components lib types` | 163 | 29,115 | typescript 5.9.3 (project) |
| `bakery` | pnpm workspace, six TypeScript packages (Next.js sites, a game client, an internal tool) | `ff157fa1` | `apps packages modules` | 309 | 36,831 | typescript 6.0.3 (bundled) |

Two facts about the sample set are themselves results:

- **`bakery` has no root `tsconfig.json`,** so `resolveTypeScript` fell back to
  the bundled compiler and the type-aware tier had to be pointed at one
  package's config. See [Workspace coverage](#workspace-coverage).
- **`kragg-ts` is the only sample written against these gates,** and it scores
  zero on all of them. A calibration set containing only it would have proved
  nothing, which is why it is here as a control rather than as evidence.

---

## Violation counts

| Sample | `complexity` | `maintainability` | `halstead` (E / D / B) | `type-complexity` | `nullable-default` |
| --- | --- | --- | --- | --- | --- |
| `kragg-ts` | 0 / 1342 | 0 / 165 | 0 / 0 / 0 of 1342 | 0 / 4221 | 0 of 741 sites |
| `scaffold-cli` | 0 / 3 | 0 / 4 | 0 / 0 / 0 of 3 | 0 / 9 | 0 of 0 sites |
| `scaffold-api` | 0 / 4 | 0 / 4 | 0 / 0 / 0 of 4 | 0 / 4 | 0 of 2 sites |
| `scaffold-mcp` | 0 / 3 | 0 / 4 | 0 / 0 / 0 of 3 | 0 / 4 | 0 of 0 sites |
| `dashboard` | **91** / 1187 (7.67%) | **3** / 163 (1.84%) | **51 / 31 / 88** of 1187 | **150** / 927 (16.18%) | 0 of 600 sites |
| `bakery` | **57** / 1838 (3.10%) | **2** / 309 (0.65%) | **44 / 21 / 100** of 1838 | **131** / 2172 (6.03%) | 0 of 695 sites |

`halstead` is one gate with three ceilings, so its violations are reported per
ceiling: effort > 50,000, difficulty > 30, estimated bugs > 0.4. A block may
breach more than one.

### Distributions

The point of a distribution is to show whether the population piles up on the
line or sits well clear of it.

| Sample | Metric | min | p50 | p90 | p99 | max | Buckets |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `kragg-ts` | cyclomatic | 1 | 2 | 7 | 10 | 10 | A 1097, B 245 |
| `dashboard` | cyclomatic | 1 | 2 | 9 | 24 | 58 | A 947, B 149, C 68, D 18, E 1, F 4 |
| `bakery` | cyclomatic | 1 | 1 | 5 | 17 | 41 | A 1680, B 101, C 48, D 7, E 1, F 1 |
| `kragg-ts` | maintainability | 36.4 | 61.9 | 81.1 | 95.3 | 99.7 | A 165 |
| `dashboard` | maintainability | 0 | 59.9 | 79.8 | 100 | 100 | A 160, B 1, C 2 |
| `bakery` | maintainability | 0 | 68.0 | 98.4 | 100 | 100 | A 307, B 1, C 1 |
| `kragg-ts` | Halstead effort | 0 | 763 | 6,911 | 17,012 | 25,818 | none over 50,000 |
| `dashboard` | Halstead effort | 0 | 194 | 16,559 | 154,459 | 1,836,908 | ≤1k 758, ≤5k 173, ≤25k 168, ≤50k 37, >50k 51 |
| `bakery` | Halstead effort | 0 | 188 | 10,288 | 112,666 | 597,157 | ≤1k 1270, ≤5k 280, ≤25k 201, ≤50k 43, >50k 44 |
| `dashboard` | Halstead difficulty | 0 | 3.04 | 18.33 | 37.96 | 66.65 | ≤5 698, ≤10 201, ≤20 195, ≤30 62, >30 31 |
| `bakery` | Halstead difficulty | 0 | 3.00 | 13.64 | 33.41 | 65.25 | ≤5 1166, ≤10 335, ≤20 255, ≤30 61, >30 21 |
| `dashboard` | Halstead bugs | 0 | 0.02 | 0.33 | 1.55 | 9.19 | ≤0.05 758, ≤0.1 124, ≤0.2 96, ≤0.4 121, >0.4 88 |
| `bakery` | Halstead bugs | 0 | 0.02 | 0.25 | 1.29 | 6.15 | ≤0.05 1268, ≤0.1 177, ≤0.2 162, ≤0.4 131, >0.4 100 |
| `dashboard` | annotation depth | 0 | 0 | 2 | 3 | 4 | 0: 541, 1: 262, 2: 74, 3: 48, >3: 2 |
| `bakery` | annotation depth | 0 | 0 | 1 | 2 | 5 | 0: 1519, 1: 526, 2: 106, 3: 16, >3: 5 |
| `dashboard` | annotation length | 3 | 13 | 52 | 164 | 639 | ≤20 594, ≤40 195, ≤60 69, ≤100 37, >100 32 |
| `bakery` | annotation length | 1 | 9 | 32 | 86 | 341 | ≤20 1662, ≤40 385, ≤60 71, ≤100 41, >100 13 |

Read the tails: the Halstead effort maximum is **37×** its ceiling on
`dashboard` and **12×** on `bakery`, and the worst annotation is **16×** the
length budget. These gates are not firing on borderline code; they are firing
on a small number of very large things — and on a lot of medium-sized ones.

---

## Manual precision assessment

**Method.** Findings were sampled across both application samples, weighted
towards the worst offenders and towards the classes that recur. For each one
the enclosing block was profiled — physical span, cyclomatic score, Halstead
metrics, count of JSX elements inside it — and the source was read. Each is
classified **TP** (a defect a reviewer would want raised), **arguable** (the
metric overstates the problem, but the suggested fix is a real improvement) or
**FP** (nothing to fix; the metric is measuring the wrong thing). Only paths,
symbol names and numbers are recorded; no sample source is reproduced here.

### `complexity` — 8 sampled of 148

| Sample · location | Symbol | Score | Verdict | Why |
| --- | --- | --- | --- | --- |
| `dashboard` `app/dashboard/billing/page.tsx` | `BillingPage` | 58 (F) | TP | one 413-line function; 54 JSX elements and real branching |
| `dashboard` `app/dashboard/admin/admin-client.tsx` | `AdminClient` | 51 (F) | TP | 1,161-line component in a 1,265-line file |
| `bakery` `.../scripts/check_analytics.ts` | `checkCallSites.<anonymous>` | 41 (F) | TP | a 155-line closure doing real analysis |
| `bakery` `.../scripts/check_analytics.ts` | `readJsonBaseline` | 29 (D) | TP | 96 lines of parsing and validation branches |
| `dashboard` `app/api/brands/route.ts` | `POST` | 24 (D) | TP | 122-line route handler, sequential validation |
| `dashboard` `lib/partial-progress.ts` | `partialProgressFromRun` | 23 (D) | TP | 57 lines, genuinely branchy state derivation |
| `dashboard` `app/dashboard/admin/admin-client.tsx` | `AdminClient.cascadeText` | 20 (C) | **arguable** | **10 lines.** Five copies of one pluralization idiom (`?? 0` plus `=== 1 ? "" : "s"`). Nobody reads it as 20 branches; extracting a `plural()` helper is still an improvement |
| `dashboard` `app/dashboard/admin/admin-client.tsx` | `provisionErrorText` | 11 (C) | **arguable** | 15 lines, one point over the line, and the points are TypeScript narrowing idioms (`?.`, `typeof x === "string" && x`, ternary fallbacks) rather than control flow |

**6 TP, 2 arguable, 0 FP** in the sample. The two arguable cases share a
mechanism, and it is measurable across the whole corpus rather than
anecdotal — see [What drives a TypeScript cyclomatic
score](#what-drives-a-typescript-cyclomatic-score).

### `maintainability` — all 5 findings

| Sample · file | MI | File lines | Verdict |
| --- | --- | --- | --- |
| `dashboard` `app/dashboard/admin/admin-client.tsx` | 0.0 (C) | 1,265 | TP |
| `dashboard` `app/dashboard/[brandId]/content/draft-renderer.tsx` | 4.5 (C) | 1,155 | TP |
| `dashboard` `app/dashboard/integrations/connection-cards.tsx` | 17.6 (B) | 1,119 | TP |
| `bakery` `.../scripts/check_analytics.ts` | 0.0 (C) | 1,386 | TP |
| `bakery` `.../src/lib/sentry-privacy.ts` | 14.8 (B) | 486 | TP |

**5 TP, 0 arguable, 0 FP** — and this is the gate's whole output across 472
application files. Precision is perfect; the question this gate raises is
**recall**, not precision. See
[the maintainability threshold](#maintainability-fires-almost-never).

### `halstead` — 8 sampled of 335

| Sample · location | Symbol | Metric | Verdict | Why |
| --- | --- | --- | --- | --- |
| `bakery` `.../guides/slack-ai-agents/content.tsx` | `GuideContent` | effort 597,157 (12×), bugs 6.15 (15×) | **FP** | 1,175 lines, **cyclomatic 1**, **472 JSX elements**: static marketing copy. There is no logic to simplify, and "split the function" is not advice about a defect |
| `dashboard` `app/dashboard/admin/admin-client.tsx` | `AdminClient` | effort 1,836,908 (37×) | TP | also cyclomatic 51 and MI 0; every gate agrees |
| `bakery` `.../src/hooks/useGameLifecycle.ts` | `useGameLifecycle` | difficulty 65.3 (2.2×) | **arguable** | 248-line hook, **cyclomatic 1**: the score is the sum of its nested closures, charged to the shell that holds them |
| `bakery` `.../components/animation/HeroReveal.tsx` | `HeroReveal` | effort 392,217 (8×) | **arguable** | 306 lines, cyclomatic 4, 5 JSX elements; again a shell full of `useEffect` closures |
| `bakery` `.../src/lib/attribution-consent-sync.ts` | `createAttributionConsentSyncController` | difficulty 53.9 (1.8×) | **arguable** | 176-line closure factory, cyclomatic 2 |
| `bakery` `.../scripts/check_analytics.ts` | `main` | effort 115,883 (2.3×) | TP | 98 lines, cyclomatic 20; both gates agree |
| `dashboard` `lib/dashboard-data.ts` | `enrichOpportunities` | effort 67,346, difficulty 33.1 | TP | 98 lines, cyclomatic 11 |
| `bakery` `.../src/lib/sentry-privacy.test.ts` | `<anonymous>` | bugs 1.88 | scope artifact | a test file that fell inside the `source_paths` chosen for this run; a real `kragg.json` puts it in `test_paths`. Not a gate defect |

**3 TP, 3 arguable, 1 FP, 1 scope artifact.** Halstead is the least precise of
the four gates in TypeScript, and the two mechanisms behind that are specific
and measurable — see [Halstead counts markup and
closures](#halstead-counts-markup-and-closures).

### `type-complexity` — 8 sampled of 281

| Sample · location | Site | Metric | Verdict |
| --- | --- | --- | --- |
| `dashboard` `.../integrations/connection-cards.tsx` | parameter `<destructured>` in `ConnectionCards()` | length 639 (16×) | TP — inline React props object; the fix is a named `Props` interface |
| `dashboard` `.../billing/top-up-slider.tsx` | parameter `<destructured>` in `TopUpSlider()` | length 405 | TP — same class |
| `bakery` `.../src/lib/structured-data.ts` | parameter `post` in `articleSchema()` | length 341 | TP — a 120-line module with one enormous inline shape |
| `bakery` `.../caloric-deficit-calculator/.../route.ts` | return type of `GET()` | depth 5 | TP — genuinely nested, genuinely unnamed |
| `bakery` `.../caloric-deficit-calculator/.../route.ts` | property `CalculateTDEEResponse.deficitCalories` | length 109 | TP |
| `dashboard` `.../admin/admin-client.tsx` | variable `payload` | length 126 | TP |
| `dashboard` `.../llms/llms-client.tsx` | parameter `<destructured>` in `FamilyRow()` | length 129 | TP |
| `bakery` `.../actions/newsletter-registration.test.ts` | variable `writes` | depth 5 | scope artifact — a test fixture's local annotation, inside the chosen `source_paths` |

**7 TP, 0 arguable, 0 FP, 1 scope artifact.** This is the most precise of the
four gates in TypeScript, and the reason is that its advice is always the same
and always cheap: give the shape a name.

**The dominant class is React props.** Of the 60 worst `dashboard` findings, 56
are `parameter '<destructured>'` — a component declaring its props as an inline
object type. On `bakery`, whose TypeScript is less React-heavy, that class is
11 of 60. The idiom is conventional React, so a project may reasonably read
these as noise; the gate's answer (extract an interface) is nonetheless the
thing a reviewer would ask for, and it takes a minute.

### `nullable-default` — no findings anywhere

Zero violations across **2,038 candidate sites** in six samples (`kragg-ts`
741, `dashboard` 600, `bakery` 695, scaffolds 2). Precision is undefined with
no findings, and this document will not pretend otherwise: **a gate that has
never fired on real code is unproven on real code.**

Two things keep it honest rather than decorative. It **can** fire — the
known-defect fixture in `test/fixtures/knownDefects.ts` contains one site for
each of its two rules and `test/knownDefects.test.ts` fails if either stops
being reported. And the zero is the design target: the gate's own module doc
records that relaxing its string-fallback rule produced 31 findings on a
comparable corpus, almost all of them intended code. The measurement here
confirms the narrow rules hold their line on 2,038 fresh sites.

---

## Suppression frequency

| Sample | `// kragg: ignore` markers | Per 1,000 lines |
| --- | --- | --- |
| `kragg-ts` | 21 | 0.64 |
| `dashboard` | 0 | 0 |
| `bakery` | 0 | 0 |
| scaffolds (all three) | 0 | 0 |

The only suppressions in the corpus are kragg-ts's own, and they are its 21
deliberate exemptions (`node:child_process` in the runner, and similar). The
application samples do not run kragg today, so a zero there measures adoption
rather than agreement — this number becomes meaningful only after a project has
lived with the gates, and it is recorded now to establish the baseline.

---

## Remediation cost

Findings were bucketed by what fixing them actually costs.

| Bucket | What it takes | Which findings | Count in this corpus |
| --- | --- | --- | --- |
| **S** — minutes | Extract a named `interface`/`type`; extract a small helper (`plural()`); name a return type | all 281 `type-complexity` findings; the two arguable `complexity` cases | 283 |
| **M** — hours | Split a 60–200 line function; lift closures out of a hook | the 141 grade-C and grade-D `complexity` blocks, and the Halstead findings that coincide with them | 141 |
| **L** — days | Decompose a 1,000+ line component or module | the 5 `maintainability` files plus the 7 grade-E/F blocks, which land on about 10 distinct files | ~10 files |
| **N** — not actionable | nothing to fix | the static-JSX Halstead findings (see P2) | not separately counted |

**The correlation matters more than the totals.** Of the findings retained in
the report for `dashboard` (capped at 60 per gate: 265 rows), **74 distinct
files** carry them and **37 of those files are flagged by three or more gates**.
A single 1,200-line component produces a `complexity` finding, a
`maintainability` finding and three Halstead findings; splitting it clears all
five. The L bucket is therefore about ten files' worth of work across both
applications, not ten findings, and the headline counts overstate the real
backlog by roughly 3.5×.

---

## What the measurements found

### What drives a TypeScript cyclomatic score

Every decision point in each sample, tallied by construct (hand analysis; the
committed script records violations and distributions, not this breakdown):

| Construct | `kragg-ts` | `dashboard` | `bakery` | In radon? |
| --- | --- | --- | --- | --- |
| `if` | 1,223 (41.6%) | 721 (21.7%) | 907 (35.0%) | yes |
| ternary `?:` | 415 (14.1%) | 903 (27.2%) | 415 (16.0%) | yes |
| `\|\|` | 328 (11.1%) | 433 (13.0%) | 286 (11.0%) | yes |
| `&&` | 254 (8.6%) | 476 (14.3%) | 355 (13.7%) | yes |
| `??` | 294 (10.0%) | 325 (9.8%) | 162 (6.2%) | **no** |
| optional chain `?.` | 58 (2.0%) | 299 (9.0%) | 211 (8.1%) | **no** |
| `for` / `while` | 286 (9.7%) | 36 (1.1%) | 165 (6.4%) | yes |
| `catch` | 71 (2.4%) | 126 (3.8%) | 85 (3.3%) | yes |
| `switch` | 12 (0.4%) | 5 (0.2%) | 6 (0.2%) | yes (one point; see below) |
| **Total** | **2,942** | **3,324** | **2,593** | |
| **No radon equivalent** | **353 (12.0%)** | **624 (18.8%)** | **374 (14.4%)** | |
| **Resident inside JSX** | **0 (0%)** | **1,046 (31.5%)** | **308 (11.9%)** | |

Two language facts fall out of this:

1. **12–19% of every TypeScript cyclomatic score comes from operators radon
   cannot count.** `??` and `?.` do not exist in Python. Counting them is
   defensible — `a?.b` really is a branch, and the gate's doc comment argues
   the case — but it means the *ported* band is systematically tighter in
   TypeScript than in Python by roughly one grade step's worth of points.
2. **In React, a third of the score is markup.** 31.5% of `dashboard`'s
   decision points sit inside JSX: `{cond && <Row/>}` and `{a ? <X/> : <Y/>}`
   are conditional *rendering*, not control flow.

Quantified as a what-if over the same blocks (failures at the shipped grade-B
ceiling):

| | `dashboard` | `bakery` | `kragg-ts` |
| --- | --- | --- | --- |
| as shipped | 91 | 57 | 0 |
| if `??` and `?.` were not counted | 59 | 50 | 0 |
| if JSX-resident `&&`/`\|\|`/`?:` were not counted | 62 | 52 | 0 |
| if neither were counted | 28 | 45 | 0 |

**69% of `dashboard`'s complexity failures depend on constructs radon never
counted or on JSX rendering; on `bakery` only 21% do.** The gate's behaviour
therefore varies enormously with how much of a project is React.

The `switch`-scores-one divergence already in `complexity/cyclomatic.ts` is
untouched by all of this: `switch` supplies 0.2–0.4% of decision points in
every sample, so that decision moves nothing at this scale. It was the right
call for kragg-ts's own dispatch tables and it is irrelevant elsewhere.

### Halstead counts markup and closures

Two mechanisms, both measurable, make Halstead the least precise gate here.

**Static JSX is counted as operators and operands.** `bakery`'s
`.../guides/slack-ai-agents/content.tsx::GuideContent` is 1,175 lines
containing 472 JSX elements, four ternaries and **cyclomatic complexity 1** —
static marketing copy. It scores effort 597,157 (12× the ceiling), difficulty
32.4 and estimated bugs 6.15 (15× the ceiling), making it the single worst
Halstead offender in the whole corpus. Nothing about it is a defect.

The scale of the effect across the corpus, taken over the 60 worst findings per
gate: **90% of `dashboard`'s Halstead effort findings and 90% of its bugs
findings are in `.tsx` files** (`bakery`, less React-heavy: 45% and 55%).
Halstead was defined over operator/operand
counts in imperative code; a markup language embedded in the expression grammar
is outside anything it was validated against.

**A block's counts include the functions nested inside it, but its cyclomatic
score does not.** That asymmetry is radon's and is preserved deliberately
(`halstead/walk.ts` says so), but its consequences are much larger in
TypeScript, where the closure is the dominant idiom. A React hook or component
is a thin shell around many `useEffect`/`useCallback` closures, so the shell is
charged for all of them at once:

| Location | Symbol | Cyclomatic | Halstead |
| --- | --- | --- | --- |
| `bakery` `.../hooks/useGameLifecycle.ts` | `useGameLifecycle` | **1 (A)** | difficulty 65.3 |
| `bakery` `.../animation/HeroReveal.tsx` | `HeroReveal` | **4 (A)** | effort 392,217 |
| `bakery` `.../lib/attribution-consent-sync.ts` | `createAttributionConsentSyncController` | **2 (A)** | difficulty 53.9 |
| `bakery` `.../guides/slack-ai-agents/content.tsx` | `GuideContent` | **1 (A)** | effort 597,157 |

A gate saying "this function is 12× too effortful" about a function the
complexity gate grades A is not obviously wrong, but it is not obviously right
either, and a reader has no way to tell which from the message.

**The three ceilings do not fire together.** Estimated bugs is `volume / 3000`,
so it trips at volume > 1,200 — a low bar for TypeScript, and roughly a screen
of JSX:

| Ceiling | `dashboard` | `bakery` | Nature |
| --- | --- | --- | --- |
| effort > 50,000 | 51 (4.30%) | 44 (2.39%) | size × difficulty |
| difficulty > 30 | 31 (2.61%) | 21 (1.14%) | operand reuse — the only one of the three that is not mostly size |
| **bugs > 0.4** | **88 (7.41%)** | **100 (5.44%)** | pure size proxy |

**Estimated bugs is the binding Halstead ceiling in TypeScript**, firing about
1.9× as often as effort, and it is the ceiling with the least to say: it
duplicates effort's signal at a much lower bar and carries most of the static-
JSX false positives. This inverts the Python situation, where `halstead.py`'s
worst effort score across the entire implementation is 446 against a 50,000
limit and **none** of the three can fire at all.

### `maintainability` fires almost never

Five findings across 472 application files (1.06%), all five true positives,
all five on files of 486–1,386 lines.

The threshold is effectively a size gate in disguise. MI is dominated by
`-16.2*ln(lloc)` and rewarded by `+50*sin(sqrt(2.46*C))` for comment density,
so a TypeScript file only leaves grade A when it is **both large and
undocumented**. Measured directly on a comment-free module of uniform
six-line functions:

| Logical lines | MI | Grade |
| --- | --- | --- |
| 60 | 36.8 | A |
| 120 | 26.4 | A |
| 180 | 19.7 | A (just) |
| 240 | 14.6 | B |
| 360 | 6.6 | C |

The A/B boundary sits near **180–200 comment-free logical lines**, i.e. roughly
220 physical lines. That is well inside the `structure` gate's 500-line file
budget, so the two gates do not overlap as much as one might assume — but a
project that comments its code can carry 400 lines and still grade A, and a
project that does not cannot. This threshold ports better than any other in the
set, and it is the one this document has the least to say about.

### `type-complexity`: length binds, depth barely does

| | `dashboard` | `bakery` |
| --- | --- | --- |
| length-only failures | 100 | 110 |
| depth-only failures | 12 | 6 |
| both | 38 | 15 |
| annotations at depth 0 | 541 (58%) | 1,519 (70%) |
| annotations over 100 characters | 32 | 13 |

This confirms, on 3,099 annotation sites, what `typeComplexity.ts`'s doc
comment inferred from kragg-ts alone: **length is the binding budget in
TypeScript by roughly an order of magnitude**, because a depth-1 type like
`Record<string, string | number | boolean | null>` is 48 characters before it
does anything interesting. Depth 2 is a comfortable budget; length 40 is a
tight one.

### Workspace coverage

`bakery` has no root `tsconfig.json` — normal for a pnpm workspace, where each
package owns its own. Two consequences, both measured:

- **The compiler fell back to bundled.** `resolveTypeScript` resolves from the
  project root, and a workspace root has no hoisted `typescript`. The report
  says `typescript 6.0.3 (bundled)` where `dashboard` says
  `typescript 5.9.3 (project)`. Syntax-tier gates are largely insensitive to
  this; it is still the wrong compiler, and the run says so.
- **The type-aware tier saw 61% of the tree.** Pointed at one package's config,
  the program contained **189 files** against the **309** the syntax tier
  walked. (Since TOR-1371 a workspace root run says which members it did not
  check, and `kragg check --package <member>` checks each with its own
  tsconfig, compiler and program; the numbers here are the root-run
  measurement and stand as recorded.) `nullable-default`'s zero on `bakery` is
  therefore a zero over 189
  files, not 309 — which is exactly why the script reports the `program files`
  count next to the site count.

---

## What the numbers argue for

**Everything in this section is a PROPOSAL and is NOT APPLIED.** Each is a
change to a number Python kragg also ships, so applying one is a policy
decision plus a coordinated change in both repositories plus a conformance
re-run — see `docs/spec-conformance.md`. They are recorded here with their
measured justification so that decision has evidence rather than taste.

**P1 — Reconsider `MAX_BUGS` (0.4), or drop the bugs ceiling.** Measured: it
fires 1.9× as often as effort (188 findings vs 95 across both applications),
it is a pure volume proxy that duplicates effort's signal at a lower bar, and
90% of its `dashboard` findings are in `.tsx` files where volume is markup.
Every finding it produced in the precision sample that effort did not also
produce was in the FP or arguable column. It is also the ceiling with the least
independent meaning: `bugs = volume / 3000` is a 1977 estimate of delivered
defects per unit of volume, never validated on TypeScript or on markup.
*Not applied: `MAX_BUGS` is `halstead.py`'s number and is part of the shared
vocabulary.*

**P2 — Consider excluding JSX-resident nodes from the Halstead partition.**
Measured: `content.tsx::GuideContent` — 472 JSX elements, cyclomatic 1 — is the
worst Halstead offender in the corpus and is not a defect; 90% of `dashboard`'s
effort findings are in `.tsx`. The precedent exists inside the gate already:
`halstead/partition.ts` excludes type syntax on the argument that erased syntax
must not make a well-annotated function look harder. Static markup has the same
character. The cost is equally real and must be stated: a component with
genuinely complicated inline expressions would then be under-measured.
*Not applied: this changes what the metric means, and Python has no analogue to
coordinate against.*

**P3 — Consider reporting a Halstead block's own counts separately from its
nested closures.** Measured: four of the worst offenders in the corpus grade
cyclomatic A because their bodies are closure shells, while Halstead charges
them for everything inside. The current behaviour is radon's and is
intentional, but in TypeScript it makes the two complexity gates disagree
loudly and gives the reader no way to tell a genuinely dense function from a
container of ordinary ones. A message that named both numbers would resolve it
without moving a threshold at all.
*Not applied: it changes violation text, which the conformance goldens diff
byte-exact.*

**P4 — Leave `CC_MAX_GRADE`, `MI_MIN_GRADE`, `MAX_EFFORT`, `MAX_DIFFICULTY`,
`type_max_nesting_depth` and `type_max_length` exactly where they are.** The
measurements support keeping every one of them:

- `complexity` at grade B: 6 TP, 2 arguable, 0 FP in the precision sample, and
  a 3.1–7.7% firing rate. The two arguable cases are one point and ten points
  over a line drawn for a different language, which is an argument for
  *documenting* the `??`/`?.`/JSX effect (done — see `KNOWN_LIMITATIONS.md`),
  not for moving the line. Lowering the bar to make `dashboard` green would
  discard 28 failures that survive every what-if.
- `maintainability` at grade A: 5 findings, 5 true positives, zero noise.
- `type-complexity` at 2/40: the most precise gate measured, and its
  false-positive column is empty. A project that finds the React-props class
  noisy should raise `type_max_length` **in its own `kragg.json`**, which is
  what that field is for, rather than have the default moved for everyone.
- `MAX_EFFORT`/`MAX_DIFFICULTY`: imprecise for the reasons in P2 and P3, but
  the imprecision is in *what is counted*, not in *where the line is*. Moving
  the ceiling would silence the true positives at the same rate as the false
  ones.

**A note on what this exercise refused to do.** The obvious way to make these
samples green is to raise the thresholds until they are. Every proposal above
is instead about what the metrics *count*, and P4 is the recommendation that
nothing move. Zero findings would not have meant the gates were accurate — it
would have meant they were switched off. `test/knownDefects.test.ts` is the
mechanical guard on that: it holds one measured defect per gate and fails if a
future calibration stops detecting any of them.

---

## Limits of this measurement

- **Two applications and four small projects.** Two real codebases, one of them
  a workspace of five packages, is a sample of convenience, not a survey.
  Every rate here has wide error bars.
- **The precision assessment is one reader's judgement,** taken from reading
  the code behind each sampled finding. The classifications are argued in the
  tables so that a second reader can disagree with a specific row.
- **Recall is not measured at all.** Every gate's false-negative rate is
  unknown: nothing here says how many genuinely complex functions scored A.
  `test/knownDefects.test.ts` pins a floor (these specific defects are caught)
  and nothing else.
- **Sample `source_paths` were chosen for coverage, not fidelity.** Neither
  application ships a `kragg.json`, so their source paths were given on the
  command line and include some test and script files a real configuration
  would place in `test_paths`. Two findings in the precision tables are marked
  as scope artifacts for exactly this reason.
- **No sample had `pnpm install` run for it,** other than as its own repository
  already had. The scaffolds were measured uninstalled, which is why their
  `nullable-default` denominators are near zero: there is almost no code in a
  fresh scaffold to look at.
- **`kragg-ts` cannot be evidence about itself.** It is written to pass these
  gates and scores zero on all of them; it appears above as a control.
