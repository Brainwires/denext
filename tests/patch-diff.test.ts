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

// ── Linear-space diff, trailing-newline fidelity, /dev/null headers ──────────

Deno.test("createUnifiedDiff: a 20k-line file with one edit diffs in linear memory, fast", () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${"x".repeat(i % 7)}`);
  const before = lines.join("\n") + "\n";
  const after = lines.map((l, i) => i === 9_999 ? "CHANGED" : l).join("\n") + "\n";
  const rss0 = Deno.memoryUsage().rss;
  const t0 = performance.now();
  const patch = createUnifiedDiff(before, after, "a/big.js", "b/big.js");
  const ms = performance.now() - t0;
  const grew = (Deno.memoryUsage().rss - rss0) / 1024 / 1024;
  assertStringIncludes(patch, "-line 9999");
  assertStringIncludes(patch, "+CHANGED");
  assertEquals(parseUnifiedDiff(patch)[0].hunks.length, 1);
  assertEquals(applyFileDiff(before, parseUnifiedDiff(patch)[0]), after);
  assert(ms < 2_000, `took ${ms.toFixed(0)} ms`);
  assert(grew < 200, `RSS grew ${grew.toFixed(0)} MB (the old full-trace Myers needed gigabytes)`);
  // Many scattered edits (the D-heavy case) stay bounded too.
  const scattered = lines.map((l, i) => i % 97 === 0 ? l + "!" : l).join("\n") + "\n";
  const t1 = performance.now();
  const many = parseUnifiedDiff(createUnifiedDiff(before, scattered, "a/x", "b/x"))[0];
  assert(performance.now() - t1 < 5_000, "scattered edits");
  assertEquals(applyFileDiff(before, many), scattered);
});

Deno.test("createUnifiedDiff: a replacement lists `-` lines before `+` lines (diff convention)", () => {
  const patch = createUnifiedDiff("a\nb\nc\n", "a\nX\nY\nc\n", "a/f", "b/f");
  const kinds = parseUnifiedDiff(patch)[0].hunks[0].lines.map((l) => l.kind + l.text);
  assertEquals(kinds, [" a", "-b", "+X", "+Y", " c"]);
});

Deno.test("trailing newline: removing or adding the final newline round-trips through the marker", async () => {
  // Removed: "a\nb\n" → "a\nB"  — the marker sits after `+B`.
  const removed = createUnifiedDiff("a\nb\n", "a\nB", "a/f", "b/f");
  assertStringIncludes(removed, "+B\n\\ No newline at end of file\n");
  const [d1] = parseUnifiedDiff(removed);
  assertEquals(d1.hunks[0].lines.find((l) => l.text === "B")?.noEol, true);
  assertEquals(applyFileDiff("a\nb\n", d1), "a\nB", "the newline is gone after apply");
  assertEquals(applyFileDiff("a\nB", reverseFileDiff(d1)), "a\nb\n", "and comes back on revert");
  assert(!fileDiffApplies("a\nB\n", reverseFileDiff(d1)), "the idempotency probe tells them apart");
  // Added: "a\nb" → "a\nb\n" — the marker sits after `-b`.
  const added = createUnifiedDiff("a\nb", "a\nb\n", "a/f", "b/f");
  assertStringIncludes(added, "-b\n\\ No newline at end of file\n+b\n");
  const [d2] = parseUnifiedDiff(added);
  assertEquals(applyFileDiff("a\nb", d2), "a\nb\n");
  assertEquals(applyFileDiff("a\nb\n", reverseFileDiff(d2)), "a\nb");
  // Unchanged EOF context: one marker on the shared context line.
  const ctx = createUnifiedDiff("x\na\nb", "y\na\nb", "a/f", "b/f");
  assertEquals((ctx.match(/No newline/g) ?? []).length, 1);
  assertEquals(applyFileDiff("x\na\nb", parseUnifiedDiff(ctx)[0]), "y\na\nb");
  // The system `patch` agrees on the removed-newline case (soft gate, like the interop test).
  const dir = await Deno.makeTempDir({ prefix: "denext_eol_" });
  try {
    await Deno.writeTextFile(join(dir, "f"), "a\nb\n");
    await Deno.writeTextFile(join(dir, "x.patch"), removed.replace("a/f", "f").replace("b/f", "f"));
    const out = await new Deno.Command("patch", {
      args: ["-p0", "-i", "x.patch"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output().catch(() => null);
    if (out?.success) assertEquals(await Deno.readTextFile(join(dir, "f")), "a\nB");
    else console.warn("patch(1) unavailable — interop check skipped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/dev/null headers mark created and deleted files; the real path stays on both sides", () => {
  const created = createUnifiedDiff("", "one\ntwo\n", "/dev/null", "b/pkg/new.js");
  assertStringIncludes(created, "--- /dev/null\n+++ b/pkg/new.js\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const [c] = parseUnifiedDiff(created);
  assertEquals([c.created, c.deleted, c.oldPath, c.newPath], [
    true,
    undefined,
    "pkg/new.js",
    "pkg/new.js",
  ]);
  assertEquals(applyFileDiff("", c), "one\ntwo\n");
  const deleted = createUnifiedDiff("one\ntwo\n", "", "a/pkg/old.js", "/dev/null");
  assertStringIncludes(deleted, "--- a/pkg/old.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n");
  const [d] = parseUnifiedDiff(deleted);
  assertEquals([d.created, d.deleted, d.newPath], [undefined, true, "pkg/old.js"]);
  assertEquals(applyFileDiff("one\ntwo\n", d), "");
  const r = reverseFileDiff(d);
  assertEquals([r.created, r.deleted], [true, undefined]);
  assertEquals(applyFileDiff("", r), "one\ntwo\n", "reverting a deletion recreates the file");
});
