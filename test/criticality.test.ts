/**
 * Tests for the call-graph criticality gate.
 *
 * Three things are worth testing here and one thing is not.
 *
 * WORTH TESTING: that the checker actually resolves the call shapes
 * TypeScript code is written in — imports, barrel re-exports, inherited
 * methods declared in another file, constructors, arrow-consts, object-literal
 * methods, accessors, default exports. Half of these are shapes the Python
 * sibling's name-based heuristic structurally cannot reach, and they are the
 * justification for doing this with a type checker at all.
 *
 * ALSO WORTH TESTING: that a call it CANNOT resolve produces no edge. A
 * fabricated edge sends a reviewer to the wrong function, so `JSON.parse` and
 * a local closure must leave the graph alone.
 *
 * AND: that the wire format stays byte-compatible with Python's `write_json`,
 * since both implementations write the same `.kragg/criticality.json`.
 *
 * NOT worth testing here: the centrality numbers. Those are pinned against
 * real networkx output in `betweenness.test.ts`, including the Python kragg's
 * own 417-node call graph. Repeating that here would test the same code twice
 * and pin nothing new.
 *
 * The tests import `typescript` directly and pass it in, which production
 * analysis code must NOT do (see `resolveTypeScript`): here it is the compiler
 * under test, and passing it explicitly keeps these off the shared cache.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import {
  edgeCount,
  inDegree,
  nodeCount,
  outDegree,
  successorsOf,
  type DirectedGraph,
} from "../src/analysis/betweenness.ts";
import { analysisProgram } from "../src/analysis/program.ts";
import { runCriticality } from "../src/commands/criticality.ts";
import { selectTargets } from "../src/commands/mutation/targets.ts";
import { criticalCoverageGaps } from "../src/gates/criticalCoverage.ts";
import { criticalFunctions } from "../src/gates/testDepth/criticalFunctions.ts";
import { DEFAULT_POLICY } from "../src/policy/policy.ts";
import { EXIT_ENVIRONMENT, EXIT_OK } from "../src/engine/report.ts";
import { stampPath } from "../src/gates/criticality/freshness.ts";
import {
  BETWEENNESS_THRESHOLD,
  FAN_IN_THRESHOLD,
  analyze,
  buildCallGraph,
  criticalityFreshness,
  criticalityPath,
  formatReport,
  formatTable,
  readJson,
  riskLabel,
  toPayload,
  writeJson,
  writeReport,
  writeStamp,
  type FunctionProfile,
} from "../src/gates/criticality.ts";
import { newScope, qualify, recordFunction } from "../src/gates/criticality/scope.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2022",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ["src/**/*.ts"],
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-criticality-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** Build the call graph for a fixture project, asserting the program loaded. */
function graphFor(root: string): DirectedGraph {
  const handle = analysisProgram({ root, api: ts });
  const loaded = handle.load();
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
  return buildCallGraph({
    api: ts,
    program: loaded.program,
    checker: loaded.checker,
    root,
  });
}

function assertEdge(graph: DirectedGraph, from: string, to: string): void {
  assert.ok(
    successorsOf(graph, from).includes(to),
    `expected edge ${from} -> ${to}; actual: ${JSON.stringify(successorsOf(graph, from))}`,
  );
}

function assertNoEdge(graph: DirectedGraph, from: string, to: string): void {
  assert.ok(
    !successorsOf(graph, from).includes(to),
    `unexpected edge ${from} -> ${to}`,
  );
}

/* --- The fixture --------------------------------------------------------- */

/**
 * A small project exercising every call shape the resolver claims to handle.
 *
 * Kept in one place so the assertions below can be precise about fan-in and
 * fan-out — a fixture that grows per-test would make every count a guess.
 */
