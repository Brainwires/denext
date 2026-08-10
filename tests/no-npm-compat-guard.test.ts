// Guard: the React/Next compat runtime must depend only on Deno built-ins and
// JSR std — never an npm package. `node:*` built-ins (e.g. node:sqlite) are Deno
// built-ins and allowed; a bare `npm:` specifier is not. This keeps the compat
// layer installable without a native npm toolchain.

import { assert } from "@std/assert";
import { walk } from "@std/fs";

Deno.test("no npm: specifiers in the compat runtime", async () => {
  const offenders: string[] = [];
  const root = new URL("../src/compat/", import.meta.url);
  for await (const entry of walk(root, { exts: [".ts"] })) {
    const text = await Deno.readTextFile(entry.path);
    // Match import/export/dynamic-import specifiers pointing at npm:.
    if (/from\s+["']npm:/.test(text) || /import\(\s*["']npm:/.test(text)) {
      offenders.push(entry.path);
    }
  }
  assert(
    offenders.length === 0,
    `compat modules must not import npm: — found in:\n${offenders.join("\n")}`,
  );
});
