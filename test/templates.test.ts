/**
 * Tests for the generated content itself, and for the three command handlers.
 *
 * The assertions worth having here are the ones that catch a template drifting
 * away from a decision that was made deliberately: an exact version pin
 * growing a `^`, the fastmcp default flipping, `AGENTS.md` losing a rule that
 * a gate enforces. Those are all silent failures — the scaffold still works,
 * it just stops meaning what it said.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { runGen } from "../src/commands/gen.ts";
import { runInit } from "../src/commands/init.ts";
import { runNew } from "../src/commands/new.ts";
import { AGENTS_MD, CLAUDE_MD } from "../src/scaffold/agents.ts";
import { guardrailFiles, packageJson } from "../src/scaffold/guardrails.ts";
import { KINDS, kindDependencies, MCP_SDKS } from "../src/scaffold/kinds.ts";
import { kindFiles, moduleFiles, recordName } from "../src/scaffold/templates.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-templates-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * Assert that every GitHub Action a workflow uses is pinned to a commit.
 *
 * A tag — `@v4`, `@v4.4.0`, any of them — is a mutable pointer the action's
 * maintainer can repoint at any commit. It is therefore a standing
 * authorization to run whatever that account publishes next, with the
 * repository checked out and the job's token in scope. Only a commit SHA is
 * immutable. Asserted rather than left to review because CI runs on every
 * push and nobody re-reads a workflow that is passing.
 */