const FIXTURE: Readonly<Record<string, string>> = {
  "src/util.ts": `
export function helper(value: number): number {
  return value + 1;
}

export const arrowHelper = (value: number): number => helper(value);

export function neverCalled(): void {}
`,
  "src/barrel.ts": `
export { helper as reexported } from "./util.ts";
`,
  "src/base.ts": `
export class Base {
  protected shared(): number {
    return 1;
  }
}
`,
  "src/service.ts": `
import { Base } from "./base.ts";
import { arrowHelper } from "./util.ts";
import { reexported } from "./barrel.ts";

export class Service extends Base {
  run(value: number): number {
    return this.shared() + this.step(value);
  }

  step(value: number): number {
    return arrowHelper(value) + reexported(value);
  }

  get label(): string {
    return String(this.run(1));
  }
}
`,
  "src/counter.ts": `
import { helper } from "./util.ts";

export class Counter {
  private total = 0;

  constructor(start: number) {
    this.total = helper(start);
  }

  #secret(): number {
    return this.total;
  }

  peek(): number {
    return this.#secret();
  }
}
`,
  "src/app.ts": `
import { Counter } from "./counter.ts";
import { Service } from "./service.ts";
import { helper } from "./util.ts";

export class Plain {}

export const boot = (): number => {
  const service = new Service();
  const counter = new Counter(1);
  return service.run(2) + counter.peek() + helper(1);
};

export function outer(): number {
  const inner = (): number => helper(3);
  return inner();
}

export function recurse(depth: number): number {
  return depth <= 0 ? 0 : recurse(depth - 1);
}

export function vendored(text: string): number {
  console.log(text);
  return Number(JSON.parse(text));
}

export function constructsPlain(): Plain {
  return new Plain();
}

export const registry = {
  start(): number {
    return boot();
  },
  stop: (): number => outer(),
};

export const started = helper(0);

export default function entry(): number {
  return boot() + registry.start();
}
`,
  "src/anon.ts": `
export function named(): number {
  return 1;
}

export default function (): number {
  return named();
}
`,
  "src/anonArrow.ts": `
export function target(): number {
  return 2;
}

export default (): number => target();
`,
};

/* --- The wide fixture ---------------------------------------------------- */

/** Exported hubs in {@link WIDE}, each called by every caller below. */
const WIDE_HUBS = 40;
/** Callers in {@link WIDE}. Three is the fan-in that makes a hub critical. */
const WIDE_CALLERS = 3;

/**
 * A project with far more than twenty functions, all of them public.
 *
 * The whole point of this fixture is the SIZE: with {@link WIDE_HUBS} critical
 * functions and a display limit of twenty, any cap that leaks out of rendering
 * and into the persisted data is visible as a count. Every hub is exported and
 * plainly named, so `criticalFunctions` keeps all of them and the export/
 * private filter is not what is being measured.
 */
const WIDE: Readonly<Record<string, string>> = wideFixture();

function wideFixture(): Readonly<Record<string, string>> {
  const hubNames = Array.from({ length: WIDE_HUBS }, (_unused, index) => `hub${String(index)}`);
  const hubs = hubNames
    .map((name) => `export function ${name}(value: number): number {\n  return value + 1;\n}\n`)
    .join("\n");
  const body = hubNames.map((name) => `${name}(1)`).join(" + ");
  const callers = Array.from(
    { length: WIDE_CALLERS },
    (_unused, index) =>
      `export function caller${String(index)}(): number {\n  return ${body};\n}\n`,
  ).join("\n");
  return {
    "src/hubs.ts": hubs,
    "src/callers.ts": `import { ${hubNames.join(", ")} } from "./hubs.ts";\n\n${callers}`,
  };
}

