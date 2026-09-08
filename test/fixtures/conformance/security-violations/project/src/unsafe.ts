/** The banned API. `kragg.json` forbids this module by name. */
export function runShell(command: string): string {
  return `pretend-output-for:${command}`;
}
