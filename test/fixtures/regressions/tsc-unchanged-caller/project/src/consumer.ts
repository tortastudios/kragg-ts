/** The UNCHANGED caller. Its error is the one an incremental run used to drop. */

import { greet } from "./greeting.ts";

export function welcome(): string {
  return greet("world");
}
