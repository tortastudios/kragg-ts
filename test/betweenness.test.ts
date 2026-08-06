/**
 * Tests for Brandes' betweenness centrality.
 *
 * THE POINT OF THIS FILE IS CROSS-LANGUAGE PARITY, not "does the algorithm
 * run". kragg-ts and the Python kragg must classify the same codebase
 * identically, and criticality is a threshold on this float
 * (`betweenness >= 0.1`). A convention mismatch does not show up as a wrong
 * number, it shows up as two tools quietly disagreeing about what is critical.
 *
 * So every expectation here is GROUND TRUTH FROM NETWORKX, not from this
 * implementation. Two kinds:
 *
 *  1. Small graphs whose exact centrality is derivable by hand — each one
 *     states the raw path count in a comment so a reader can check the value
 *     without running anything, and each was confirmed against
 *     `networkx.betweenness_centrality(g, normalized=True)` on networkx 3.6.1.
 *  2. THE REAL GOLDEN: the actual call graph of the Python kragg (417 nodes,
 *     564 edges), with the published centralities from that repo's committed
 *     `.kragg/criticality.json`. See `CRAG_*` below for provenance.
 *
 * Values are asserted to 10 decimal places for the analytic cases and to the
 * published 4 decimals for the golden — the Python side rounds to 4 in
 * `write_json`, so 4 is the width the cross-language contract is actually
 * stated at. Nothing here asserts bit-exact float equality with Python: both
 * sides sum over sources in their own iteration order, and the Python side's
 * order comes from a `set` of qualified names.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addEdge,
  addNode,
  betweennessCentrality,
  createDirectedGraph,
  directedGraphFrom,
  edgeCount,
  inDegree,
  nodeCount,
  outDegree,
  successorsOf,
  type DirectedGraph,
} from "../src/analysis/betweenness.ts";

/** Build a graph from `"a>b"` edge strings, plus optional isolated nodes. */
function graph(edges: readonly string[], isolated: readonly string[] = []): DirectedGraph {
  return directedGraphFrom(
    edges.map((edge) => {
      const [source, target] = edge.split(">");
      assert.ok(source !== undefined && target !== undefined, `bad edge ${edge}`);
      return [source, target] as const;
    }),
    isolated,
  );
}

