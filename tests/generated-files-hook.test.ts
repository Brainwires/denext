// The generated files the pre-commit hook maintains (.githooks/pre-commit) must not churn:
// regenerating from unchanged inputs rewrites nothing, and the same inputs give the same bytes
// wherever they are generated, so two parallel commits never differ on them.

import { assert, assertEquals } from "@std/assert";
import { badgeJson, writeIfChanged } from "../scripts/badge-tests.ts";
import { CORPUS_OUT, corpusIsCurrent } from "../scripts/gen-docs-corpus.ts";
import { fingerprint } from "../scripts/lib/docs-corpus.ts";

Deno.test("badge: the same count gives the same bytes, and an unchanged badge is not rewritten", async () => {
  assertEquals(badgeJson(11_000), badgeJson(11_000));
  assert(badgeJson(11_000) !== badgeJson(11_001));
  const dir = await Deno.makeTempDir({ prefix: "denext_badge_" });
  try {
    const path = `${dir}/tests.json`;
    assertEquals(await writeIfChanged(path, badgeJson(1)), true, "a missing file is written");
    const { mtime } = await Deno.stat(path);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(await writeIfChanged(path, badgeJson(1)), false, "unchanged content: no write");
    assertEquals((await Deno.stat(path)).mtime?.getTime(), mtime?.getTime(), "mtime untouched");
    assertEquals(await writeIfChanged(path, badgeJson(2)), true, "a new count is written");
    assertEquals(await Deno.readTextFile(path), badgeJson(2));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("docs corpus: `--if-stale` sees the committed corpus as current, a stale or missing one as not", async () => {
  // The committed corpus matches its inputs (tests/mcp-docs-corpus.test.ts proves the same), so
  // the hook's `docs:corpus --if-stale` leaves it untouched.
  assertEquals(await corpusIsCurrent(), true, "the committed corpus is current");
  assertEquals(await corpusIsCurrent(CORPUS_OUT), true);
  const dir = await Deno.makeTempDir({ prefix: "denext_corpus_" });
  try {
    const stale = `${dir}/mod.ts`;
    const text = await Deno.readTextFile(CORPUS_OUT);
    const other = await fingerprint([{ path: "x.md", text: "not the inputs\n" }]);
    await Deno.writeTextFile(
      stale,
      text.replace(/^(export const CORPUS_SOURCE_HASH: string = )"[0-9a-f]+";$/m, `$1"${other}";`),
    );
    assert(
      (await Deno.readTextFile(stale)).includes(other),
      "the test module carries the other hash",
    );
    assertEquals(await corpusIsCurrent(stale), false, "a corpus from other inputs is stale");
    assertEquals(await corpusIsCurrent(`${dir}/missing.ts`), false, "a missing corpus is stale");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("docs corpus: the inputs' fingerprint does not depend on the order they are listed in", async () => {
  // `pageSources` reads a directory, whose order is the filesystem's; the fingerprint sorts, so
  // the same files give the same hash — and the same corpus bytes — on any machine.
  const a = await fingerprint([{ path: "b/page.tsx", text: "p" }, {
    path: "b/content.md",
    text: "c",
  }]);
  const b = await fingerprint([{ path: "b/content.md", text: "c" }, {
    path: "b/page.tsx",
    text: "p",
  }]);
  assertEquals(a, b);
});
