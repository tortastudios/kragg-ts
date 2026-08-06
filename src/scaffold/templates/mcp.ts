/**
 * The `mcp` kind: an MCP server, on fastmcp by default.
 *
 * The default is a DELIBERATE choice carried over from the Python sibling, not
 * an alphabetical accident: fastmcp is the smaller surface to learn and the
 * one most agent-authored servers are written against. `--mcp-sdk official`
 * selects `@modelcontextprotocol/sdk` for projects that need the reference
 * implementation.
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
 * Entrypoint: MCP server (fastmcp).
 *
 * Exports the server rather than starting it, so the transport choice lives in
 * one place (\`bin.ts\`) and tests can import this module without a stdio
 * session attaching itself to the test runner.
 */

import { FastMCP } from "fastmcp";
import { z } from "zod";

import { buildGreeting } from "../services/greeting.ts";

/** The MCP server. Tools delegate to services; no logic lives here. */
export const server = new FastMCP({ name: "${projectName}", version: "0.1.0" });

server.addTool({
  name: "greet",
  description: "Greet a user by name.",
  parameters: z.object({ name: z.string() }),
  execute: (args) => Promise.resolve(buildGreeting(args.name)),
});
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
/** Executable shim: attach the server to a stdio transport. */

import { server } from "./server.ts";

await server.start({ transportType: "stdio" });
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