/** Assert every node's centrality, to `digits` decimals, with none missing. */
function assertCentrality(
  actual: ReadonlyMap<string, number>,
  expected: Readonly<Record<string, number>>,
  digits = 10,
): void {
  assert.deepEqual(
    [...actual.keys()].sort(),
    Object.keys(expected).sort(),
    "result must contain exactly the graph's nodes",
  );
  for (const [node, value] of Object.entries(expected)) {
    const got = actual.get(node);
    assert.ok(got !== undefined, `missing node ${node}`);
    assert.equal(
      round(got, digits),
      round(value, digits),
      `${node}: expected ${String(value)}, got ${String(got)}`,
    );
  }
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

const THIRD = 1 / 3;

describe("directed graph construction", () => {
  it("is a simple digraph: repeated edges collapse", () => {
    const g = graph(["a>b", "a>b", "b>c"]);
    assert.equal(nodeCount(g), 3);
    assert.equal(edgeCount(g), 2);
    assert.equal(outDegree(g, "a"), 1);
    assert.equal(inDegree(g, "b"), 1);
  });

  it("keeps direction: in and out degree are not symmetric", () => {
    const g = graph(["a>b", "c>b"]);
    assert.equal(inDegree(g, "b"), 2);
    assert.equal(outDegree(g, "b"), 0);
    assert.deepEqual(successorsOf(g, "a"), ["b"]);
    assert.deepEqual(successorsOf(g, "b"), []);
  });

  it("reports zero degree for a node it does not have", () => {
    const g = graph(["a>b"]);
    assert.equal(inDegree(g, "nope"), 0);
    assert.equal(outDegree(g, "nope"), 0);
  });

  it("preserves insertion order, isolated nodes first", () => {
    const g = graph(["b>c", "a>b"], ["z"]);
    assert.deepEqual(g.nodes, ["z", "b", "c", "a"]);
  });

  it("addNode is idempotent and never clears existing edges", () => {
    const g = createDirectedGraph();
    addEdge(g, "a", "b");
    addNode(g, "a");
    assert.equal(outDegree(g, "a"), 1);
    assert.equal(nodeCount(g), 2);
  });
});

describe("betweennessCentrality — analytic graphs", () => {
  it("path of 3: the middle node carries the one path", () => {
    // raw: b lies on (a,c) only -> 1. n=3, scale 1/((3-1)(3-2)) = 1/2.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c"])), {
      a: 0,
      b: 0.5,
      c: 0,
    });
  });

  it("path of 4", () => {
    // raw: b on (a,c),(a,d) -> 2; c on (a,d),(b,d) -> 2. n=4, scale 1/6.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "c>d"])), {
      a: 0,
      b: THIRD,
      c: THIRD,
      d: 0,
    });
  });

  it("path of 5", () => {
    // raw: b -> 3, c -> 4, d -> 3. n=5, scale 1/12.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "c>d", "d>e"])), {
      a: 0,
      b: 0.25,
      c: THIRD,
      d: 0.25,
      e: 0,
    });
  });

  it("out-star: no node is between any pair, so everything is zero", () => {
    assertCentrality(betweennessCentrality(graph(["h>a", "h>b", "h>c"])), {
      h: 0,
      a: 0,
      b: 0,
      c: 0,
    });
  });

  it("in-star: direction matters, still all zero", () => {
    assertCentrality(betweennessCentrality(graph(["a>h", "b>h", "c>h"])), {
      h: 0,
      a: 0,
      b: 0,
      c: 0,
    });
  });

  it("hub with one inbound and two outbound arms", () => {
    // raw: h on (a,b),(a,c) -> 2. n=4, scale 1/6.
    assertCentrality(betweennessCentrality(graph(["a>h", "h>b", "h>c"])), {
      a: 0,
      h: THIRD,
      b: 0,
      c: 0,
    });
  });

  it("diamond: two equal shortest paths split the credit", () => {
    // (s,t) has sigma=2, so each of l,r gets 1/2. n=4, scale 1/6.
    assertCentrality(betweennessCentrality(graph(["s>l", "s>r", "l>t", "r>t"])), {
      s: 0,
      l: 1 / 12,
      r: 1 / 12,
      t: 0,
    });
  });

  it("multipath: dependency accumulates through a downstream node", () => {
    // t is on (s,u) [whole], (m1,u), (m2,u) -> raw 3; m1,m2 each 1/2 on (s,t)
    // plus 1/2 on (s,u) -> raw 1 each. n=5, scale 1/12.
    assertCentrality(
      betweennessCentrality(graph(["s>m1", "s>m2", "m1>t", "m2>t", "t>u"])),
      { s: 0, m1: 1 / 12, m2: 1 / 12, t: 0.25, u: 0 },
    );
  });

  it("double diamond: fractional credit propagates across two layers", () => {
    // networkx raw: m=9, a1=a2=b1=b2=2. n=7, scale 1/30.
    assertCentrality(
      betweennessCentrality(
        graph(["s>a1", "s>a2", "a1>m", "a2>m", "m>b1", "m>b2", "b1>t", "b2>t"]),
      ),
      { s: 0, a1: 1 / 15, a2: 1 / 15, m: 0.3, b1: 1 / 15, b2: 1 / 15, t: 0 },
    );
  });

  it("three-way front: sigma of 3 gives each front node a third", () => {
    // networkx raw: c=4, a=b=e=2/3. n=6, scale 1/20.
    assertCentrality(
      betweennessCentrality(graph(["s>a", "s>b", "s>e", "a>c", "b>c", "e>c", "c>d"])),
      { s: 0, a: 1 / 30, b: 1 / 30, e: 1 / 30, c: 0.2, d: 0 },
    );
  });

  it("3-cycle: every node is between the other two", () => {
    // raw 1 each. n=3, scale 1/2.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "c>a"])), {
      a: 0.5,
      b: 0.5,
      c: 0.5,
    });
  });

  it("4-cycle", () => {
    // raw 3 each. n=4, scale 1/6.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "c>d", "d>a"])), {
      a: 0.5,
      b: 0.5,
      c: 0.5,
      d: 0.5,
    });
  });

  it("complete digraph: every pair is adjacent, so nothing is between", () => {
    assertCentrality(
      betweennessCentrality(
        graph(["a>b", "b>a", "a>c", "c>a", "b>c", "c>b"]),
      ),
      { a: 0, b: 0, c: 0 },
    );
  });

  it("tree", () => {
    // raw: a on (r,c),(r,d) -> 2; b on (r,e) -> 1. n=6, scale 1/20.
    assertCentrality(
      betweennessCentrality(graph(["r>a", "r>b", "a>c", "a>d", "b>e"])),
      { r: 0, a: 0.1, b: 0.05, c: 0, d: 0, e: 0 },
    );
  });
});

