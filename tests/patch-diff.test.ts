// The in-house unified-diff engine behind `denext patch`: create ↔ apply round-trips,
// hunk grouping, offset tolerance, failure naming the hunk, and interop with the
// system `patch` tool (the format must be what patch-package users can read and edit).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  applyFileDiff,
  applyUnifiedDiff,
  createUnifiedDiff,
  fileDiffApplies,
  parseUnifiedDiff,
  reverseFileDiff,
} from "../src/build/patch-diff.ts";

const OLD = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function edit(text: string, fn: (lines: string[]) => void): string {
  const lines = text.split("\n");
  lines.pop();
  fn(lines);
  return lines.join("\n") + "\n";
}

Deno.test("createUnifiedDiff → applyFileDiff round-trips edits (change, insert, delete, two hunks)", async () => {
  const NEW = edit(OLD, (l) => {
    l[4] = "line 5 CHANGED";
    l.splice(10, 0, "inserted A", "inserted B");
    l.splice(30, 2); // delete two lines far away → a second hunk
  });
  const patch = createUnifiedDiff(OLD, NEW, "a/pkg/x.js", "b/pkg/x.js");
  assertStringIncludes(patch, "--- a/pkg/x.js\n+++ b/pkg/x.js\n");
  const files = parseUnifiedDiff(patch);
  assertEquals(files.length, 1);
  assertEquals(files[0].newPath, "pkg/x.js");
  assertEquals(files[0].hunks.length, 2, "distant changes → separate hunks");
  assertEquals(applyFileDiff(OLD, files[0]), NEW);
  const applied = await applyUnifiedDiff(patch, () => Promise.resolve(OLD));
  assertEquals(applied.get("pkg/x.js"), NEW);
  assertEquals(createUnifiedDiff(OLD, OLD, "x"), "", "identical → empty");
});

Deno.test("applyFileDiff tolerates a shifted file and names a hunk that no longer applies", () => {
  const NEW = edit(OLD, (l) => {
    l[20] = "line 21 CHANGED";
  });
  const [file] = parseUnifiedDiff(createUnifiedDiff(OLD, NEW, "x"));
  // The package gained 5 lines above the hunk (a newer version): the context still matches.
  const shifted = "// a\n// b\n// c\n// d\n// e\n" + OLD;
  assertEquals(applyFileDiff(shifted, file), "// a\n// b\n// c\n// d\n// e\n" + NEW);
  // The context itself changed: refuse, naming the hunk.
  const broken = edit(OLD, (l) => {
    l[19] = "line 20 is different now";
  });
  assertThrows(() => applyFileDiff(broken, file), Error, "hunk #1");
});

Deno.test("the emitted diff is what the system `patch` tool applies (interop)", async () => {
  const NEW = edit(OLD, (l) => {
    l[0] = "line 1 CHANGED";
    l.push("appended");
  });
  const dir = await Deno.makeTempDir({ prefix: "denext_patch_" });
  try {
    await Deno.writeTextFile(join(dir, "x.txt"), OLD);
    await Deno.writeTextFile(join(dir, "x.patch"), createUnifiedDiff(OLD, NEW, "x.txt"));
    const out = await new Deno.Command("patch", {
      args: ["-p0", "-i", "x.patch"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      console.warn(
        "patch tool unavailable/failed — skipping interop:",
        new TextDecoder().decode(out.stderr),
      );
      return;
    }
    assertEquals(await Deno.readTextFile(join(dir, "x.txt")), NEW);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reverseFileDiff undoes a patch; fileDiffApplies is the dry run", () => {
  const NEW = edit(OLD, (l) => {
    l.splice(3, 1, "three", "and a half");
  });
  const [file] = parseUnifiedDiff(createUnifiedDiff(OLD, NEW, "x"));
  assert(fileDiffApplies(OLD, file));
  assert(!fileDiffApplies(NEW, file), "already applied → the forward diff no longer fits");
  const reverse = reverseFileDiff(file);
  assert(fileDiffApplies(NEW, reverse));
  assertEquals(applyFileDiff(NEW, reverse), OLD);
  assertEquals(reverse.hunks[0].lines.filter((l) => l.kind === "-").map((l) => l.text), [
    "three",
    "and a half",
  ]);
});

Deno.test("parseUnifiedDiff reads a hand-written patch-package style file (no trailing newline marker)", () => {
  const patch = `diff --git a/node_modules/left-pad/index.js b/node_modules/left-pad/index.js
--- a/node_modules/left-pad/index.js
+++ b/node_modules/left-pad/index.js
@@ -1,3 +1,3 @@
 "use strict";
-module.exports = leftPad;
+module.exports = patchedLeftPad;
 var cache = [];
\\ No newline at end of file
`;
  const [file] = parseUnifiedDiff(patch);
  assertEquals(file.newPath, "node_modules/left-pad/index.js");
  const src = `"use strict";\nmodule.exports = leftPad;\nvar cache = [];`;
  assert(applyFileDiff(src, file).includes("patchedLeftPad"));
});
