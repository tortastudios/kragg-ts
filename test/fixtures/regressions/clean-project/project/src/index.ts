/** A small, honest project: every function here is exercised by the suite. */

export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export function add(left: number, right: number): number {
  return left + right;
}

export function formatMoney(value: Money): string {
  return `${value.amount.toFixed(2)} ${value.currency}`;
}