describe("buildCallGraph — what a real type checker resolves", () => {
  const graph = graphFor(project(FIXTURE));

  it("registers module-level functions, including never-called ones", () => {
    // Seeding the graph with uncalled functions is load-bearing: it raises n
    // and therefore lowers every centrality, exactly as Python's
    // `add_nodes_from(index.functions)` does.
    assert.ok(graph.nodes.includes("src/util#neverCalled"));
    assert.equal(inDegree(graph, "src/util#neverCalled"), 0);
    assert.equal(outDegree(graph, "src/util#neverCalled"), 0);
  });

  it("registers an arrow function bound to a const", () => {
    // The dominant idiom in TypeScript. Excluding it would gut the graph.
    assert.ok(graph.nodes.includes("src/util#arrowHelper"));
    assertEdge(graph, "src/util#arrowHelper", "src/util#helper");
    assert.ok(graph.nodes.includes("src/app#boot"));
  });

  it("resolves a bare call inside its own module", () => {
    assertEdge(graph, "src/app#boot", "src/util#helper");
  });

  it("resolves a call through an import", () => {
    assertEdge(graph, "src/service#Service.step", "src/util#arrowHelper");
  });

  it("resolves a call through a BARREL RE-EXPORT", () => {
    // `reexported` is an alias of an alias. getAliasedSymbol follows the whole
    // chain to the definition in ./util.
    assertEdge(graph, "src/service#Service.step", "src/util#helper");
  });

  it("resolves this.method() within the class", () => {
    assertEdge(graph, "src/service#Service.run", "src/service#Service.step");
  });

  it("resolves an INHERITED method declared in another file", () => {
    // This is the case the Python heuristic structurally cannot reach: it
    // resolves `self.method()` only against the enclosing class's own body.
    assertEdge(graph, "src/service#Service.run", "src/base#Base.shared");
  });

  it("resolves a method on a locally constructed instance", () => {
    // Python manages this one only because the receiver comes from a direct
    // constructor call; the checker manages it for any expression it can type.
    assertEdge(graph, "src/app#boot", "src/service#Service.run");
    assertEdge(graph, "src/app#boot", "src/counter#Counter.peek");
  });

  it("resolves a constructor call to Class.constructor", () => {
    // The analogue of Python resolving `Foo()` to `Foo.__init__`.
    assertEdge(graph, "src/app#boot", "src/counter#Counter.constructor");
    assertEdge(graph, "src/counter#Counter.constructor", "src/util#helper");
  });

  it("falls back to the class node when there is no declared constructor", () => {
    // Python's `_constructor` does the same: `Class.__init__` if defined, else
    // the class itself. Which means the class only becomes a node once someone
    // constructs it.
    assertEdge(graph, "src/app#constructsPlain", "src/app#Plain");
    assertEdge(graph, "src/app#boot", "src/service#Service");
  });

  it("registers private methods and resolves calls to them", () => {
    assertEdge(graph, "src/counter#Counter.peek", "src/counter#Counter.#secret");
  });

  it("registers accessors under distinct names", () => {
    assert.ok(graph.nodes.includes("src/service#Service.get label"));
    assertEdge(graph, "src/service#Service.get label", "src/service#Service.run");
  });

  it("registers object-literal methods, both spellings", () => {
    assertEdge(graph, "src/app#registry.start", "src/app#boot");
    assertEdge(graph, "src/app#registry.stop", "src/app#outer");
  });

  it("keeps the real name of a NAMED default export", () => {
    // `export default function entry()` is still `entry` to anyone importing
    // it by name, and a report that called it `default` would point nowhere.
    assert.ok(graph.nodes.includes("src/app#entry"));
    assertEdge(graph, "src/app#entry", "src/app#boot");
    assertEdge(graph, "src/app#entry", "src/app#registry.start");
  });

  it("names an ANONYMOUS default export `default`, function or arrow", () => {
    assertEdge(graph, "src/anon#default", "src/anon#named");
    assertEdge(graph, "src/anonArrow#default", "src/anonArrow#target");
  });
});

describe("buildCallGraph — what it refuses to invent", () => {
  const graph = graphFor(project(FIXTURE));

  it("drops calls into lib.d.ts and node_modules", () => {
    // `console.log`, `JSON.parse` and `Number` resolve to declarations outside
    // the analyzed set. They are skipped, not turned into pseudo-nodes.
    assert.equal(outDegree(graph, "src/app#vendored"), 0);
    for (const node of graph.nodes) {
      assert.ok(
        node.startsWith("src/"),
        `graph leaked a node from outside the source set: ${node}`,
      );
    }
  });

  it("does not make a function nested in a body into a node", () => {
    // Python's `_index_definitions` never recurses into a `FunctionDef`
    // either. The closure's calls are attributed to the enclosing function.
    assert.ok(!graph.nodes.includes("src/app#inner"));
    assertEdge(graph, "src/app#outer", "src/util#helper");
  });

  it("drops self-recursion rather than adding a self-loop", () => {
    // Matches Python's `callee != body.qualname` guard. A self-loop would also
    // be silently ignored by the centrality computation, but it would still
    // inflate fan-in, so it has to go at the source.
    assertNoEdge(graph, "src/app#recurse", "src/app#recurse");
    assert.equal(inDegree(graph, "src/app#recurse"), 0);
  });

  it("ignores calls made at module top level", () => {
    // `export const started = helper(0)` has no enclosing function, so it is
    // not attributed to anything. Python only ever walks function bodies.
    assert.ok(!graph.nodes.includes("src/app#started"));
    const callers = graph.nodes.filter((node) =>
      successorsOf(graph, node).includes("src/util#helper"),
    );
    assert.deepEqual(callers.sort(), [
      "src/app#boot",
      "src/app#outer",
      "src/counter#Counter.constructor",
      "src/service#Service.step",
      "src/util#arrowHelper",
    ]);
  });

  it("counts distinct callers, not call sites", () => {
    assert.equal(inDegree(graph, "src/util#helper"), 5);
    assert.equal(inDegree(graph, "src/app#boot"), 2);
  });

  it("is deterministic: two builds produce the same graph", () => {
    const again = graphFor(project(FIXTURE));
    assert.deepEqual(again.nodes, graph.nodes);
    assert.equal(edgeCount(again), edgeCount(graph));
  });
});

