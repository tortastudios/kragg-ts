/**
 * The file the change set will name. The regression case rewrites this module
 * so `greet` takes a second parameter; `src/consumer.ts` is left untouched and
 * therefore stops compiling.
 */

export function greet(name: string): string {
  return `hello ${name}`;
}
