/**
 * Type-complexity gate: nested, unnamed type annotations must get a NAME.
 *
 * Ported from `kragg/src/kragg/gates/type_complexity.py`. The scaffolded doc
 * states the intent: "kragg limits type annotation nesting and length so data
 * shapes get names". Python's advice is `@dataclass` / `TypedDict` /
 * `TypeAlias`; the TypeScript advice is `interface` / named `type` alias. The
 * violation shape, the `type-complexity` code and the two policy budgets
 * (`typeMaxNestingDepth`, `typeMaxLength`) are unchanged, so a polyglot repo
 * reads one vocabulary from both siblings.
 *
 * WHY THIS MATTERS MORE HERE THAN IN PYTHON. Python's type syntax is
 * subscripts and unions; it runs out of expressive room quickly, which caps
 * how bad an inline annotation can get. TypeScript has generics, unions,
 * intersections, tuples, mapped types, conditional types, indexed access,
 * template literal types and `typeof`, all composable — so
 * `Awaited<ReturnType<typeof makeClient>>["query"]` is an ordinary thing to
 * find inline in a parameter list. The budgets bite harder here, and that is
 * the point.
 *
 * ── HOW DEPTH IS COUNTED ───────────────────────────────────────────────────
 * Python counts one level per `ast.Subscript` and takes the MAX (not the sum)
 * across the elements of a subscript's tuple slice, so `dict[str, list[int]]`
 * is 2 and `dict[str, int]` is 1. The rule generalised: CONTAINMENT adds a
 * level, SIBLINGS do not. Applied to the TypeScript type AST:
 *
 *   +1, then max over what it contains:
 *     - a type reference WITH type arguments — `Foo<A>`, `Record<K, V>`;
 *     - `T[]` and `[A, B]`;
 *     - an inline object type `{ a: A }` and a mapped type `{ [K in Ks]: V }`;
 *     - `T[K]` (indexed access);
 *     - `A extends B ? C : D` (all four branches);
 *     - a function or constructor type — max over parameter types AND the
 *       return type, because `(x: A) => B` contains both;
 *     - a template literal type, over its interpolated types;
 *     - `import("m").Foo<A>` with type arguments.
 *
 *   +0, pass through to what it contains:
 *     - `A | B` and `A & B`. Members are ALTERNATIVES at one level, not
 *       containment — the direct analogue of Python's tuple-slice rule. A
 *       twelve-member union is caught by the LENGTH budget, which is the
 *       budget that actually describes what is wrong with it;
 *     - parentheses, `keyof`/`readonly`/`unique` operators, `?`/`...` tuple
 *       markers, named tuple members, `x is T` predicates. None of these nest
 *       data; they qualify a type that is already there;
 *     - leaves: keywords (`string`, `unknown`, ...), literal types, `infer X`,
 *       `typeof x`, and a bare type reference with no type arguments — a NAMED
 *       type is depth 0 no matter how complicated its definition is, because
 *       naming it is exactly the fix this gate asks for.
 *
 * An unrecognised node adds 0. A future TypeScript syntax should under-report
 * rather than invent depth that is not there.
 *
 * ── CALIBRATION IS NOT PORTED, BECAUSE IT CANNOT BE ────────────────────────
 * MEASURED (kragg-ts `src/`, 62 files, 2026-08, at the ported budgets
 * depth 2 / length 40): 23 violations, of which TWENTY-ONE are length-only —
 * depth 2 or less. Only two annotations in the whole tree exceed the depth
 * budget.
 *
 * So the binding constraint in TypeScript is LENGTH, not nesting, and that is
 * a language fact rather than a code-quality one: `Readonly<Record<string,
 * unknown>>` is 33 characters before anything is done with it, and the
 * qualified names TypeScript encourages (`bundledTs.Expression`) spend a dozen
 * more. Python's 40 is a comfortable budget for `dict[str, list[int]]` and a
 * tight one here. The ported numbers are left exactly as they are — retuning
 * `typeMaxLength` is a policy decision, and it is one a project makes in
 * `kragg.json` rather than one this module makes for everyone.
 *
 * ── WHERE IT LOOKS ─────────────────────────────────────────────────────────
 * The same four sites Python reports — parameters, return types, variable
 * annotations and class fields — plus interface/object-type property
 * signatures, which are the TypeScript analogue of the `TypedDict` fields
 * Python's `AnnAssign` walk already covers.
 *
 * TWO DELIBERATE EXCLUSIONS:
 *
 *  - A `type X = ...` alias declaration is NEVER reported. The alias IS the
 *    named extraction this gate asks for; flagging its right-hand side would
 *    fail the fix.
 *  - The walk does not descend INTO a type. `const f: { m(a: Foo<Bar<Baz>>):
 *    void }` is one violation on the variable's annotation, not two. Whatever
 *    is nested inside an annotation is already counted by that annotation's
 *    own depth and length.
 *
 * Type assertions (`x as T`), type-parameter constraints and defaults, and
 * heritage clauses (`extends Foo<Bar>`) are not annotation sites and are not
 * reported. That matches Python, which checks annotations only.
 *
 * `.d.ts` files are EXEMPT, inheriting the default of `parsedSources`. A
 * declaration file is generated by a build or vendored from a dependency; the
 * gate's only remedy is "give this shape a name", and you cannot name a shape
 * in a file you do not write. A hand-authored `.d.ts` is a real gap and is
 * documented as one rather than being papered over with a heuristic.
 *
 * A reviewed-safe annotation is silenced with `// kragg: ignore -- <reason>` on any line
 * it spans. Python's gate has no suppression hook; this one follows the
 * repo-wide convention in `util/suppress.ts` instead, because a gate with no
 * escape valve gets its budget raised for everyone by the first person who
 * legitimately needs a wide type.
 */