describe("analyze", () => {
  it("reports a broken environment instead of throwing", () => {
    // Mirrors `ProgramLoad`: the caller has to turn this into a GateResult
    // with error: true, and an exception would make the normal path the one
    // that needs a try/catch. Python raises RuntimeError here because it has
    // no such obligation.
    const root = mkdtempSync(join(tmpdir(), "kragg-criticality-"));
    temporaryRoots.push(root);
    const result = analyze({ analysis: analysisProgram({ root, api: ts }) });
    assert.equal(result.ok, false);
    assert.ok(result.ok || result.message.includes("no tsconfig.json"));
  });

  it("orders descending by betweenness then fan-in, over the whole graph", () => {
    const result = analyze({ analysis: analysisProgram({ root: project(FIXTURE), api: ts }) });
    assert.ok(result.ok, result.ok ? "" : result.message);
    const profiles = result.profiles;
    assert.ok(profiles.length > 0);
    for (let index = 1; index < profiles.length; index += 1) {
      const previous = profiles[index - 1];
      const current = profiles[index];
      assert.ok(previous !== undefined && current !== undefined);
      assert.ok(
        previous.betweenness > current.betweenness ||
          (previous.betweenness === current.betweenness && previous.fanIn >= current.fanIn),
        `out of order at ${String(index)}: ${previous.name} then ${current.name}`,
      );
    }
  });

  it("ranks EVERY node — there is no analysis-side cap to enforce through", () => {
    // The bug this pins: `analyze` used to return `profiles.slice(0, 20)`, and
    // since the cache persists exactly what it returns, the criticality gates
    // enforced on whatever survived a DISPLAY limit. WIDE has 43 functions.
    const result = analyze({ analysis: analysisProgram({ root: project(WIDE), api: ts }) });
    assert.ok(result.ok, result.ok ? "" : result.message);
    assert.equal(result.profiles.length, nodeCount(result.graph));
    assert.equal(result.profiles.length, WIDE_HUBS + WIDE_CALLERS);
    assert.ok(result.profiles.length > 20);
    assert.equal(
      result.profiles.filter((entry) => entry.isCritical).length,
      WIDE_HUBS,
    );
  });

  it("applies both criticality thresholds, and they are configurable", () => {
    const root = project(FIXTURE);
    const strict = analyze({
      analysis: analysisProgram({ root, api: ts }),
      fanInThreshold: 5,
      betweennessThreshold: 1,
    });
    const loose = analyze({
      analysis: analysisProgram({ root, api: ts }),
      fanInThreshold: 1,
      betweennessThreshold: 1,
    });
    assert.ok(strict.ok && loose.ok);
    const criticalIn = (result: readonly FunctionProfile[]): string[] =>
      result.filter((profile) => profile.isCritical).map((profile) => profile.name).sort();
    // Only `helper` has five callers.
    assert.deepEqual(criticalIn(strict.profiles), ["src/util#helper"]);
    assert.ok(criticalIn(loose.profiles).length > criticalIn(strict.profiles).length);
  });

  it("returns the graph alongside the profiles, so no caller rebuilds it", () => {
    const result = analyze({
      analysis: analysisProgram({ root: project(FIXTURE), api: ts }),
    });
    assert.ok(result.ok, result.ok ? "" : result.message);
    assert.equal(result.profiles.length, nodeCount(result.graph));
    assert.ok(nodeCount(result.graph) > 3);
  });

  it("returns no profiles for a project with no functions", () => {
    const root = project({ "src/empty.ts": "export const value = 1;\n" });
    const result = analyze({ analysis: analysisProgram({ root, api: ts }) });
    assert.ok(result.ok, result.ok ? "" : result.message);
    assert.deepEqual(result.profiles, []);
    assert.equal(nodeCount(result.graph), 0);
  });
});

