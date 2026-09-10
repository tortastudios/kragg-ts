/**
 * A suite that covers exactly ONE of the twenty-five critical rules.
 *
 * Every other rule is a critical function with no test bound to it. When the
 * criticality analysis was truncated to the twenty riskiest functions, the
 * rules ranked below the cut were invisible to `test-quality`; the count of
 * `critical-untested` findings is therefore a direct measurement of how many
 * functions enforcement can see.
 */

import { rule01 } from "../src/rules.ts";

export function checkRule01(): boolean {
  return rule01("value") === "1:value";
}