import type ts from "typescript";

import {
  absolutePath,
  parsedSources,
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import type { Violation } from "../engine/models.ts";
import { suppression, unhonouredMessage } from "../util/suppress.ts";
import { functionBlockLabel, isFunctionBlock } from "./halstead.ts";

/** `Violation.code` for every finding this gate produces. */
export const TYPE_COMPLEXITY_CODE = "type-complexity";

export interface TypeComplexityOptions {
  /** Absolute project root. */
  readonly root: string;
  /** Directories to walk, as `KraggPolicy.sourcePaths`. */
  readonly sourcePaths: readonly string[];
  /** `KraggPolicy.typeMaxNestingDepth` — depth ABOVE which a type fails. */
  readonly maxDepth: number;
  /** `KraggPolicy.typeMaxLength` — rendered length above which a type fails. */
  readonly maxLength: number;
  /** Compiler to parse with. Defaults to `resolveTypeScript(root).api`. */
  readonly api?: TypeScriptApi | undefined;
  /**
   * Restrict the scan to these files — the `--changed` path. Paths may be
   * absolute or root-relative; anything outside `sourcePaths` is dropped,
   * because it was never in the whole-project scan either.
   */
  readonly paths?: readonly string[] | undefined;
}

/**
 * Report one violation per annotation over budget.
 *
 * There is no `{ ok: false }` arm, unlike `checkForbiddenCalls`: this gate
 * needs no type checker and so has nothing that can fail to load. A file that
 * cannot be read or does not parse is skipped by `parsedSources`, exactly as
 * Python's `except SyntaxError: return []` skips it.
 *
 * Violations are ordered by file (walk order) and, within a file, by position.
 */
export function checkTypeComplexity(
  options: TypeComplexityOptions,
): readonly Violation[] {
  const api = options.api ?? resolveTypeScript(options.root).api;
  const wanted = selectedPaths(options);
  const limits: Limits = {
    maxDepth: options.maxDepth,
    maxLength: options.maxLength,
    api,
  };
  const violations: Violation[] = [];
  for (const source of parsedSources(options.root, options.sourcePaths, { api })) {
    if (wanted !== null && !wanted.has(source.path)) {
      continue;
    }
    violations.push(...scanSource(source, limits));
  }
  return violations;
}

/**
 * The nesting depth of one type node — see the module doc for the rules.
 *
 * Exported because the rule is the gate's whole contract with a project: a
 * budget nobody can reproduce by hand is a budget nobody can act on.
 */
export function typeDepth(node: ts.TypeNode, api: TypeScriptApi): number {
  return contained(node, api).reduce(
    (deepest, child) => Math.max(deepest, typeDepth(child, api)),
    0,
  ) + (nests(node, api) ? 1 : 0);
}

/**
 * The advice attached to a violation, ported branch for branch from Python's
 * `suggest_fix` with TypeScript's vocabulary substituted:
 * `dict` -> `Record`/inline object, `list` -> array, `@dataclass`/`TypedDict`
 * -> `interface`, `TypeAlias` -> named `type` alias.
 */
export function suggestFix(text: string, depth: number, maxDepth: number): string {
  const normalized = text.toLowerCase();
  const mapCount = countMaps(normalized);
  const hasList = normalized.includes("[]") || normalized.includes("array<");
  if (mapCount > 0 && hasList) {
    return "extract an `interface` with named fields";
  }
  if (mapCount >= 2) {
    return "use an `interface` instead of nested Record/object types";
  }
  if (depth <= maxDepth) {
    return "define a named `type` alias for this shape";
  }
  return "simplify with an `interface` or a named `type` alias";
}

/** Keyed shapes: `Record<...>`, `Map<...>`, and inline object types. */
function countMaps(normalized: string): number {
  return (normalized.match(/record<|map<|\{/g) ?? []).length;
}

/** The two declaration shapes that carry a single named annotation. */
type PropertyLike = ts.PropertyDeclaration | ts.PropertySignature;

/** The signature shapes an interface or object type can declare. */
type SignatureLike =
  | ts.MethodSignature
  | ts.CallSignatureDeclaration
  | ts.ConstructSignatureDeclaration;

interface Limits {
  readonly maxDepth: number;
  readonly maxLength: number;
  readonly api: TypeScriptApi;
}

/** One annotation to judge, with the words that will describe it. */
interface Site {
  readonly type: ts.TypeNode;
  readonly context: string;
}

/** Absolute paths the caller narrowed to, or `null` for "everything". */
function selectedPaths(options: TypeComplexityOptions): ReadonlySet<string> | null {
  if (options.paths === undefined) {
    return null;
  }
  return new Set(options.paths.map((path) => absolutePath(options.root, path)));
}

function scanSource(source: ParsedSource, limits: Limits): readonly Violation[] {
  const { api } = limits;
  const found: Violation[] = [];

  const visit = (node: ts.Node): void => {
    // Never descend into a type: everything inside an annotation is already
    // priced into that annotation's own depth and length.
    if (api.isTypeNode(node)) {
      return;
    }
    for (const site of sitesOf(node, api)) {
      const violation = judge(site, source, limits);
      if (violation !== null) {
        found.push(violation);
      }
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(source.sourceFile, visit);

  return found;
}

/** Turn one over-budget annotation into a violation, or `null` if it fits. */
function judge(site: Site, source: ParsedSource, limits: Limits): Violation | null {
  const { api } = limits;
  const text = renderType(site.type, source.sourceFile);
  const depth = typeDepth(site.type, api);
  const length = text.length;
  if (depth <= limits.maxDepth && length <= limits.maxLength) {
    return null;
  }
  const start = source.sourceFile.getLineAndCharacterOfPosition(
    site.type.getStart(source.sourceFile),
  );
  const end = source.sourceFile.getLineAndCharacterOfPosition(site.type.getEnd());
  const marker = suppression(source.lines, start.line + 1, end.line + 1);
  if (marker.kind === "honoured") {
    return null;
  }
  return {
    message: unhonouredMessage(
      `${site.context}: annotation \`${text}\` (depth=${depth}, length=${length})`,
      marker,
    ),
    file: source.relative,
    line: start.line + 1,
    column: start.character + 1,
    code: TYPE_COMPLEXITY_CODE,
    fixHint: suggestFix(text, depth, limits.maxDepth),
  };
}

/**
 * The annotation's text, whitespace-normalized.
 *
 * Python measures `ast.unparse(node)`, which is a canonical single-line
 * rendering. `getText` is the raw source, so a type spread over four lines
 * would otherwise be charged for its own indentation. Collapsing runs of
 * whitespace to one space is the closest honest equivalent: the budget then
 * measures the type, not the formatter.
 */
function renderType(node: ts.TypeNode, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").trim();
}

/** Whether this node contains its children rather than merely qualifying them. */
function nests(node: ts.TypeNode, api: TypeScriptApi): boolean {
  if (api.isTypeReferenceNode(node) || api.isImportTypeNode(node)) {
    // A named type is a leaf; only its ARGUMENTS make it a container.
    return (node.typeArguments?.length ?? 0) > 0;
  }
  return holdsMembers(node, api) || holdsSignature(node, api);
}

/** Container forms that hold their members directly: arrays, tuples, objects. */
function holdsMembers(node: ts.TypeNode, api: TypeScriptApi): boolean {
  return (
    api.isArrayTypeNode(node) ||
    api.isTupleTypeNode(node) ||
    api.isTypeLiteralNode(node) ||
    api.isMappedTypeNode(node) ||
    api.isIndexedAccessTypeNode(node)
  );
}

/** Container forms whose contained types are positions in a signature. */
function holdsSignature(node: ts.TypeNode, api: TypeScriptApi): boolean {
  return (
    api.isConditionalTypeNode(node) ||
    api.isFunctionTypeNode(node) ||
    api.isConstructorTypeNode(node) ||
    api.isTemplateLiteralTypeNode(node)
  );
}

/**
 * The type nodes one node holds, reached through non-type syntax.
 *
 * Recursing through non-type children is what makes this total over the type
 * AST without a switch that a new TypeScript release would silently outgrow:
 * a `PropertySignature`, a `ParameterDeclaration`, a `TypeParameterDeclaration`
 * and a `TemplateLiteralTypeSpan` are not type nodes, but each holds one, and
 * each is how a real type nests.
 */
function contained(node: ts.Node, api: TypeScriptApi): readonly ts.TypeNode[] {
  const types: ts.TypeNode[] = [];
  api.forEachChild(node, (child) => {
    if (api.isTypeNode(child)) {
      types.push(child);
    } else {
      types.push(...contained(child, api));
    }
  });
  return types;
}

/**
 * Every annotation site this node introduces.
 *
 * A node that is not a declaration site yields nothing, so the walk stays a
 * plain recursion with no special cases at the call site.
 */
function sitesOf(node: ts.Node, api: TypeScriptApi): readonly Site[] {
  if (isFunctionBlock(node, api)) {
    return signatureSites(node, functionBlockLabel(node, api), api);
  }
  if (
    api.isMethodSignature(node) ||
    api.isCallSignatureDeclaration(node) ||
    api.isConstructSignatureDeclaration(node)
  ) {
    return signatureSites(node, signatureLabel(node, api), api);
  }
  if (api.isVariableDeclaration(node) && node.type !== undefined) {
    return [{ type: node.type, context: `variable '${declarationName(node.name, api)}'` }];
  }
  if (
    (api.isPropertyDeclaration(node) || api.isPropertySignature(node)) &&
    node.type !== undefined
  ) {
    return [{ type: node.type, context: `property '${memberPath(node, api)}'` }];
  }
  return [];
}

/** Parameter annotations and the return annotation of one signature. */
function signatureSites(
  node: ts.SignatureDeclaration,
  label: string,
  api: TypeScriptApi,
): readonly Site[] {
  const sites: Site[] = [];
  for (const parameter of node.parameters) {
    if (parameter.type !== undefined) {
      sites.push({
        type: parameter.type,
        context: `parameter '${declarationName(parameter.name, api)}' in ${label}()`,
      });
    }
  }
  if (node.type !== undefined) {
    sites.push({ type: node.type, context: `return type of ${label}()` });
  }
  return sites;
}

/**
 * The name of a binding, or a stand-in when there is not one.
 *
 * A destructured parameter (`{ a, b }: Options`) has no single name, and
 * printing the whole pattern would put the shape of the binding into a message
 * that is about the shape of its TYPE.
 */
function declarationName(name: ts.BindingName, api: TypeScriptApi): string {
  return api.isIdentifier(name) ? name.text : "<destructured>";
}

/** `Owner.field` for a class or interface member; the bare name otherwise. */
function memberPath(node: PropertyLike, api: TypeScriptApi): string {
  const own = propertyName(node.name, api);
  const parent: ts.Node | undefined = node.parent;
  if (parent === undefined) {
    return own;
  }
  if (api.isClassLike(parent)) {
    return `${parent.name?.text ?? "<anonymous>"}.${own}`;
  }
  if (api.isInterfaceDeclaration(parent)) {
    return `${parent.name.text}.${own}`;
  }
  return own;
}

/** A signature's own name, falling back to the shape of the signature. */
function signatureLabel(node: SignatureLike, api: TypeScriptApi): string {
  if (api.isMethodSignature(node)) {
    return propertyName(node.name, api);
  }
  return api.isConstructSignatureDeclaration(node) ? "new" : "call";
}

function propertyName(name: ts.PropertyName, api: TypeScriptApi): string {
  if (api.isIdentifier(name) || api.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (api.isStringLiteral(name) || api.isNumericLiteral(name)) {
    return name.text;
  }
  return "<computed>";
}
