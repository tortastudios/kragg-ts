/** A test-tree module, so `test-quality` runs and asks for the criticality data. */

import { report } from "../src/index.ts";

export function checkReport(): boolean {
  return report([1, 2, 3]) === "statements: 6";
}