describe("betweennessCentrality — the edge cases that break naive ports", () => {
  it("an empty graph produces an empty result, not a crash", () => {
    assert.deepEqual([...betweennessCentrality(createDirectedGraph())], []);
  });

  it("n = 1 and n = 2 return 0.0 without dividing by zero", () => {
    // networkx skips rescaling when n-1 < 2. It is safe because with fewer
    // than three nodes no node is ever strictly between a pair.
    assertCentrality(betweennessCentrality(graph([], ["a"])), { a: 0 });
    assertCentrality(betweennessCentrality(graph(["a>b"])), { a: 0, b: 0 });
  });

  it("isolated nodes score 0.0, are present, and DILUTE everyone else", () => {
    // This is the behaviour that makes the Python side's
    // `graph.add_nodes_from(index.functions)` load-bearing: seeding the graph
    // with never-called functions raises n and lowers every centrality.
    const dense = betweennessCentrality(graph(["a>b", "b>c"]));
    assert.equal(round(dense.get("b") ?? -1, 10), 0.5);

    const diluted = betweennessCentrality(graph(["a>b", "b>c"], ["z", "w"]));
    // n=5 now, so scale is 1/12 rather than 1/2.
    assertCentrality(diluted, { a: 0, b: 1 / 12, c: 0, z: 0, w: 0 });
  });

  it("disconnected components are handled and count toward n", () => {
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "x>y"])), {
      a: 0,
      b: 1 / 12,
      c: 0,
      x: 0,
      y: 0,
    });
  });

  it("self-loops contribute nothing but the node still counts", () => {
    // networkx admits w as a shortest-path successor only when
    // D[w] == D[v] + 1; for w === v that is false, so the loop is ignored.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "b>b"])), {
      a: 0,
      b: 0.5,
      c: 0,
    });
    // ... and a lone self-looping node is still a node: n becomes 4, so the
    // scale drops to 1/6, but the loop itself creates no path.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "z>z"])), {
      a: 0,
      b: 1 / 6,
      c: 0,
      z: 0,
    });
  });

  it("unreachable nodes do not poison sigma", () => {
    // `x` reaches nobody and nobody reaches it beyond `y`.
    assertCentrality(betweennessCentrality(graph(["a>b", "b>c", "c>a", "x>y"])), {
      a: 1 / 12,
      b: 1 / 12,
      c: 1 / 12,
      x: 0,
      y: 0,
    });
  });

  it("normalized: false returns the raw ordered-pair counts", () => {
    // For a DIRECTED graph networkx's unnormalized scale is N/(N*1) = 1, so
    // raw counts come straight from the accumulation.
    assertCentrality(
      betweennessCentrality(graph(["a>b", "b>c", "c>d"]), { normalized: false }),
      { a: 0, b: 2, c: 2, d: 0 },
    );
    assertCentrality(
      betweennessCentrality(graph(["s>l", "s>r", "l>t", "r>t"]), { normalized: false }),
      { s: 0, l: 0.5, r: 0.5, t: 0 },
    );
  });
});

/* --- The golden: the Python kragg's own call graph ----------------------- */

/**
 * PROVENANCE. `CRAG_NODES` and `CRAG_EDGES` are the exact
 * `networkx.DiGraph` that `kragg.gates.criticality.build_call_graph` produces
 * for the Python sibling's own `src/` tree, dumped as
 * `sorted(g.nodes)` / `sorted(g.edges)` and re-encoded as an index table so it
 * fits in a test file. The shared `kragg.` module prefix is stripped from
 * every name; nothing else is altered. 417 nodes, 564 edges.
 *
 * `CRAG_PUBLISHED` is a verbatim copy of that repo's committed
 * `.kragg/criticality.json` — the top 20 by (betweenness, fan-in) with
 * betweenness rounded to 4 decimals, exactly as `write_json` emits it. It was
 * confirmed byte-identical to a live `analyze()` run at the time this test was
 * written, so it is real published output and not a snapshot of this
 * implementation.
 *
 * WHAT THIS PROVES. If this implementation's conventions differed from
 * networkx's in any way that matters — endpoints included, the undirected
 * factor of 2, a different divisor, self-loops counted, isolated nodes
 * dropped from n — these 20 values would not survive. Several of them sit
 * within a factor of two of each other, so an error of even a few percent
 * would also reorder the table.
 */
