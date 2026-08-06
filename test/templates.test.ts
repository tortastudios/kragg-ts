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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

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
    assert.match(fast, /from "fastmcp"/);
    const official = kindFiles("mcp", "demo", "official")["src/entrypoints/server.ts"] ?? "";
    assert.match(official, /@modelcontextprotocol\/sdk/);
    assert.equal(/from "fastmcp"/.test(official), false);
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
});
