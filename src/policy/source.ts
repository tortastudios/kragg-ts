/**
 * WHERE a project's policy comes from — the file, not the settings.
 *
 * Split out of `policy.ts` for size, along the seam the module already had:
 * `policy.ts` turns a config TABLE into a `KraggPolicy`, and this answers the
 * question that comes first — which file that table was read from, and whether
 * the project wrote one at all.
 *
 * Both answers matter beyond loading. `declaresPolicy` is what a workspace
 * member run consults before deciding whether to inherit the root's rules, and
 * `loadSource`'s label is what every `PolicyError` names, so a message points
 * at the file the reader actually opened.
 */

import { join } from "node:path";

import { isTable, own, PolicyError, readTable, type Source } from "./readers.ts";

/**
 * Whether `root` carries a policy of its own — a `kragg.json`, or a
 * `package.json` with a `kragg` key.
 *
 * For a workspace member under `--package`: a member that declares nothing
 * inherits the ROOT's policy rather than the defaults, because the root's
 * `kragg.json` is where a workspace writes its rules once. A member that
 * declares anything at all is on its own, exactly as `loadPolicy` treats a
 * standalone project — there is no merge, and a malformed member policy is
 * still a `PolicyError` when it is loaded.
 */
export function declaresPolicy(root: string): boolean {
  if (readTable(join(root, "kragg.json")) !== null) {
    return true;
  }
  const pkg = readTable(join(root, "package.json"));
  return pkg !== null && own(pkg, "kragg") !== undefined;
}

/**
 * Read the raw config table and where it came from; an empty table when the
 * project configures nothing.
 *
 * A `package.json#kragg` that is present but not an object is REJECTED, not
 * read as "unconfigured" (which is what Python's `isinstance(kragg, dict)`
 * guard does): the project wrote a policy block, and running the defaults in
 * its place would be the silent fall-back this module refuses everywhere
 * else. A `kragg.json` that is not an object is already rejected by
 * `readTable`.
 */
export function loadSource(root: string): Source {
  const standalonePath = join(root, "kragg.json");
  const standalone = readTable(standalonePath);
  if (standalone !== null) {
    return { table: standalone, label: `${standalonePath}#`, consumed: new Set() };
  }
  const pkgPath = join(root, "package.json");
  const pkg = readTable(pkgPath);
  const label = `${pkgPath}#kragg.`;
  if (pkg === null) {
    return { table: {}, label, consumed: new Set() };
  }
  const kragg = own(pkg, "kragg");
  if (kragg === undefined) {
    return { table: {}, label, consumed: new Set() };
  }
  if (!isTable(kragg)) {
    throw new PolicyError(
      `${pkgPath}#kragg must be a JSON object of kragg settings (got ${JSON.stringify(kragg)})`,
    );
  }
  return { table: kragg, label, consumed: new Set() };
}