const CRAG_NODES = `
brief._area brief._changed_files brief._critical_section brief._gate_section
brief._git_lines brief._grouped_sections brief._resolve_base brief._stats_line
brief.build_brief catalog._bandit_gate catalog._boundaries_gate catalog._command_gate
catalog._critical_coverage_gate catalog._critical_tests_gate catalog._forbidden_calls_gate
catalog._halstead_gate catalog._is_tool_module catalog._kragg_module catalog._native_gate
catalog._no_criticality_reason catalog._nullable_default_gate catalog._project_tool_gate
catalog._radon_cc_gate catalog._radon_mi_gate catalog._relative_to_root catalog._resolve
catalog._ruff_gate catalog._secret_default_gate catalog._secrets_gate
catalog._structure_gate catalog._test_quality_gate catalog._type_complexity_gate
catalog._typing_strictness_gate catalog._unconfigured catalog.build_check_gates
catalog.build_security_gates changes._filter_python_files changes._git changes._is_allowed
changes._is_git_repository changes._resolve_base changes.changed_python_files
changes.git_dirty changes.git_sha check.GateSpec check._skip_reason check._timed
check.run_gates cli._add_report_arguments cli.build_parser cli.main commands._check_targets
commands._doctor_environment commands._doctor_project_tools commands._flaky_rerun
commands._module commands._print_command commands._project_environment
commands._report_mutation commands._run_external commands._run_pipeline
commands._run_project_external commands._sync_new_project commands.cmd_audit
commands.cmd_brief commands.cmd_check commands.cmd_coverage commands.cmd_criticality
commands.cmd_doctor commands.cmd_fix commands.cmd_flaky commands.cmd_gen commands.cmd_hook
commands.cmd_init commands.cmd_map commands.cmd_mutation commands.cmd_new
commands.cmd_policy_show commands.cmd_security commands.cmd_spec commands.cmd_status
coverage.FunctionCoverage coverage._Partition coverage._format_lines
coverage._function_coverage coverage._function_entry coverage._gap_line coverage._int_tuple
coverage._normalized_files coverage._partition coverage._relative_key
coverage._unmeasured_line coverage.coverage_path coverage.critical_gaps coverage.read_report
coverage.render_gaps critical.CriticalFunction critical._as_int critical._critical_entries
critical._is_private critical._module_file_map critical._read_criticality critical._resolve
critical.critical_files critical.critical_functions environment.ProjectEnvironment
environment.ProjectEnvironment.command environment.ProjectEnvironment.describe
environment.ProjectEnvironment.found environment.ProjectEnvironment.module_command
environment.ProjectEnvironment.script_command environment._is_foreign_environment
environment.missing_interpreter_message environment.missing_module environment.probe_modules
environment.remediation environment.resolve_project_environment environment.venv_python
flaky.FlakyGate flaky.FlakyTest flaky.FlakyTest.ratio flaky._Tally flaky._record
flaky._run_once flaky._tally flaky.aggregate_reruns flaky.passive_flaky flaky.render_passive
flaky.render_reruns flaky.run_reruns gates.architecture._layer_index
gates.architecture._public_symbols gates.architecture._source_modules
gates.architecture.check_layers gates.architecture.check_structure
gates.critical_coverage._violation gates.critical_coverage.check_critical_coverage
gates.critical_tests._critical_entries gates.critical_tests._file_for_qualname
gates.critical_tests._is_private gates.critical_tests._module_file_map
gates.critical_tests._under_any gates.critical_tests.check_critical_tests
gates.critical_tests.critical_in_files gates.criticality.FunctionProfile
gates.criticality.FunctionProfile.risk_label gates.criticality._FunctionBody
gates.criticality._ProjectIndex gates.criticality._ProjectIndex.resolve_import
gates.criticality._add_call_edges gates.criticality._annotation_class
gates.criticality._build_index gates.criticality._collect_bodies
gates.criticality._constructor gates.criticality._format_section
gates.criticality._function_bodies gates.criticality._import_from_base
gates.criticality._index_definitions gates.criticality._local_types
gates.criticality._parse_modules gates.criticality._qualify
gates.criticality._record_constructed_type gates.criticality._record_from_imports
gates.criticality._record_plain_imports gates.criticality._record_type
gates.criticality._resolve_attribute gates.criticality._resolve_call
gates.criticality._resolve_name gates.criticality._single_name_target
gates.criticality.analyze gates.criticality.build_call_graph gates.criticality.format_report
gates.criticality.module_imports gates.criticality.module_name gates.criticality.print_table
gates.criticality.read_json gates.criticality.write_json gates.criticality.write_report
gates.forbidden_calls._Scanner gates.forbidden_calls._Scanner._annotation_path
gates.forbidden_calls._Scanner._check_call gates.forbidden_calls._Scanner._constructor_path
gates.forbidden_calls._Scanner._parameter_types
gates.forbidden_calls._Scanner._record_binding gates.forbidden_calls._Scanner._resolve
gates.forbidden_calls._Scanner._walk gates.forbidden_calls._Scanner.scan
gates.forbidden_calls._all_arguments gates.forbidden_calls._argument_defaults
gates.forbidden_calls._matching_rule gates.forbidden_calls._rebound_names
gates.forbidden_calls._target_names gates.forbidden_calls._without
gates.forbidden_calls.check_forbidden_calls gates.forbidden_calls.resolve_call
gates.halstead.HalsteadViolation gates.halstead.check_file gates.halstead.check_path
gates.halstead.format_violation gates.nullable_default._is_accessor
gates.nullable_default._is_constant gates.nullable_default._is_dangerous_get
gates.nullable_default._is_nonnull_literal gates.nullable_default._scan
gates.nullable_default.check_nullable_defaults gates.secret_default._call_default
gates.secret_default._env_read_default gates.secret_default._findings
gates.secret_default._is_empty_str gates.secret_default._is_none
gates.secret_default._is_secret_name gates.secret_default._is_str_literal
gates.secret_default._literal_binding gates.secret_default._parameter_defaults
gates.secret_default._scan gates.secret_default._target_name gates.secret_default._violation
gates.secret_default.check_secret_defaults gates.secrets.find_new_secrets
gates.secrets.load_baseline gates.secrets.scan_target gates.secrets.scan_violations
gates.sources.ParsedSource gates.sources.parsed_sources gates.suppress.suppressed
gates.test_quality._assertion_violations gates.test_quality._critical_reference_violations
gates.test_quality._has_assertion gates.test_quality._is_assert_call
gates.test_quality._public_critical_names gates.test_quality._test_functions
gates.test_quality._test_sources gates.test_quality.check_tests
gates.type_complexity.TypeViolation gates.type_complexity._check_function
gates.type_complexity.check_annotation gates.type_complexity.check_file
gates.type_complexity.check_path gates.type_complexity.compute_depth
gates.type_complexity.format_violation gates.type_complexity.suggest_fix
gates.typing_strictness._bare_ignore_violations gates.typing_strictness._config_violations
gates.typing_strictness._loosening gates.typing_strictness._meets_floor
gates.typing_strictness._mypy_table gates.typing_strictness._scan_bare_ignores
gates.typing_strictness.check_typing_strictness globs.matches_any hooks._block
hooks._critical_functions hooks._dispatch hooks._edit_targets hooks._parse_input
hooks._post_edit hooks._print_map_digest hooks._relative hooks._run_check
hooks._session_start hooks._stop hooks.run_claude_hook journal.JournalEntry
journal.JournalGate journal._failing_line journal._gates journal._pass_streak
journal._rotate journal._slowest_line journal._summary_line journal.append_run
journal.journal_path journal.read_runs journal.render_status_lines mapping._class_entry
mapping._criticality_flags mapping._doc_suffix mapping._function_entry
mapping._method_entries mapping._module_entries mapping._risk_suffix mapping.build_map
mapping.write_map models.CompletedCommand models.CompletedCommand.output
models.CompletedCommand.passed models.CompletedCommand.to_gate_result models.GateResult
models.Violation models.Violation.location mutation.MutationError mutation.MutationReport
mutation.Survivor mutation.Survivor.signature mutation._annotation_of
mutation._annotation_spans mutation._as_int mutation._cosmic_ray mutation._expand
mutation._first_change mutation._first_mutation mutation._is_survivor mutation._mutate_file
mutation._parse_dump_line mutation._short_operator mutation._start_position
mutation._survivor_from mutation._within mutation._within_any mutation.baseline_path
mutation.build_config mutation.cosmic_ray_available mutation.diff_summary
mutation.drop_annotation_mutants mutation.filter_baselined mutation.format_test_command
mutation.load_baseline mutation.parse_survivors mutation.render_survivors
mutation.run_mutation mutation.select_targets mutation.survivor_violation
mutation.write_baseline naming.normalize_package_name naming.shadow_conflict
naming.shadow_refusal parsers.parse_bandit_json parsers.parse_failed_test_ids
parsers.parse_mypy_output parsers.parse_pip_audit_json parsers.parse_pytest_output
parsers.parse_radon_cc parsers.parse_radon_mi parsers.parse_ruff_json policy.KraggPolicy
policy.KraggPolicy.as_dict policy._get_int policy._get_str policy._get_str_pairs
policy._get_str_tuple policy._load_kragg_table policy.load_policy report.CheckReport
report.CheckReport.duration_ms report.CheckReport.exit_code report.CheckReport.passed
report.GatePayload report.ProcessedGate report.ReportPayload report.SummaryPayload
report.ViolationPayload report._auto_fixable_count report._environment_fixes
report._gate_payload report._process_gate report._render_gate_text
report._render_violation_text report._summary_payload report._violation_payload
report.build_report report.cap_output report.dedupe_violations report.kragg_version
report.next_actions report.render_json report.render_text report.to_payload report.utc_now
runner.run_command scaffold._detect_package scaffold._ensure_pyproject_config
scaffold._guardrail_files scaffold._pyproject scaffold._readme scaffold._toml_list
scaffold._write_files scaffold.create_new_project scaffold.generate_module
scaffold.initialize_project spec.PropertyCoverage spec.SpecFile spec.SpecItem
spec._decorator_name spec._doc_line spec._file_items spec._humanize spec._is_property_test
spec._is_test_function spec._item_line spec._property_chunks spec._property_test_corpus
spec._simple_name spec.build_spec spec.property_coverage spec.render_property_coverage
spec.render_spec templates._api_entrypoint templates._api_test templates._cli_entrypoint
templates._cli_test templates._greeting_service templates._greeting_test
templates._mcp_entrypoint templates._mcp_entrypoint_official templates._mcp_test
templates._mcp_test_official templates._module_domain templates._module_service
templates._module_test templates._record_name templates._worker_entrypoint
templates._worker_test templates.kind_dependencies templates.kind_dev_extras
templates.kind_files templates.kind_run_instructions templates.kind_scripts
templates.module_files
`;