/* --- Reporting ----------------------------------------------------------- */

function profile(init: Partial<FunctionProfile> & Pick<FunctionProfile, "name">): FunctionProfile {
  return {
    name: init.name,
    fanIn: init.fanIn ?? 0,
    fanOut: init.fanOut ?? 0,
    betweenness: init.betweenness ?? 0,
    isCritical: init.isCritical ?? false,
  };
}

describe("riskLabel", () => {
  it("uses HIGH for betweenness >= 0.2 or fan-in >= 5", () => {
    assert.equal(riskLabel(profile({ name: "a", betweenness: 0.2 })), "HIGH");
    assert.equal(riskLabel(profile({ name: "a", fanIn: 5 })), "HIGH");
  });

  it("uses MED at the criticality thresholds", () => {
    assert.equal(
      riskLabel(profile({ name: "a", betweenness: BETWEENNESS_THRESHOLD })),
      "MED",
    );
    assert.equal(riskLabel(profile({ name: "a", fanIn: FAN_IN_THRESHOLD })), "MED");
    assert.equal(riskLabel(profile({ name: "a", betweenness: 0.19, fanIn: 4 })), "MED");
  });

  it("uses low below both", () => {
    assert.equal(riskLabel(profile({ name: "a", betweenness: 0.0999, fanIn: 2 })), "low");
  });
});

describe("formatReport", () => {
  const profiles: readonly FunctionProfile[] = [
    profile({ name: "src/a#hot", fanIn: 6, fanOut: 2, betweenness: 0.25, isCritical: true }),
    profile({ name: "src/a#cold", fanIn: 1, fanOut: 1, betweenness: 0.01 }),
  ];

  it("splits critical from non-critical and keeps the Python wording", () => {
    const report = formatReport(profiles);
    assert.ok(report.startsWith("# Critical Functions\n"));
    assert.ok(report.includes("> Auto-generated by `kragg criticality --write`."));
    assert.ok(report.includes("## Critical\n"));
    assert.ok(report.includes("## Non-critical\n"));
    assert.ok(report.includes("| `src/a#hot` | 6 | 2 | 0.2500 | HIGH |"));
    assert.ok(report.includes("| `src/a#cold` | 1 | 1 | 0.0100 | low |"));
    assert.ok(report.endsWith("\n"));
  });

  it("omits a section that would be empty", () => {
    const criticalOnly = formatReport([profiles[0] as FunctionProfile]);
    assert.ok(criticalOnly.includes("## Critical"));
    assert.ok(!criticalOnly.includes("## Non-critical"));
  });

  it("says so when there is nothing to report", () => {
    assert.ok(formatReport([]).includes("No functions found."));
  });

  it("writeReport creates missing directories", () => {
    const root = mkdtempSync(join(tmpdir(), "kragg-criticality-"));
    temporaryRoots.push(root);
    const path = join(root, "docs", "critical.md");
    writeReport(profiles, path);
    assert.equal(readFileSync(path, "utf8"), formatReport(profiles));
  });
});

