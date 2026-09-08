/**
 * A call graph with a deliberate bottleneck.
 *
 * `normalize` sits on every path from the three entry points to `validate`,
 * so it carries the fan-in and the betweenness the criticality profile is
 * supposed to find. The numbers ARE the contract (SPEC.md section 6), so this
 * shape is what the golden pins.
 */

export function validate(value: string): string {
  if (value.length === 0) {
    throw new Error("empty");
  }
  return value;
}

export function normalize(value: string): string {
  return validate(value).trim().toLowerCase();
}

export function parse(value: string): string {
  return normalize(value);
}

export function render(value: string): string {
  return `<${normalize(value)}>`;
}

export function report(value: string): string {
  return `report: ${normalize(value)}`;
}