/** `caller,callee` index pairs into `CRAG_NODES`. */
const CRAG_EDGES = `
1,4 2,143 3,271 3,272 4,367 5,0 6,4 7,4 8,1 8,2 8,3 8,5 8,6 8,7 9,11 9,17 10,18 10,133
11,286 11,367 12,18 12,136 13,18 13,142 14,18 14,193 15,18 15,25 15,197 15,287 18,286 20,18
20,204 21,16 21,107 21,109 21,112 21,113 21,115 21,286 21,367 22,17 22,286 22,330 22,367
23,17 23,286 23,331 23,367 26,11 26,17 26,24 26,332 27,18 27,217 28,18 28,219 28,221 28,286
29,18 29,134 30,18 30,232 31,18 31,25 31,237 31,287 32,18 32,247 34,9 34,10 34,12 34,13
34,14 34,15 34,19 34,20 34,21 34,22 34,23 34,26 34,27 34,28 34,29 34,30 34,31 34,32 34,33
34,44 35,9 35,14 35,21 35,27 35,28 35,33 35,44 36,38 37,367 39,37 40,37 41,36 41,37 41,39
41,40 42,37 43,37 47,45 47,46 47,286 49,48 50,49 51,41 52,53 52,57 53,114 53,115 54,57
54,128 54,129 54,340 57,116 58,313 58,315 58,317 58,321 59,56 59,367 60,43 60,47 60,269
60,358 60,363 60,364 60,365 60,366 61,56 61,109 61,113 61,115 61,367 62,367 63,55 63,57
63,59 63,61 63,67 63,340 64,8 64,340 65,34 65,51 65,57 65,60 65,340 66,93 66,94 66,95 66,340
67,169 67,174 67,176 67,177 67,340 68,52 68,340 69,55 69,59 69,340 70,54 70,126 70,127
70,271 71,376 72,260 73,377 74,280 74,281 74,340 75,57 75,58 75,115 75,310 75,318 75,319
75,340 76,62 76,322 76,323 76,375 77,340 78,35 78,57 78,60 78,340 79,340 79,391 79,392
79,393 79,394 80,271 80,272 84,81 84,85 84,87 86,83 88,90 89,82 93,84 93,88 93,94 93,104
94,92 95,86 95,89 95,91 98,97 98,99 98,101 100,173 103,104 104,96 104,98 104,100 104,102
109,106 114,106 114,367 116,105 116,111 116,117 122,121 123,109 123,326 123,367 124,122
125,119 126,118 126,124 129,123 129,125 132,173 133,130 133,132 133,172 133,287 134,131
134,132 134,248 134,287 135,287 136,93 136,135 137,139 140,173 142,41 142,141 142,143
142,287 143,137 143,138 143,140 149,158 149,166 150,148 151,147 151,157 151,172 152,146
152,160 155,152 157,160 158,161 158,164 158,168 159,173 161,150 162,156 164,150 165,148
165,153 165,160 166,165 166,167 167,148 167,153 169,144 169,170 170,149 170,151 170,155
170,159 171,154 172,162 172,163 177,171 179,184 180,184 180,189 180,224 180,287 181,184
182,179 182,187 183,179 183,181 183,190 184,194 185,180 185,183 185,187 185,188 185,191
185,192 186,182 186,185 190,191 193,178 193,186 193,223 196,195 197,195 197,196 199,200
199,201 201,200 201,202 203,199 203,201 203,224 203,287 204,203 206,194 206,205 206,208
206,209 206,210 207,206 207,212 207,213 207,215 212,208 212,210 212,211 213,208 213,210
213,211 214,207 214,216 214,224 216,287 217,214 217,223 220,367 221,220 221,287 223,172
223,173 223,222 225,227 225,230 225,287 226,229 226,287 227,228 229,175 232,225 232,226
232,231 234,235 235,233 235,238 235,240 236,234 236,235 237,233 237,236 241,246 242,243
242,244 242,245 242,287 243,287 246,287 247,241 247,242 251,253 251,254 251,258 251,259
252,41 252,256 252,340 254,249 254,252 254,257 254,364 255,280 255,340 257,34 257,43 257,47
257,116 257,269 257,340 257,358 257,365 257,366 258,250 258,255 258,271 258,272 259,249
259,257 259,340 259,364 260,251 263,264 267,264 269,42 269,261 269,262 269,266 269,270
271,270 272,263 272,265 272,267 272,268 273,275 273,279 276,275 276,279 277,276 278,273
278,276 278,277 280,173 280,274 280,278 285,286 294,293 296,110 296,367 297,248 301,289
301,296 301,309 301,312 301,316 302,300 302,305 305,291 305,295 305,299 305,304 307,306
311,298 312,294 312,307 315,308 316,302 317,320 318,106 318,290 318,301 318,314 319,41
319,103 319,248 319,297 320,287 320,303 320,311 321,308 325,287 327,287 328,287 329,287
330,287 331,287 332,287 340,333 340,335 340,336 340,337 340,338 340,339 352,345 352,357
353,346 353,359 353,360 354,355 355,288 356,348 357,349 358,341 358,353 362,350 362,351
363,365 364,354 364,356 364,362 365,347 365,352 365,356 365,361 365,362 367,282 369,322
369,371 370,371 370,372 371,373 371,411 371,412 371,415 372,414 375,322 375,323 375,324
375,370 375,374 375,413 376,322 376,368 376,374 376,416 377,322 377,369 377,370 377,374
383,380 383,382 383,384 383,386 385,381 385,386 388,385 389,388 391,379 391,383 392,104
392,378 392,389 392,390 394,387 401,402 403,404 413,395 413,396 413,397 413,398 413,399
413,400 413,401 413,403 413,409 413,410 416,405 416,406 416,407 416,408
`;