describe("the JSON wire format", () => {
  const profiles: readonly FunctionProfile[] = [
    profile({
      name: "src/a#hot",
      fanIn: 6,
      fanOut: 2,
      betweenness: 0.0058213623725671924,
      isCritical: true,
    }),
  ];

  it("uses snake_case keys, matching Python's write_json", () => {
    assert.deepEqual(toPayload(profiles), [
      {
        name: "src/a#hot",
        fan_in: 6,
        fan_out: 2,
        betweenness: 0.0058,
        is_critical: true,
        risk: "HIGH",
      },
    ]);
  });

  it("rounds betweenness to 4 decimals, as round(value, 4) does", () => {
    const payload = toPayload([
      profile({ name: "a", betweenness: 0.00504 }),
      profile({ name: "b", betweenness: 0.0050390021624961388 }),
      profile({ name: "c", betweenness: 0 }),
    ]);
    assert.deepEqual(
      payload.map((entry) => entry.betweenness),
      [0.005, 0.005, 0],
    );
  });

  it("writes indent-1 JSON with a trailing newline, byte-for-byte with Python", () => {
    const root = mkdtempSync(join(tmpdir(), "kragg-criticality-"));
    temporaryRoots.push(root);
    const path = criticalityPath(root);
    writeJson(profiles, path);
    const text = readFileSync(path, "utf8");
    assert.equal(
      text,
      '[\n {\n  "name": "src/a#hot",\n  "fan_in": 6,\n  "fan_out": 2,\n' +
        '  "betweenness": 0.0058,\n  "is_critical": true,\n  "risk": "HIGH"\n }\n]\n',
    );
  });

  it("round-trips through readJson", () => {
    const root = mkdtempSync(join(tmpdir(), "kragg-criticality-"));
    temporaryRoots.push(root);
    writeJson(profiles, criticalityPath(root));
    // Stamped, because `readJson` hands out nothing it cannot vouch for —
    // see `criticalityFreshness.test.ts`. Writing the data without stamping it
    // is exactly the unverifiable state that made a gate report on functions
    // that no longer existed.
    writeStamp(root, ["src"]);
    const entries = readJson(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.["name"], "src/a#hot");
    assert.equal(entries[0]?.["risk"], "HIGH");
  });

  it("degrades to an empty list rather than throwing", () => {
    // A repo that has never run the analysis is a legitimate state, and the
    // gates that read this file still have to report on everything else.
    const root = mkdtempSync(join(tmpdir(), "kragg-criticality-"));
    temporaryRoots.push(root);
    assert.deepEqual(readJson(root), []);

    mkdirSync(join(root, ".kragg"), { recursive: true });
    writeFileSync(criticalityPath(root), "{ not json");
    writeStamp(root, ["src"]);
    assert.deepEqual(readJson(root), []);

    writeFileSync(criticalityPath(root), '{"name": "not a list"}');
    assert.deepEqual(readJson(root), []);

    writeFileSync(criticalityPath(root), '[1, "two", null, [], {"name": "ok"}]');
    assert.deepEqual(readJson(root), [{ name: "ok" }]);
  });
});

describe("formatTable", () => {
  it("uses the Python column widths so the two tools line up", () => {
    const lines = formatTable([
      profile({ name: "src/a#hot", fanIn: 6, fanOut: 2, betweenness: 0.25, isCritical: true }),
    ]);
    const [header, rule, row] = lines;
    assert.ok(header !== undefined && rule !== undefined && row !== undefined);
    assert.ok(header.startsWith("Function" + " ".repeat(47)));
    assert.equal(rule, "-".repeat(96));
    assert.equal(row, `${"src/a#hot".padEnd(55)} ${"6".padStart(8)} ${"2".padStart(8)} ` +
      `${"0.2500".padStart(12)} ${"HIGH".padStart(8)}`);
  });

  it("says so when there is nothing to show", () => {
    assert.deepEqual(formatTable([]), ["No functions found."]);
  });

  it("shows the twenty riskiest and no more, however many it is handed", () => {
    const many = Array.from({ length: 60 }, (_unused, index) =>
      profile({ name: `src/a#fn${String(index)}`, fanIn: 60 - index }),
    );
    // Header, rule, then TOP_N rows.
    assert.equal(formatTable(many).length, 22);
    assert.ok(formatTable(many).at(-1)?.startsWith("src/a#fn19 "));
  });
});

/* --- Display truncation vs. enforcement data ----------------------------- */

/**
 * The regression this whole file exists to keep out: a DISPLAY limit that
 * silently became an ENFORCEMENT limit.
 *
 * `analyze` used to return `profiles.slice(0, 20)`, and both the sidecar and
 * the cache persist exactly what it returns — so on any project with more than
 * twenty functions the criticality gates enforced on whatever happened to fit
 * in a table. On kragg-ts itself that was 4 of its 130 critical functions.
 *
 * The assertions below run the real command on a project with
 * {@link WIDE_HUBS} critical functions and follow the data into each consumer:
 * coverage, the test-depth family, and mutation targeting.
 */
