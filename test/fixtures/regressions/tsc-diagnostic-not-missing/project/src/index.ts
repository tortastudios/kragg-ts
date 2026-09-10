/**
 * The module the case rewrites to import a package that is not installed.
 *
 * Committed COMPILING, like every other fixture here: this repository's own
 * `tsconfig.json` includes the whole of `test/`, so a committed TS2307 would
 * be a type error in kragg's own typecheck rather than in the fixture's. The
 * case introduces the bad import at run time, exactly as
 * `tsc-unchanged-caller` introduces its extra parameter.
 */

import { formatDate } from "./dates.ts";

export function stamp(when: Date): string {
  return formatDate(when);
}
