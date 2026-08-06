/**
 * `kragg new` — scaffold a new guardrailed project.
 *
 * The handler parses its own flags and returns an exit code; it never calls
 * `process.exit`, so the whole surface is testable in-process.
 *
 * IT DOES NOT INSTALL ANYTHING. The exact install command is printed for the
 * human to run. That is not laziness: the generated `.npmrc` and
 * `pnpm-workspace.yaml` are what make an install safe, and a tool that
 * installs on your behalf has already made the decision those files exist to
 * put in front of you.
 */

import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import { asKind, asMcpSdk, KINDS, MCP_SDKS, type Kind, type McpSdk } from "../scaffold/kinds.ts";
import { createNewProject, ScaffoldError } from "../scaffold/project.ts";

/** Usage text, printed on `--help` and on every usage error. */
export const NEW_USAGE = `Usage: kragg new <directory> [options]

Options:
      --kind <${KINDS.join("|")}>   project skeleton (default: cli)
      --mcp-sdk <${MCP_SDKS.join("|")}>   MCP SDK for --kind mcp (default: fastmcp)
      --package <name>          npm package name, if not the directory name
      --allow-shadowing         proceed despite a shadowed import name
  -h, --help                    show this help and exit

Nothing is installed. The install command is printed when the files land.`;

/**
 * Create a new project and print the next steps.
 *
 * Returns `0` on success, `2` for any usage error or refused scaffold — a
 * refusal is the tool working, and it must be distinguishable from a crash.
 */
export function runNew(argv: readonly string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: NEW_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error: unknown) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${NEW_USAGE}\n`);
    return EXIT_OK;
  }
  const request = toRequest(parsed.values, parsed.positionals);
  return request.ok ? scaffold(request.request) : usageError(request.message);
}

/** The flags `kragg new` accepts, in `parseArgs` form. */
const NEW_OPTIONS = {
  kind: { type: "string", default: "cli" },
  "mcp-sdk": { type: "string", default: "fastmcp" },
  package: { type: "string" },
  "allow-shadowing": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** The flag values, as `parseArgs` fills them in from {@link NEW_OPTIONS}. */
interface NewValues {
  readonly kind?: string | undefined;
  readonly "mcp-sdk"?: string | undefined;
  readonly package?: string | undefined;
  readonly "allow-shadowing"?: boolean | undefined;
}

/** A validated request, or the usage error explaining why there is not one. */
type RequestResult =
  | { readonly ok: true; readonly request: ScaffoldRequest }
  | { readonly ok: false; readonly message: string };

/**
 * Validate the flags into a request.
 *
 * Every refusal comes back as a MESSAGE rather than being printed here, so the
 * one place that decides what a usage error looks like stays `usageError`.
 */
function toRequest(values: NewValues, positionals: readonly string[]): RequestResult {
  const target = positionals[0];
  if (target === undefined) {
    return { ok: false, message: "kragg new requires a target directory" };
  }
  if (positionals.length > 1) {
    return { ok: false, message: "kragg new takes exactly one target directory" };
  }
  const kind = asKind(values.kind ?? "cli");
  if (kind === null) {
    return { ok: false, message: `unknown --kind '${String(values.kind)}'` };
  }
  const mcpSdk = asMcpSdk(values["mcp-sdk"] ?? "fastmcp");
  if (mcpSdk === null) {
    return { ok: false, message: `unknown --mcp-sdk '${String(values["mcp-sdk"])}'` };
  }
  return {
    ok: true,
    request: {
      target,
      kind,
      mcpSdk,
      packageName: values.package,
      allowShadowing: values["allow-shadowing"] === true,
    },
  };
}

/** The decisions `runNew` extracted from argv, ready to act on. */
interface ScaffoldRequest {
  readonly target: string;
  readonly kind: Kind;
  readonly mcpSdk: McpSdk;
  readonly packageName: string | undefined;
  readonly allowShadowing: boolean;
}

/** Write the project, then print what happened and what to do next. */
function scaffold(request: ScaffoldRequest): number {
  const root = resolve(request.target);
  const projectName = basename(root);
  let result;
  try {
    result = createNewProject({
      root,
      projectName,
      kind: request.kind,
      packageName: request.packageName,
      mcpSdk: request.mcpSdk,
      allowShadowing: request.allowShadowing,
    });
  } catch (error: unknown) {
    if (error instanceof ScaffoldError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  for (const warning of result.warnings) {
    process.stderr.write(`${warning}\n`);
  }
  process.stdout.write(
    `${nextSteps(request.target, projectName, result.written.length)}\n`,
  );
  return EXIT_OK;
}

/**
 * The report printed after a successful scaffold.
 *
 * The install command is spelled out rather than described, because the next
 * thing that happens is somebody copying this line.
 */
export function nextSteps(target: string, projectName: string, count: number): string {
  return [
    `Created ${projectName}: ${String(count)} files in ${target}`,
    "",
    "Nothing was installed. Dependencies are pinned exactly and install",
    "scripts are disabled; review package.json, then run:",
    "",
    `  cd ${target}`,
    "  pnpm install",
    "  pnpm exec kragg check",
    "",
    "Read AGENTS.md before writing code — it is the contract the gates enforce.",
  ].join("\n");
}

/** Print a usage error with the usage text, and return exit code 2. */
function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${NEW_USAGE}\n`);
  return EXIT_USAGE;
}
