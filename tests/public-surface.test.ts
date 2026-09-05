// The public export surface is frozen by 2.0: every `deno.json` entry's exported names must
// match the committed golden. An intentional change is a `deno task surface:refresh` plus a
// CHANGELOG entry (Added / Removed / Deprecated) — never an incidental side effect.

import { assertEquals } from "@std/assert";
import { publicSurface, SURFACE_FIXTURE } from "../scripts/public-surface.ts";

Deno.test("public API surface matches tests/fixtures/public-surface.json (deno task surface:refresh)", async () => {
  const expected = JSON.parse(await Deno.readTextFile(SURFACE_FIXTURE)) as Record<string, string[]>;
  const actual = await publicSurface();
  for (const module of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const want = expected[module] ?? [];
    const got = actual[module] ?? [];
    const added = got.filter((s) => !want.includes(s));
    const removed = want.filter((s) => !got.includes(s));
    assertEquals(
      { added, removed },
      { added: [], removed: [] },
      `${module}: public surface drifted — if intentional, run \`deno task surface:refresh\` and note it in CHANGELOG.md`,
    );
  }
});
