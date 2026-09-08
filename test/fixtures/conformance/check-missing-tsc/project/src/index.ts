/** Ordinary source. The point of this fixture is the missing compiler. */
export function add(a: number, b: number): number {
  return a + b;
}

export function total(values: readonly number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}