describe("the top-N limit is presentation, not enforcement", () => {
  const root = project(WIDE);
  const printed: string[] = [];
  const exit = runCriticality({ root, write: true, log: (line) => printed.push(line) });
  const total = WIDE_HUBS + WIDE_CALLERS;

  it("persists the COMPLETE population to the sidecar the gates read", () => {
    assert.equal(exit, EXIT_OK);
    const entries = readJson(root);
    assert.equal(entries.length, total);
    assert.equal(
      entries.filter((entry) => entry["is_critical"] === true).length,
      WIDE_HUBS,
    );
  });

  it("keeps the sidecar's wire shape: same keys, same ranking, more rows", () => {
    const entries = readJson(root);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry), [
        "name",
        "fan_in",
        "fan_out",
        "betweenness",
        "is_critical",
        "risk",
      ]);
    }
    // Still the descending (betweenness, fan_in) order `analyze` produced.
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      assert.ok(previous !== undefined && current !== undefined);
      const drop = Number(previous["betweenness"]) - Number(current["betweenness"]);
      assert.ok(
        drop > 0 || (drop === 0 && Number(previous["fan_in"]) >= Number(current["fan_in"])),
        `out of order at ${String(index)}`,
      );
    }
  });

  it("still renders only the twenty riskiest to a human", () => {
    const markdown = readFileSync(join(root, "CRITICALITY.md"), "utf8");
    const rows = markdown.split("\n").filter((line) => line.startsWith("| `"));
    assert.equal(rows.length, 20);
    assert.ok(rows.length < total);
  });

  it("hands every eligible critical function to the test-depth family", () => {
    // `critical-tests`, `test-quality` and `critical-coverage` all resolve
    // their population through this one function.
    const criticals = criticalFunctions(root, ["src"], { api: ts });
    assert.equal(criticals.length, WIDE_HUBS);
    assert.ok(criticals.every((entry) => entry.file === "src/hubs.ts"));
  });

  it("preserves the export/private filter while doing it", () => {
    // Nothing here is private, so the filter must drop nothing — and the
    // count above must not be the filter's doing.
    const withPrivate = criticalFunctions(root, ["src"], { api: ts, includePrivate: true });
    assert.equal(withPrivate.length, WIDE_HUBS);
    // A module the policy does not call source still resolves to nothing.
    assert.deepEqual(criticalFunctions(root, ["nowhere"], { api: ts }), []);
  });

  it("hands every one of them to critical-coverage", () => {
    const lines = readFileSync(join(root, "src", "hubs.ts"), "utf8").split("\n");
    const records: string[] = [];
    lines.forEach((line, index) => {
      records.push(`DA:${String(index + 1)},0`);
      const declared = /^export function (?<name>\w+)/u.exec(line)?.groups?.["name"];
      if (declared !== undefined) {
        records.push(`FN:${String(index + 1)},${declared}`, `FNDA:0,${declared}`);
      }
    });
    const lcov = ["TN:", "SF:src/hubs.ts", ...records, "end_of_record", ""].join("\n");
    const gaps = criticalCoverageGaps({ root, sourcePaths: ["src"], report: null, lcov, api: ts });
    assert.equal(gaps.length, WIDE_HUBS);
    assert.ok(gaps.every((gap) => gap.measured && gap.missingLines.length > 0));
  });

  it("hands the files defining them to mutation targeting", async () => {
    const selection = await selectTargets({ root, policy: DEFAULT_POLICY });
    assert.ok(selection.ok, selection.ok ? "" : selection.message);
    assert.equal(selection.source, "criticality");
    assert.deepEqual(selection.files, ["src/hubs.ts"]);
  });

  it("prints the table it always printed", () => {
    assert.ok(printed.some((line) => line.startsWith("Wrote ")));
  });
});

/**
 * The registration pass's one write, on its own.
 *
 * `recordFunction` keys TWO maps with DIFFERENT nodes on purpose: `functions`
 * by the node the checker hands back for a symbol, `bodies` by the node whose
 * subtree holds the calls to attribute. Collapsing them would silently
 * mis-attribute every call inside an arrow-const — the shape most of this
 * codebase is written in — so the two keys are pinned here rather than
 * inferred from a graph three layers downstream.
 */
