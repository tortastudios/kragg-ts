/** The part of the tree the edit deliberately does NOT touch. */

import { totalStatements } from "./coverage/callers.ts";

export function report(lines: readonly number[]): string {
  return `statements: ${totalStatements(lines)}`;
}
