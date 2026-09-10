/**
 * A project whose suite passes and whose coverage sits BETWEEN two floors.
 *
 * `kragg.json` sets `coverage_fail_under` to 50, which the suite below clears;
 * its `test_command` asks `node --test` for the runner's own
 * `--test-coverage-lines=90`, which the suite below does not. So the only
 * failing signal in a `kragg check` here is one the RUNNER computed — exactly
 * the signal TOR-1419 found kragg swallowing.
 */

export function classify(n: number): string {
  if (n < 0) {
    return "negative";
  }
  if (n === 0) {
    return "zero";
  }
  if (n % 2 === 0) {
    return "even";
  }
  return "odd";
}

export function label(n: number): string {
  return `${n} is ${classify(n)}`;
}
