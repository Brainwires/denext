// The read grant that keeps a sandboxed child inside a project directory
// (`src/build/contained-read.ts`): whole when no symlink leads out, entry by entry otherwise.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  allowReadFlags,
  containedReadGrants,
  containmentRoot,
} from "../src/build/contained-read.ts";

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
      await Deno.mkdir(join(root, "vendor", "@repo"), { recursive: true });
      await Deno.mkdir(join(root, "vendor", "react"));
      await Deno.mkdir(join(root, "src"));
      await Deno.writeTextFile(join(root, "next.config.mjs"), "");
      await Deno.symlink(outside, join(root, "vendor", "@repo", "ui"));
      await Deno.writeTextFile(join(root, "vendor", "@repo", "x.txt"), "");
      assertEquals(await grants(root), [
        "next.config.mjs",
        "src",
        join("vendor", "@repo", "x.txt"),
        join("vendor", "react"),
      ]);
    });
  },
);

Deno.test(
  "a node_modules link out (or into a directory holding one) refuses the grant",
  symlinks,
  async () => {
    for (const via of [false, true]) {
      await withProject(async (root, outside) => {
        await Deno.mkdir(join(root, "node_modules"));
        await Deno.mkdir(join(root, "src"));
        if (via) {
          await Deno.symlink(outside, join(root, "src", "u"));
          await Deno.symlink(join("..", "src"), join(root, "node_modules", "pkg"));
        } else {
          await Deno.symlink(outside, join(root, "node_modules", "pkg"));
        }
        const result = await containedReadGrants(root);
        assert(!result.ok, "expected a refusal");
        assertEquals(
          result.reason.startsWith(join(root, "node_modules", "pkg")),
          true,
          result.reason,
        );
      });
    }
    // A dangling one is no read path, so it is only left out.
    await withProject(async (root) => {
      await Deno.mkdir(join(root, "node_modules"));
      await Deno.symlink("missing", join(root, "node_modules", "gone"));
      await Deno.writeTextFile(join(root, "f.txt"), "");
      assertEquals(await grants(root), ["f.txt"]);
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

/** A canonical temp dir holding `files` (relative path → contents); removed afterwards. */
async function withTree(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-contained-ws-" }));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await Deno.mkdir(join(root, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, rel), text);
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("containmentRoot: a workspace member is contained in its workspace root", async () => {
  const app = "apps/web/package.json";
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["deno.json workspace", { "deno.json": '{"workspace":["apps/web"]}', [app]: "{}" }, true],
    ["npm workspaces", { "package.json": '{"workspaces":["apps/*"]}', [app]: "{}" }, true],
    ["pnpm apps/*", { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n", [app]: "{}" }, true],
    ["pnpm apps/**", { "pnpm-workspace.yaml": "packages:\n  - apps/**\n", [app]: "{}" }, true],
    ["pnpm path", { "pnpm-workspace.yaml": "packages:\n  - ./apps/web\n", [app]: "{}" }, true],
    [
      "pnpm not listed",
      { "pnpm-workspace.yaml": "packages:\n  - packages/*\n", [app]: "{}" },
      false,
    ],
    [
      "pnpm negated",
      { "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - '!apps/web'\n", [app]: "{}" },
      false,
    ],
    ["deno.json not listing it", { "deno.json": '{"workspace":["pkg"]}', [app]: "{}" }, false],
    ["no workspace", { [app]: "{}" }, false],
  ];
  for (const [label, files, member] of cases) {
    await withTree(files, async (root) => {
      const dir = join(root, "apps", "web");
      assertEquals(await containmentRoot(dir), member ? root : dir, label);
    });
  }
});

Deno.test(
  "a workspace's grants are spelled relative to the member it runs in",
  symlinks,
  async () => {
    await withTree({ "apps/web/next.config.mjs": "", "root.txt": "" }, async (root) => {
      const dir = join(root, "apps", "web");
      await Deno.symlink("/", join(root, "escape"));
      const result = await containedReadGrants(root, dir);
      assert(result.ok, result.ok ? "" : result.reason);
      assertEquals(result.paths, ["..", join("..", "..", "root.txt")]);
    });
  },
);
