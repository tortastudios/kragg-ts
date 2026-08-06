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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  BETWEENNESS_THRESHOLD,
  FAN_IN_THRESHOLD,
  analyze,
  buildCallGraph,
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

  it("orders descending by betweenness then fan-in and caps at topN", () => {
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

  it("honours topN", () => {
    const result = analyze({
      analysis: analysisProgram({ root: project(FIXTURE), api: ts }),
      topN: 3,
    });
    assert.ok(result.ok, result.ok ? "" : result.message);
    assert.equal(result.profiles.length, 3);
  });

  it("applies both criticality thresholds, and they are configurable", () => {
    const root = project(FIXTURE);
    const strict = analyze({
      analysis: analysisProgram({ root, api: ts }),
      topN: 500,
      fanInThreshold: 5,
      betweennessThreshold: 1,
    });
    const loose = analyze({
      analysis: analysisProgram({ root, api: ts }),
      topN: 500,
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

  it("returns the WHOLE graph, not just the profiles it capped to", () => {
    const result = analyze({
      analysis: analysisProgram({ root: project(FIXTURE), api: ts }),
      topN: 3,
    });
    assert.ok(result.ok, result.ok ? "" : result.message);
    assert.equal(result.profiles.length, 3);
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
});