describe("recordFunction", () => {
  function firstFunction(code: string): {
    declaration: ts.FunctionDeclaration;
    body: ts.Block;
  } {
    const file = ts.createSourceFile(
      "snippet.ts",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declaration = file.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.body !== undefined,
    );
    assert.ok(declaration !== undefined, `expected a function with a body in: ${code}`);
    const body = declaration.body;
    assert.ok(body !== undefined);
    return { declaration, body };
  }

  it("keys the declaration and the body separately, under one name", () => {
    const scope = newScope(ts);
    const { declaration, body } = firstFunction("export function send(a: number) { return a; }\n");
    const name = qualify("src/client", [], "send");
    assert.equal(name, "src/client#send");

    recordFunction(scope, declaration, body, name);

    assert.deepEqual([...scope.names], [name]);
    assert.equal(scope.functions.get(declaration), name);
    assert.equal(scope.bodies.get(body), name);
    assert.equal(scope.bodies.get(declaration), undefined, "the body key is the body");
    assert.equal(scope.classes.size, 0);
    assert.equal(scope.constructors.size, 0);
  });

  it("lets an overload set collapse onto one name without duplicating it", () => {
    const scope = newScope(ts);
    const one = firstFunction("export function send(a: number) { return a; }\n");
    const two = firstFunction("export function send(a: string) { return a; }\n");
    const name = qualify("src/client", ["Client"], "send");
    assert.equal(name, "src/client#Client.send");

    recordFunction(scope, one.declaration, one.body, name);
    recordFunction(scope, two.declaration, two.body, name);

    assert.equal(scope.names.size, 1, "one name, however many signatures declare it");
    assert.equal(scope.functions.size, 2);
    assert.equal(scope.functions.get(one.declaration), name);
    assert.equal(scope.functions.get(two.declaration), name);
    assert.equal(scope.bodies.get(two.body), name);
  });
});

describe("kragg criticality --write: artifacts that could not be written", () => {
  const FIXTURE: Readonly<Record<string, string>> = {
    "src/a.ts": [
      "export function leaf(): number {",
      "  return 1;",
      "}",
      "export function top(): number {",
      "  return leaf();",
      "}",
      "",
    ].join("\n"),
  };

  /** Run the command with both streams captured. */
  function run(root: string): {
    readonly code: number;
    readonly out: string[];
    readonly err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCriticality({
      root,
      write: true,
      log: (line) => out.push(line),
      logError: (line) => err.push(line),
    });
    return { code, out, err };
  }

  it("writes the data, the report and the stamp on the ordinary path", () => {
    const root = project(FIXTURE);
    const result = run(root);
    assert.equal(result.code, 0);
    assert.deepEqual(result.err, []);
    assert.match(result.out.join("\n"), /^Wrote /u);
    assert.match(readFileSync(criticalityPath(root), "utf8"), /src\/a#leaf/u);
    assert.ok(readFileSync(join(root, "CRITICALITY.md"), "utf8").length > 0);
    assert.equal(criticalityFreshness(root), "fresh");
  });

  it("reports a read-only checkout instead of printing `Wrote` for nothing", () => {
    // "Never report work that did not happen" applies to artifacts too. The
    // write throws EACCES; announcing `Wrote …` and exiting 0 would be the
    // same lie a passing gate that never ran tells.
    if (process.getuid?.() === 0) {
      return; // root ignores the mode bits, so there is nothing to observe.
    }
    const root = project(FIXTURE);
    chmodSync(root, 0o500);
    try {
      const result = run(root);
      assert.equal(result.code, EXIT_ENVIRONMENT);
      assert.deepEqual(result.out, []);
      assert.match(result.err.join("\n"), /could not write the criticality artifacts/u);
      assert.match(result.err.join("\n"), /Fix:/u);
    } finally {
      chmodSync(root, 0o700);
    }
    assert.throws(() => readFileSync(join(root, "CRITICALITY.md"), "utf8"));
  });

  it("says so when the data landed but its freshness stamp could not", () => {
    // Milder: the data IS correct, nothing on disk can vouch for it, so every
    // later run will read it as stale and derive again. Correct, and worth one
    // line rather than a permanent unexplained re-derivation.
    if (process.getuid?.() === 0) {
      return;
    }
    const root = project(FIXTURE);
    assert.equal(run(root).code, 0);
    chmodSync(stampPath(root), 0o400);
    try {
      const result = run(root);
      assert.equal(result.code, 0, "the data was written, so this is not an error exit");
      assert.match(result.out.join("\n"), /^Wrote /u);
      assert.match(result.err.join("\n"), /could not write its freshness stamp/u);
    } finally {
      chmodSync(stampPath(root), 0o600);
    }
  });
});