/** `[name, fanIn, fanOut, betweenness(4dp)]`, verbatim from `.kragg/criticality.json`. */
const CRAG_PUBLISHED: readonly (readonly [string, number, number, number])[] = [
  ["catalog.build_check_gates", 2, 20, 0.0058],
  ["hooks._run_check", 2, 9, 0.005],
  ["hooks._dispatch", 1, 4, 0.0025],
  ["hooks._post_edit", 1, 4, 0.0017],
  ["hooks._stop", 1, 4, 0.0017],
  ["hooks.run_claude_hook", 1, 1, 0.0013],
  ["gates.forbidden_calls.check_forbidden_calls", 1, 3, 0.0011],
  ["catalog._forbidden_calls_gate", 2, 2, 0.001],
  ["coverage.critical_gaps", 2, 4, 0.001],
  ["gates.secret_default.check_secret_defaults", 1, 2, 0.001],
  ["gates.critical_coverage.check_critical_coverage", 1, 2, 0.0009],
  ["catalog._secret_default_gate", 2, 2, 0.0009],
  ["gates.forbidden_calls._Scanner.scan", 1, 2, 0.0009],
  ["gates.secret_default._scan", 1, 3, 0.0009],
  ["catalog._critical_coverage_gate", 1, 2, 0.0009],
  ["policy.load_policy", 17, 6, 0.0008],
  ["gates.secret_default._findings", 1, 4, 0.0008],
  ["critical.critical_functions", 3, 4, 0.0007],
  ["gates.forbidden_calls._Scanner._walk", 1, 6, 0.0007],
  ["gates.critical_tests.check_critical_tests", 1, 4, 0.0005],
];

