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
 * ── WHICH fastmcp ─────────────────────────────────────────────────────────
 * `@prefecthq/fastmcp-ts`, from PrefectHQ — the same organisation that
 * publishes the Python FastMCP, which is the whole point of the default. The
 * unscoped `fastmcp` package on npm is a DIFFERENT project by a different
 * author (punkpeye/fastmcp); it does not carry that relationship and must not
 * be scaffolded here. The two are not interchangeable and their APIs differ.
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
 * version, never to lower the cooldown. `@prefecthq/fastmcp-ts` has no version
 * old enough to satisfy it at all, so the mcp kind ships a named exemption
 * instead; see `releaseAgeExclude` in `supplyChain.ts` for the full reasoning.
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

/**
 * Runtime dependencies for a kind, as exact `name -> version` pins.
 *
 * EVERY PIN MUST CLEAR THE GENERATED COOLDOWN. The `pnpm-workspace.yaml` this
 * scaffold writes sets `minimumReleaseAge: 43200` with
 * `minimumReleaseAgeStrict: true`, so a pin younger than 30 days does not warn
 * — `pnpm install` FAILS, in a project the user has not yet touched. Pinning
 * the newest release is therefore usually wrong here. Both the `api` and
 * `official` pins were newest-release, and both broke exactly this way.
 *
 * TRANSITIVE DEPENDENCIES COUNT, so checking the direct pin is not enough:
 * `@prefecthq/fastmcp-ts` resolves fine on its own and still fails on its MCP
 * SDK v2 dependencies. The only reliable check is to run it —
 *
 *     pnpm install --lockfile-only     # scratch dir, same workspace config
 *
 * — where `ERR_PNPM_NO_MATURE_MATCHING_VERSION` names every offender.
 */
export function kindDependencies(kind: Kind, mcpSdk: McpSdk): Record<string, string> {
  if (kind === "api") {
    // Verified 2026-08-07: 4.12.28 (2026-07-06) + 2.0.8 (2026-07-02) resolve
    // clean. The previous 4.13.0 / 2.1.0 pins were 3-4 days old and failed.
    return { hono: "4.12.28", "@hono/node-server": "2.0.8" };
  }
  if (kind === "mcp") {
    // Both SDKs describe tool inputs with a Standard Schema; zod is the one
    // every example in both ecosystems uses, so it is a direct dependency
    // rather than something the first tool definition discovers is missing.
    if (mcpSdk === "official") {
      // Verified 2026-08-07: 1.29.0 (2026-03-30) resolves clean across all 92
      // packages. The previous 1.30.0 pin was 11 days old and failed.
      return { "@modelcontextprotocol/sdk": "1.29.0", zod: "4.4.3" };
    }
    // The one kind pinning older cannot fix: NO published version of
    // `@prefecthq/fastmcp-ts` is 30 days old yet. It ships with a scoped,
    // dated `minimumReleaseAgeExclude` instead — see `supplyChain.ts`.
    return { "@prefecthq/fastmcp-ts": "1.3.0", zod: "4.4.3" };
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
