/**
 * Forbidden-calls gate: APIs the project has banned, resolved by the TYPE
 * CHECKER rather than by name heuristics.
 *
 * The policy maps fully-qualified paths to project-specific fix hints:
 *
 *     { "forbidden_calls": {
 *         "node:child_process.exec": "run commands through src/services/runner.ts",
 *         "fastify.FastifyRequest.body": "read bodies via src/http/readLimitedBody.ts"
 *     } }
 *
 * An entry bans the exact callable AND everything beneath it: banning a module
 * bans every member of it, banning a class bans every method. Every resolvable
 * call to a banned path is a violation carrying the configured hint as its fix;
 * an empty hint degrades to `DEFAULT_FIX_HINT`, never to "no ban". The approved
 * wrapper's own call site is the one place the raw API is legitimate — mark it
 * with a trailing `// kragg: ignore -- <reason>`, which is a visible, reviewable exemption
 * rather than a loophole.
 *
 * WHY THIS IS THE TYPE-AWARE GATE. The Python sibling
 * (`kragg/gates/forbidden_calls.py`) has no type checker, so it reconstructs
 * types by hand: it tracks parameter annotations, annotated assignments and
 * `name = pkg.Class(...)` constructor assignments in source order, clears a
 * tracked type on any rebinding, respects class scoping, and gives up on an
 * unannotated receiver rather than guessing. That is a careful heuristic
 * working around a missing tool. Here the tool exists, so resolution is:
 * `getSymbolAtLocation` on the callee, follow aliases, then derive a path from
 * the DECLARATION the checker points at. The discipline is preserved exactly:
 * when the checker cannot resolve a symbol, the call is SKIPPED. Nothing is
 * ever guessed.
 *
 * ── THE PATH SCHEME ────────────────────────────────────────────────────────
 * A resolved call is spelled `<module>.<container>...<name>`, where `<module>`
 * comes from the file that DECLARES the callable:
 *
 *  - ambient module (`declare module "child_process"`) -> its specifier;
 *  - anything under `node_modules` -> the PACKAGE name, taken after the last
 *    `node_modules/` segment, so pnpm's `.pnpm/foo@1/node_modules/foo/...`
 *    still yields `foo`. Scoped packages keep both segments (`@scope/pkg`);
 *  - a declaration in global scope — a non-module `lib.*.d.ts`, or a
 *    `declare global` block -> `globalThis`;
 *  - a first-party file -> its repo-relative, extension-stripped module name
 *    from `moduleName()`, so separators inside the module part are `/`:
 *    `src/services/runner.runCommand`.
 *
 * `node:` is stripped from BOTH the resolved path and the configured entry, so
 * `fs` and `node:fs` are the same module and either spelling bans the other.
 * A global additionally matches its bare name, so `eval` and `globalThis.eval`
 * both ban `eval()`; the canonical `globalThis.` spelling is what gets
 * reported.
 *
 * GRANULARITY IS THE PACKAGE, NOT THE ENTRY POINT. `foo` and `foo/server`
 * resolve into the same `foo` namespace, because a package's file layout is
 * not its import specifier once `exports` subpaths are involved. Banning a
 * single subpath is therefore not expressible; ban the package or the member.
 *
 * ── DELIBERATE DIVERGENCES FROM PYTHON ─────────────────────────────────────
 * Each of these closes a limitation that `KNOWN_LIMITATIONS.md` documents for
 * the Python gate. They make this gate strictly more thorough, never less
 * precise, because every one of them is a fact the checker knows:
 *
 *  1. RE-EXPORTS RESOLVE. Python treats them as distinct names ("banning the
 *     starlette path does not ban `fastapi.Request.body` — list every path the
 *     project imports"). Here the alias chain is followed to the ORIGINAL
 *     declaration, so banning the original catches every re-exported spelling
 *     and there is exactly one path to list. The reported path is the original
 *     one, with the matched entry named alongside it.
 *
 *     Intermediate spellings are matched too, but only where they exist: when
 *     the CALLEE ITSELF is the alias (`import { Request } from "fastapi";
 *     new Request()`), the whole chain is on the symbol and `fastapi.Request`
 *     bans it. A member reached through a re-exported TYPE
 *     (`request.body()` on a `Request` parameter) resolves through the
 *     receiver's type, whose symbol is the original class — so only
 *     `starlette.Request.body` bans that, never `fastapi.Request.body`. Prefer
 *     the original path when writing a rule; it is the one that always works.
 *  2. SUBCLASSES AND IMPLEMENTATIONS RESOLVE. A method that overrides a banned
 *     base member is matched through the heritage clauses of its declaring
 *     class or interface, so banning `Request.body` also bans
 *     `MyRequest.body`.
 *  3. RECEIVERS DO NOT NEED AN ANNOTATION. `getRunner().exec()` and
 *     `this.exec()` resolve from the receiver's inferred type; Python skips
 *     both. Local shadowing is handled by construction — a local `const exec`
 *     resolves to the local declaration and never to the imported one.
 *
 * ── WHAT IS STILL SKIPPED, ON PURPOSE ──────────────────────────────────────
 *  - anything the checker types as `any`/`unknown`, including a value out of
 *    an untyped `require()`. Passing the raw API through `any` evades this
 *    gate exactly as it evades Python's; strict typing is what keeps
 *    resolution honest;
 *  - a callee reached by a computed key the checker cannot fold
 *    (`obj[name]()`);
 *  - `import("...")` itself, and a bare `@decorator` with no argument list.
 *    Both invoke something at runtime; neither has a callee expression to
 *    resolve. A call ON a dynamic import's result IS caught, because by then
 *    the checker knows the module's type;
 *  - JSX element instantiation;
 *  - a subpath entry point as distinct from its package, per the granularity
 *    note above.
 *
 * A skipped call is silent. Reporting a guess would be worse than missing one:
 * the gate's value is that a report means something.
 *
 * THIS FILE IS THE PUBLIC ENTRY POINT and nothing else. The gate lives in four
 * single-concern modules:
 *
 *  - `forbiddenCalls/resolver.ts` — the scan handle and the spelling rules;
 *  - `forbiddenCalls/rules.ts` — the policy read into a ban table, and matched;
 *  - `forbiddenCalls/declarationPath.ts` — a declaration to its qualified path;
 *  - `forbiddenCalls/symbols.ts` — a callee to every path it can be banned
 *    under, aliases and heritage included;
 *  - `forbiddenCalls/scan.ts` — the walk, the suppression check, the violation.
 */

export { DEFAULT_FIX_HINT, FORBIDDEN_CALL_CODE } from "./forbiddenCalls/rules.ts";

export type { ForbiddenCallsOptions, ForbiddenCallsOutcome } from "./forbiddenCalls/scan.ts";
export { checkForbiddenCalls } from "./forbiddenCalls/scan.ts";