function cragGraph(): DirectedGraph {
  const names = CRAG_NODES.trim().split(/\s+/);
  const built = createDirectedGraph();
  for (const name of names) {
    addNode(built, name);
  }
  for (const pair of CRAG_EDGES.trim().split(/\s+/)) {
    const [from, to] = pair.split(",");
    assert.ok(from !== undefined && to !== undefined, `bad edge ${pair}`);
    const source = names[Number(from)];
    const target = names[Number(to)];
    assert.ok(source !== undefined && target !== undefined, `bad index in ${pair}`);
    addEdge(built, source, target);
  }
  return built;
}

describe("betweennessCentrality — golden: the Python kragg's own call graph", () => {
  const built = cragGraph();
  const centrality = betweennessCentrality(built);

  it("reconstructs the graph networkx was run on", () => {
    assert.equal(nodeCount(built), 417);
    assert.equal(edgeCount(built), 564);
  });

  it("reproduces every published betweenness to the 4 decimals Python writes", () => {
    for (const [name, , , published] of CRAG_PUBLISHED) {
      const value = centrality.get(name);
      assert.ok(value !== undefined, `missing ${name}`);
      assert.equal(
        Number(value.toFixed(4)),
        published,
        `${name}: python published ${String(published)}, got ${String(value)}`,
      );
    }
  });

  it("reproduces the published fan-in and fan-out", () => {
    for (const [name, fanIn, fanOut] of CRAG_PUBLISHED) {
      assert.equal(inDegree(built, name), fanIn, `${name} fan-in`);
      assert.equal(outDegree(built, name), fanOut, `${name} fan-out`);
    }
  });

  it("reproduces the published ORDER, which full-precision ties would break", () => {
    // The Python side sorts ascending by (betweenness, fan_in) and reverses.
    // Reproducing the order is a stronger claim than reproducing 20 rounded
    // values: it depends on digits the JSON never shows.
    const ranked = [...centrality.entries()]
      .sort((a, b) => a[1] - b[1] || inDegree(built, a[0]) - inDegree(built, b[0]))
      .reverse()
      .slice(0, CRAG_PUBLISHED.length)
      .map(([name]) => name);
    assert.deepEqual(ranked, CRAG_PUBLISHED.map(([name]) => name));
  });

  it("agrees with networkx on the whole graph, not just the top 20", () => {
    // Aggregates computed by networkx 3.6.1 over all 417 nodes. The sum is the
    // sensitive one: a wrong divisor, a dropped isolated node or a mishandled
    // component moves it far outside this tolerance, which is loose only
    // enough to absorb float summation reordering.
    let total = 0;
    let maximum = 0;
    let nonZero = 0;
    for (const value of centrality.values()) {
      total += value;
      maximum = Math.max(maximum, value);
      if (value > 0) {
        nonZero += 1;
      }
    }
    assert.equal(centrality.size, 417);
    assert.equal(nonZero, 197);
    assert.ok(
      Math.abs(total - 0.052380676552363302) < 1e-12,
      `sum drifted: ${String(total)}`,
    );
    assert.ok(
      Math.abs(maximum - 0.0058213623725671924) < 1e-12,
      `max drifted: ${String(maximum)}`,
    );
  });
});
