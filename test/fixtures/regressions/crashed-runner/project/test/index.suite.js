import { add } from "../src/index.ts";

if (add(1, 1) === 2) {
  process.abort();
}
