/**
 * Kind dispatch for generated source files.
 *
 * The Python sibling keeps every template in one module; here they are split
 * by kind from the start, because a TypeScript template carries its own
 * framework skeleton, its own test, and its own executable shim — three files
 * per kind rather than Python's two — and a single module would blow the
 * project's own 500-line file budget before the third kind was written.
 */

import type { Kind, McpSdk } from "./kinds.ts";
import { apiFiles } from "./templates/api.ts";
import { cliFiles } from "./templates/cli.ts";
import { commonFiles } from "./templates/common.ts";
import { mcpFiles } from "./templates/mcp.ts";

export { moduleFiles, recordName } from "./templates/common.ts";

/**
 * Every source and test file for a kind, keyed by project-relative path.
 *
 * The shared layered slice comes first so a kind template can never silently
 * drop it: the layout is the contract the `boundaries` gate enforces, and it
 * is identical across kinds by design.
 */
export function kindFiles(
  kind: Kind,
  projectName: string,
  mcpSdk: McpSdk,
): Record<string, string> {
  const files = commonFiles();
  if (kind === "api") {
    return { ...files, ...apiFiles() };
  }
  if (kind === "mcp") {
    return { ...files, ...mcpFiles(projectName, mcpSdk) };
  }
  return { ...files, ...cliFiles(projectName) };
}
