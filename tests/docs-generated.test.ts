// Drift checks for generated docs-site artifacts. Each test re-derives the artifact from
// its live source of truth and compares byte-for-byte with the committed file, so a change
// that isn't regenerated fails here instead of shipping a stale docs page.

import { assertEquals } from "@std/assert";
import { CLI_OUT, generateCliReference } from "../scripts/gen-cli-reference.ts";

Deno.test("docs: cli.json is regenerated from the command registry", async () => {
  // Adding/removing a verb, flag or positional (or editing its help text) without running
  // `deno task docs:cli` fails here.
  assertEquals(
    await Deno.readTextFile(CLI_OUT),
    generateCliReference(),
    "apps/web/app/docs/cli/cli.json is stale — run `deno task docs:cli` (or `deno task docs:build`) and commit",
  );
});
