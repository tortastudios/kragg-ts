/**
 * The `mcp` kind: an MCP server, on fastmcp by default.
 *
 * The default is a DELIBERATE choice carried over from the Python sibling, not
 * an alphabetical accident: fastmcp is the smaller surface to learn and the
 * one most agent-authored servers are written against. `--mcp-sdk official`
 * selects `@modelcontextprotocol/sdk` for projects that need the reference
 * implementation.
 *
 * "fastmcp" here means `@prefecthq/fastmcp-ts` — PrefectHQ's official FastMCP
 * TypeScript library, the counterpart to the Python FastMCP. It is NOT the
 * unscoped `fastmcp` package on npm, which is an unrelated project with a
 * different API (`new FastMCP().addTool({ parameters, execute })` and
 * `server.start({ transportType })`, none of which exist here).
 *
 * ── THE API BELOW WAS READ, NOT REMEMBERED ────────────────────────────────
 * Every symbol in the fastmcp template comes from `dist/server.d.ts` in the
 * published 1.3.0 tarball, and matches that file's declarations:
 *
 *   - the package has SUBPATH EXPORTS ONLY (`./server`, `./client`). There is
 *     no root export, so `from "@prefecthq/fastmcp-ts"` does not resolve at
 *     all — it is a hard `ERR_PACKAGE_PATH_NOT_EXPORTED`, not a type error.
 *   - `constructor(options: FastMCPOptions)` — `{ name: string; version?: string }`.
 *   - `tool<S extends StandardSchemaV1>(config: Omit<ToolConfig, "input"> & { input: S },
 *      handler: (args: StandardSchemaV1.InferOutput<S>) => unknown): void`
 *     — config first, handler second; the input key is `input`, not
 *     `parameters`, and it takes any Standard Schema validator.
 *   - `run(options?: RunOptions): Promise<void>` where `RunOptions.transport`
 *     is `"stdio" | "http"` — not `start({ transportType })`.
 *
 * Both variants ship ONE tool and nothing else. Tool input is described with a
 * zod schema, because both SDKs validate arguments against a runtime schema at
 * the boundary — which is the same rule `AGENTS.md` states for every other
 * external input, enforced here by the framework rather than by review.
 *
 * The tool body delegates straight to a service. An MCP tool is an entrypoint
 * like any other; logic in the tool handler is logic that cannot be tested
 * without an MCP client.
 */

import type { McpSdk } from "../kinds.ts";

/** Source and test files for the `mcp` kind. */
export function mcpFiles(projectName: string, sdk: McpSdk): Record<string, string> {
  if (sdk === "official") {
    return {
      "src/entrypoints/server.ts": officialServer(projectName),
      "src/entrypoints/bin.ts": OFFICIAL_BIN,
      "test/server.test.ts": SERVER_TEST,
    };
  }
  return {
    "src/entrypoints/server.ts": fastmcpServer(projectName),
    "src/entrypoints/bin.ts": FASTMCP_BIN,
    "test/server.test.ts": SERVER_TEST,
  };
}

function fastmcpServer(projectName: string): string {
  return `/**
 * Entrypoint: MCP server (@prefecthq/fastmcp-ts).
 *
 * Exports the server rather than starting it, so the transport choice lives in
 * one place (\`bin.ts\`) and tests can import this module without a stdio
 * session attaching itself to the test runner.
 *
 * The import is \`@prefecthq/fastmcp-ts/server\`, with the subpath. This
 * package publishes \`./server\` and \`./client\` and NOTHING at the root, so
 * dropping the subpath fails at runtime with ERR_PACKAGE_PATH_NOT_EXPORTED.
 */

import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";

import { buildGreeting } from "../services/greeting.ts";

/** The MCP server. Tools delegate to services; no logic lives here. */
export const server = new FastMCP({ name: "${projectName}", version: "0.1.0" });

server.tool(
  {
    name: "greet",
    description: "Greet a user by name.",
    input: z.object({ name: z.string() }),
  },
  ({ name }) => buildGreeting(name),
);
`;
}

function officialServer(projectName: string): string {
  return `/**
 * Entrypoint: MCP server (@modelcontextprotocol/sdk).
 *
 * Exports the server rather than starting it, so the transport choice lives in
 * one place (\`bin.ts\`) and tests can import this module without a stdio
 * session attaching itself to the test runner.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildGreeting } from "../services/greeting.ts";

/** The MCP server. Tools delegate to services; no logic lives here. */
export const server = new McpServer({ name: "${projectName}", version: "0.1.0" });

server.registerTool(
  "greet",
  {
    description: "Greet a user by name.",
    inputSchema: { name: z.string() },
  },
  ({ name }) => ({ content: [{ type: "text", text: buildGreeting(name) }] }),
);
`;
}

const FASTMCP_BIN = `#!/usr/bin/env node
/**
 * Executable shim: attach the server to a stdio transport.
 *
 * \`transport\` is stated rather than left to the default so that switching to
 * HTTP is an edit to this line and not a discovery — \`run({ transport: "http",
 * port: 3000 })\` is the other branch.
 */

import { server } from "./server.ts";

await server.run({ transport: "stdio" });
`;

const OFFICIAL_BIN = `#!/usr/bin/env node
/** Executable shim: attach the server to a stdio transport. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { server } from "./server.ts";

await server.connect(new StdioServerTransport());
`;

/**
 * The generated test, shared by both SDKs.
 *
 * Deliberately small: it asserts the server module loads and that the behavior
 * the tool exposes is correct, testing the latter through the SERVICE the tool
 * delegates to. Driving a real MCP client from a unit test is possible in both
 * SDKs, but the two APIs differ and neither is stable enough to bake into a
 * scaffold that must run on day one.
 */
const SERVER_TEST = `import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { server } from "../src/entrypoints/server.ts";
import { buildGreeting } from "../src/services/greeting.ts";

describe("server", () => {
  it("constructs without throwing", () => {
    assert.ok(server);
  });

  it("greets through the service the greet tool delegates to", () => {
    assert.equal(buildGreeting("Ada"), "Hello, Ada!");
  });
});
`;
