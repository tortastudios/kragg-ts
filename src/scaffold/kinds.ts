/**
 * The project kinds `kragg new` can scaffold, and the pinned dependency set
 * each one needs.
 *
 * Ported from the `KINDS` / `MCP_SDKS` tables in `kragg/templates.py`, with
 * one deliberate omission: Python's `worker` kind has no TypeScript analogue
 * worth scaffolding (a `while (true)` loop is not a framework decision), so
 * this side ships exactly three kinds. Everything else is preserved, including
 * the choice of fastmcp as the DEFAULT MCP SDK — that is a business decision
 * on the Python side, not an accident, and `--mcp-sdk official` is the opt-out.
 *
 * ── WHY EXACT VERSIONS ────────────────────────────────────────────────────
 * Every version below is written without a range operator. A `^` range means
 * the code an agent generated against one API installs against a different one
 * tomorrow, and it means a compromised patch release enters the tree with no
 * review. This mirrors `save-exact=true` in the generated `.npmrc` and the
 * repository's own dependency policy: pin, then upgrade deliberately.
 *
 * Versions were confirmed against the npm registry at scaffold-authoring time.
 * The generated `pnpm-workspace.yaml` sets `minimumReleaseAge: 43200`, so a
 * version published within the last 30 days will be REFUSED at install time —
 * that is the cooldown working as designed, and the fix is to pin an older
 * version, never to lower the cooldown.
 */

/** A scaffoldable project kind. */
export type Kind = "cli" | "api" | "mcp";

/** Which MCP SDK an `mcp` project is built on. */
export type McpSdk = "fastmcp" | "official";

/** Every kind `kragg new --kind` accepts. */
export const KINDS: readonly Kind[] = ["cli", "api", "mcp"];

/** Every value `kragg new --mcp-sdk` accepts. fastmcp is the default. */
export const MCP_SDKS: readonly McpSdk[] = ["fastmcp", "official"];

/** Pinned versions shared by every generated project. */
export const BASE_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@types/node": "24.12.4",
  typescript: "6.0.3",
};

/** Narrow an arbitrary string to a `Kind`, or return `null`. */
export function asKind(value: string): Kind | null {
  return KINDS.find((kind) => kind === value) ?? null;
}

/** Narrow an arbitrary string to an `McpSdk`, or return `null`. */
export function asMcpSdk(value: string): McpSdk | null {
  return MCP_SDKS.find((sdk) => sdk === value) ?? null;
}

/** Runtime dependencies for a kind, as exact `name -> version` pins. */
export function kindDependencies(kind: Kind, mcpSdk: McpSdk): Record<string, string> {
  if (kind === "api") {
    return { hono: "4.13.0", "@hono/node-server": "2.1.0" };
  }
  if (kind === "mcp") {
    // Both SDKs describe tool inputs with a Standard Schema; zod is the one
    // every example in both ecosystems uses, so it is a direct dependency
    // rather than something the first tool definition discovers is missing.
    if (mcpSdk === "official") {
      return { "@modelcontextprotocol/sdk": "1.30.0", zod: "4.4.3" };
    }
    return { fastmcp: "4.12.6", zod: "4.4.3" };
  }
  return {};
}

/** The `bin` entry for a kind, or `null` when the kind is not a command. */
export function kindBin(kind: Kind): string | null {
  if (kind === "api") {
    return null;
  }
  return "./dist/entrypoints/bin.js";
}

/** The `start` npm script for a kind, or `null` when it has none. */
export function kindStartScript(kind: Kind): string | null {
  if (kind === "api") {
    return "node src/entrypoints/bin.ts";
  }
  if (kind === "mcp") {
    return "node src/entrypoints/bin.ts";
  }
  return null;
}

/**
 * The README "Run" section for a kind.
 *
 * Sources run directly under Node's type stripping, so the documented command
 * needs no build step — the build exists for publishing, not for running.
 */
export function kindRunInstructions(kind: Kind, projectName: string): string {
  if (kind === "api") {
    return (
      "```bash\n" +
      "pnpm start\n" +
      "```\n\n" +
      "Binds `127.0.0.1:8000` by default. Configure it with the `HOST` and\n" +
      "`PORT` environment variables:\n\n" +
      "```bash\n" +
      "PORT=8931 pnpm start\n" +
      "```\n"
    );
  }
  if (kind === "mcp") {
    return (
      "```bash\n" +
      "pnpm start\n" +
      "```\n\n" +
      "The server speaks MCP over stdio, which is what an MCP client launches\n" +
      "it as. Register it with your client by pointing the command at\n" +
      "`node src/entrypoints/bin.ts` in this directory.\n"
    );
  }
  return "```bash\n" + `node src/entrypoints/bin.ts world   # or: pnpm exec ${projectName} world\n` + "```\n";
}
