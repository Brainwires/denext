// The read grant that keeps a sandboxed child inside a project directory
// (`src/build/contained-read.ts`): whole when no symlink leads out, entry by entry otherwise.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { allowReadFlags, containedReadGrants } from "../src/build/contained-read.ts";

/** A canonical temp dir with `app/` (the root) and `outside/` beside it; removed afterwards. */
async function withProject(fn: (root: string, outside: string) => Promise<void>): Promise<void> {
  const parent = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-contained-" }));
  try {
    const root = join(parent, "app");
    const outside = join(parent, "outside");
    await Deno.mkdir(root);
    await Deno.mkdir(outside);
    await fn(root, outside);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
}

/** The grant paths (fails the test when there is no grant). */
async function grants(root: string): Promise<readonly string[]> {
  const result = await containedReadGrants(root);
  assert(result.ok, result.ok ? "" : result.reason);
  return result.paths;
}

const symlinks = { ignore: Deno.build.os === "windows" }; // needs a privilege CI lacks there

Deno.test("a project with no link out of it is granted whole", symlinks, async () => {
  await withProject(async (root) => {
    await Deno.mkdir(join(root, "src", "lib"), { recursive: true });
    await Deno.writeTextFile(join(root, "src", "lib", "x.ts"), "");
    await Deno.symlink("src", join(root, "alias")); // stays inside
    assertEquals(await grants(root), [root]);
  });
});

Deno.test(
  "a link out is left out; only the directories above it are listed",
  symlinks,
  async () => {
    await withProject(async (root, outside) => {
      await Deno.mkdir(join(root, "node_modules", "@repo"), { recursive: true });
      await Deno.mkdir(join(root, "node_modules", "react"));
      await Deno.mkdir(join(root, "src"));
      await Deno.writeTextFile(join(root, "next.config.mjs"), "");
      await Deno.symlink(outside, join(root, "node_modules", "@repo", "ui"));
      await Deno.writeTextFile(join(root, "node_modules", "@repo", "x.txt"), "");
      assertEquals(await grants(root), [
        "next.config.mjs",
        join("node_modules", "@repo", "x.txt"),
        join("node_modules", "react"),
        "src",
      ]);
    });
  },
);

Deno.test(
  "a dangling link, and a link into a directory holding a link out, are left out",
  symlinks,
  async () => {
    await withProject(async (root, outside) => {
      await Deno.mkdir(join(root, "b"));
      await Deno.symlink(outside, join(root, "b", "u"));
      await Deno.symlink("b", join(root, "a"));
      await Deno.symlink("missing", join(root, "gone"));
      await Deno.symlink(root, join(root, "self"));
      await Deno.writeTextFile(join(root, "f.txt"), "");
      assertEquals(await grants(root), ["f.txt"]);
    });
  },
);

Deno.test("a name with a comma is not granted (it would split the list)", symlinks, async () => {
  await withProject(async (root, outside) => {
    await Deno.symlink(outside, join(root, "u"));
    await Deno.writeTextFile(join(root, "a,b.txt"), "");
    await Deno.writeTextFile(join(root, "c.txt"), "");
    assertEquals(await grants(root), ["c.txt"]);
  });
});

Deno.test("allowReadFlags comma-joins, splitting long lists across flags", () => {
  assertEquals(allowReadFlags(["/p"]), ["--allow-read=/p"]);
  assertEquals(allowReadFlags(["a", "b"]), ["--allow-read=a,b"]);
  const many = Array.from({ length: 4000 }, (_, i) => `node_modules/package-${i}`);
  const flags = allowReadFlags(many);
  assert(flags.length > 1);
  for (const flag of flags) assert(flag.length < 33_000, String(flag.length));
  assertEquals(flags.flatMap((f) => f.slice("--allow-read=".length).split(",")), many);
});
