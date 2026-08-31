// Commit-parity test for `denext migrate`'s Effect support, run against a real Next app.
//
// `examples/effect/` is an actual Next.js App Router app that depends on `effect`; its
// denext config files (deno.json, denext.config.ts, .gitignore, .vscode/*) are GENERATED
// by `denext migrate` and committed as golden. This test copies the fixture, snapshots
// those golden files, deletes them, re-runs the migration from the pristine Next source,
// and asserts the output is byte-for-byte identical — so a change to migrate's Effect
// wiring (or a denext version bump) that drifts from the committed golden fails loudly.
//
// To refresh the golden after an intended change: `deno run -A cli.ts migrate examples/effect`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";

const FIXTURE = fromFileUrl(new URL("../examples/effect", import.meta.url));

/** The denext config files migrate generates for the fixture (deleted + regenerated here). */
const GENERATED = [
  "deno.json",
  "denext.config.ts",
  ".gitignore",
  ".vscode/settings.json",
  ".vscode/extensions.json",
];

Deno.test("migrate reproduces the examples/effect golden config files exactly", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "denext_effect_fixture_" });
  // Work on a COPY under `app/` so the committed fixture is never mutated.
  const dir = join(tmp, "app");
  try {
    await copy(FIXTURE, dir);

    // 1. Snapshot the existing (committed golden) config files, then delete them. Reading
    //    fails loudly if a golden file is missing — the fixture must ship them.
    const golden = new Map<string, string>();
    for (const rel of GENERATED) {
      golden.set(rel, await Deno.readTextFile(join(dir, rel)));
      await Deno.remove(join(dir, rel));
    }

    // Guard the golden itself: the Effect wiring must be present in the committed output.
    assertStringIncludes(golden.get("deno.json")!, '"@denext/effect":');
    assertStringIncludes(golden.get("deno.json")!, '"effect": "npm:effect@');
    assertStringIncludes(
      golden.get("denext.config.ts")!,
      "plugins: [effect()]",
    );
    assertStringIncludes(
      golden.get("denext.config.ts")!,
      'from "@denext/effect"',
    );

    // 2. Re-run the migration from the pristine Next source (package.json/next.config/tsconfig).
    const r = await migrateProject(dir);
    assertEquals(r.kind, "next");
    assert(r.effect, "fixture depends on effect → the bridge must be wired");

    // 3. Every regenerated file must match its golden byte-for-byte (commit parity).
    for (const rel of GENERATED) {
      const regenerated = await Deno.readTextFile(join(dir, rel));
      assertEquals(
        regenerated,
        golden.get(rel),
        `regenerated ${rel} differs from the committed golden — re-run ` +
          "`deno run -A cli.ts migrate examples/effect` and commit the result.",
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