function assertActionsPinned(workflow: string, what: string): void {
  const lines = workflow.split("\n").filter((line) => /^\s*(?:-\s*)?uses:/.test(line));
  assert.ok(lines.length > 0, `${what} declares no actions at all`);
  for (const line of lines) {
    const reference = /uses:\s*(\S+)/.exec(line)?.[1] ?? "";
    assert.match(
      reference,
      /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
      `${what}: ${reference} is not pinned to a full 40-character commit SHA`,
    );
    // A bare SHA is unreadable, so the version it stands for travels with it.
    // Without that nobody can tell what they are looking at or updating from.
    assert.match(line, /#\s*v\d+\.\d+\.\d+\s*$/, `${what}: no version comment on ${reference}`);
  }
}

/** Captured stdio and exit code from one command invocation. */
interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * Run a handler with stdout and stderr captured.
 *
 * The handlers write directly to the process streams, which is right for a
 * CLI and inconvenient for a test; capturing here is cheaper than threading a
 * writer through every handler for the sake of assertions.
 */
function capture(handler: () => number): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const sink = (lines: string[]): typeof process.stdout.write =>
    ((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = sink(out);
  process.stderr.write = sink(err);
  try {
    return { code: handler(), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("kind templates", () => {
  it("gives every kind the shared layered slice", () => {
    for (const kind of KINDS) {
      const files = kindFiles(kind, "demo", "fastmcp");
      assert.equal("src/domain/messages.ts" in files, true);
      assert.equal("src/services/greeting.ts" in files, true);
      assert.equal("test/greeting.test.ts" in files, true);
      assert.equal("src/entrypoints/bin.ts" in files, true);
    }
  });

  it("uses node:util parseArgs for the cli kind, not a dependency", () => {
    const cli = kindFiles("cli", "demo", "fastmcp")["src/entrypoints/cli.ts"];
    assert.equal(cli !== undefined, true);
    assert.match(cli ?? "", /from "node:util"/);
    assert.deepEqual(kindDependencies("cli", "fastmcp"), {});
  });

  it("defaults the mcp kind to fastmcp and switches on --mcp-sdk official", () => {
    assert.equal(MCP_SDKS[0], "fastmcp");
    const fast = kindFiles("mcp", "demo", "fastmcp")["src/entrypoints/server.ts"] ?? "";
    assert.match(fast, /from "@prefecthq\/fastmcp-ts\/server"/);
    const official = kindFiles("mcp", "demo", "official")["src/entrypoints/server.ts"] ?? "";
    assert.match(official, /@modelcontextprotocol\/sdk/);
    assert.equal(/@prefecthq\/fastmcp-ts/.test(official), false);
  });

  /**
   * The unscoped `fastmcp` on npm is punkpeye/fastmcp — a different project by
   * a different author from the Python FastMCP whose relationship is the whole
   * reason this SDK is the default. Scaffolding it was a real bug, and it is
   * the kind that reads as correct forever: the code compiles, the name looks
   * right, and the generated server is written against an API that is not
   * there. Asserted on the manifest AND on every import specifier.
   */
  it("scaffolds @prefecthq/fastmcp-ts, never the unrelated unscoped `fastmcp`", () => {
    const dependencies = kindDependencies("mcp", "fastmcp");
    assert.equal("@prefecthq/fastmcp-ts" in dependencies, true);
    assert.equal("fastmcp" in dependencies, false);
    const manifest = packageJson({
      projectName: "demo",
      packageName: "demo",
      kind: "mcp",
      mcpSdk: "fastmcp",
    });
    const declared = manifest["dependencies"] as Record<string, string>;
    assert.equal(declared["@prefecthq/fastmcp-ts"], "1.3.0");
    assert.equal("fastmcp" in declared, false);
    for (const source of Object.values(kindFiles("mcp", "demo", "fastmcp"))) {
      assert.equal(/from "fastmcp"/.test(source), false, "imports the wrong package");
    }
  });

  /**
   * `@prefecthq/fastmcp-ts` publishes `./server` and `./client` and nothing at
   * the root, so a bare-specifier import does not resolve at all. A type-level
   * check cannot catch it here (the package is not installed in this repo), so
   * the shape of every specifier is asserted directly.
   */
  it("imports the fastmcp package only through a real subpath export", () => {
    const specifiers: string[] = [];
    for (const source of Object.values(kindFiles("mcp", "demo", "fastmcp"))) {
      for (const match of source.matchAll(/from "(@prefecthq\/fastmcp-ts[^"]*)"/g)) {
        specifiers.push(match[1] ?? "");
      }
    }
    assert.ok(specifiers.length > 0, "the fastmcp template imports the package at all");
    for (const specifier of specifiers) {
      assert.match(
        specifier,
        /^@prefecthq\/fastmcp-ts\/(?:server|client)$/,
        `${specifier} is not one of the package's two subpath exports`,
      );
    }
  });

  /** The API in the template must be the one `dist/server.d.ts` declares. */
  it("uses the fastmcp-ts server API, not the unscoped package's", () => {
    const files = kindFiles("mcp", "demo", "fastmcp");
    const server = files["src/entrypoints/server.ts"] ?? "";
    const bin = files["src/entrypoints/bin.ts"] ?? "";
    assert.match(server, /server\.tool\(/);
    assert.match(server, /input: z\.object\(/);
    assert.match(bin, /server\.run\(\{ transport: "stdio" \}\)/);
    // The unscoped package's spellings. None of these exist on FastMCP here.
    for (const wrong of ["addTool(", "parameters:", "execute:", "transportType"]) {
      assert.equal(`${server}${bin}`.includes(wrong), false, `uses ${wrong}`);
    }
  });

  it("names the mcp server after the project", () => {
    const server = kindFiles("mcp", "demo-app", "fastmcp")["src/entrypoints/server.ts"] ?? "";
    assert.match(server, /name: "demo-app"/);
  });

  it("gives the api kind a health route", () => {
    const api = kindFiles("api", "demo", "fastmcp")["src/entrypoints/api.ts"] ?? "";
    assert.match(api, /from "hono"/);
    assert.match(api, /"\/health"/);
  });

  it("imports across layers with a literal .ts extension", () => {
    const service = kindFiles("cli", "demo", "fastmcp")["src/services/greeting.ts"] ?? "";
    assert.match(service, /from "\.\.\/domain\/messages\.ts"/);
  });
});

describe("dependency pins", () => {
  it("pins every generated dependency exactly", () => {
    for (const kind of KINDS) {
      for (const sdk of MCP_SDKS) {
        const manifest = packageJson({
          projectName: "demo",
          packageName: "demo",
          kind,
          mcpSdk: sdk,
        });
        for (const group of ["dependencies", "devDependencies"]) {
          const entries = manifest[group];
          assert.equal(typeof entries === "object" && entries !== null, true);
          for (const version of Object.values(entries as Record<string, string>)) {
            assert.match(version, /^\d+\.\d+\.\d+/, `${group} pin '${version}'`);
          }
        }
      }
    }
  });

  it("gives the mcp kind a runtime schema library, as both SDKs require", () => {
    assert.equal("zod" in kindDependencies("mcp", "fastmcp"), true);
    assert.equal("zod" in kindDependencies("mcp", "official"), true);
  });
});

describe("guardrail files", () => {
  const files = guardrailFiles({
    projectName: "demo",
    packageName: "demo",
    kind: "cli",
    mcpSdk: "fastmcp",
  });

  it("meets the typing floor in tsconfig.json", () => {
    const tsconfig = files["tsconfig.json"] ?? "";
    for (const flag of [
      '"strict": true',
      '"noUncheckedIndexedAccess": true',
      '"exactOptionalPropertyTypes": true',
      '"verbatimModuleSyntax": true',
      '"isolatedModules": true',
      '"skipLibCheck": false',
    ]) {
      assert.equal(tsconfig.includes(flag), true, `tsconfig missing ${flag}`);
    }
  });

  it("registers the kragg hook for Claude Code", () => {
    assert.match(files[".claude/settings.json"] ?? "", /kragg hook claude/);
  });

  it("points Gemini at the same contract file", () => {
    assert.match(files[".gemini/settings.json"] ?? "", /AGENTS\.md/);
  });

  it("runs the same install rules in CI as locally", () => {
    assert.match(files[".github/workflows/quality.yml"] ?? "", /pnpm install --frozen-lockfile/);
    assert.match(files[".github/workflows/quality.yml"] ?? "", /kragg check/);
  });

  it("pins every scaffolded CI action to a commit SHA, never a tag", () => {
    // A tag is a mutable pointer the action's maintainer can repoint at any
    // commit, so `@v4` authorises whatever they publish next to run with the
    // project checked out and CI's token in scope. Every project kragg
    // creates would ship that hole, on every push, which is why this is
    // asserted rather than left to review.
    const workflow = files[".github/workflows/quality.yml"] ?? "";
    assertActionsPinned(workflow, "the scaffolded quality.yml");
  });

  it("emits valid JSON for every JSON guardrail file", () => {
    for (const relative of ["package.json", "kragg.json", ".claude/settings.json", ".gemini/settings.json"]) {
      const contents = files[relative] ?? "";
      assert.doesNotThrow(() => JSON.parse(contents), `${relative} is not valid JSON`);
    }
  });
});

describe("AGENTS.md", () => {
  it("states the rules the gates actually enforce", () => {
    for (const rule of [
      "?? ",
      "noUncheckedIndexedAccess",
      "JSON.parse",
      "kragg: ignore",
      "forbidden_calls",
      "secret-default",
      "src/entrypoints/",
      "typing-strictness",
    ]) {
      assert.equal(AGENTS_MD.includes(rule), true, `AGENTS.md is missing: ${rule}`);
    }
  });

  it("documents all four exit codes", () => {
    for (const code of ["`0`", "`1`", "`2`", "`3`"]) {
      assert.equal(AGENTS_MD.includes(code), true, `AGENTS.md is missing exit code ${code}`);
    }
  });

  it("carries no Python left over from the port", () => {
    for (const stale of ["uv run", "pyproject", "mypy", "pytest", "Pydantic", "dataclass"]) {
      assert.equal(AGENTS_MD.includes(stale), false, `AGENTS.md still mentions ${stale}`);
    }
  });

  it("keeps CLAUDE.md a pointer, so there is one contract", () => {
    assert.match(CLAUDE_MD, /AGENTS\.md/);
    assert.equal(CLAUDE_MD.length < 200, true);
  });
});

describe("module templates", () => {
  it("derives a record name from a hyphenated module", () => {
    assert.equal(recordName("user-account"), "UserAccountRecord");
    assert.equal(recordName("billing"), "BillingRecord");
  });

  it("puts each slot in its layer", () => {
    const files = moduleFiles("billing");
    assert.deepEqual(Object.keys(files).sort(), [
      "src/domain/billing.ts",
      "src/services/billing.ts",
      "test/billing.test.ts",
    ]);
  });

  it("imports the domain type as a type-only import", () => {
    assert.match(moduleFiles("billing")["src/services/billing.ts"] ?? "", /^import type /m);
  });
});

describe("command handlers", () => {
  it("kragg new scaffolds and prints the install command without running it", () => {
    const target = join(temporaryRoot(), "demo-app");
    const result = capture(() => runNew([target, "--kind", "api"]));
    assert.equal(result.code, 0);
    assert.match(result.out, /pnpm install/);
    assert.match(result.out, /Nothing was installed/);
  });

  it("kragg new rejects an unknown kind with the usage code", () => {
    const target = join(temporaryRoot(), "demo-app");
    const result = capture(() => runNew([target, "--kind", "lambda"]));
    assert.equal(result.code, 2);
    assert.match(result.err, /unknown --kind/);
  });

  it("kragg new requires a target directory", () => {
    assert.equal(capture(() => runNew([])).code, 2);
  });

  it("kragg new --help exits 0", () => {
    assert.equal(capture(() => runNew(["--help"])).code, 0);
  });

  it("kragg gen module generates into a scaffolded project", () => {
    const target = join(temporaryRoot(), "demo-app");
    capture(() => runNew([target]));
    const result = capture(() => runGen(["module", "billing", "--root", target]));
    assert.equal(result.code, 0);
    assert.match(result.out, /src\/domain\/billing\.ts/);
  });

  it("kragg gen rejects an unknown subcommand", () => {
    const result = capture(() => runGen(["service", "billing"]));
    assert.equal(result.code, 2);
    assert.match(result.err, /unknown gen subcommand/);
  });

  it("kragg init reports the second run as already initialized", () => {
    const root = temporaryRoot();
    assert.equal(capture(() => runInit([root])).code, 0);
    const second = capture(() => runInit([root]));
    assert.equal(second.code, 0);
    assert.match(second.out, /Already initialized/);
  });

  it("kragg init rejects extra positionals", () => {
    assert.equal(capture(() => runInit(["a", "b"])).code, 2);
  });

  it("kragg init rejects a flag it does not accept", () => {
    assert.equal(capture(() => runInit(["--force"])).code, 2);
  });

  it("kragg init --dry-run prints the plan and writes nothing", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), `{ "name": "existing", "kragg": {} }\n`);
    const before = readdirSync(root);
    const result = capture(() => runInit([root, "--dry-run"]));
    assert.equal(result.code, 0);
    assert.match(result.out, /Dry run/);
    assert.match(result.out, /would create .*AGENTS\.md/);
    assert.match(result.out, /would add to .*package\.json: /);
    assert.match(result.out, /preserved .*kragg\.json: not created/);
    assert.match(result.out, /Re-run without --dry-run to apply\./);
    assert.deepEqual(readdirSync(root), before, "a dry run must not touch the project");
  });

  it("kragg init --dry-run does not create the directory it was asked about", () => {
    const root = join(temporaryRoot(), "not-yet");
    assert.equal(capture(() => runInit([root, "--dry-run"])).code, 0);
    assert.equal(existsSync(root), false);
  });
});

/**
 * The same rule, applied to kragg's own CI.
 *
 * A scaffold that pins actions while the tool's own workflow does not is a
 * tool that does not believe its own advice — and this repository is where a
 * compromised action would find the credentials that publish kragg.
 */
describe("kragg's own workflows", () => {
  it("pins every action to a commit SHA, never a tag", () => {
    const directory = fileURLToPath(new URL("../.github/workflows", import.meta.url));
    const workflows = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
    assert.ok(workflows.length > 0, "no workflows found to check");
    for (const name of workflows) {
      assertActionsPinned(readFileSync(join(directory, name), "utf8"), name);
    }
  });
});
