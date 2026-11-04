// Workspace member globs, expanded as each tool reads its list (src/build/workspace-globs.ts):
// a deno.json `workspace`, a package.json `workspaces` and a `pnpm-workspace.yaml`. Every case
// was checked against the tool itself (Deno 2.9.8 / denext's toolchain, npm 11, pnpm 11).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  npmWorkspaceOf,
  workspaceApps,
  workspaceImports,
  workspaceOf,
} from "../src/build/workspace-imports.ts";
import {
  expandWorkspaceMembers,
  MAX_BRACE_EXPANSIONS,
  WorkspaceEntryError,
  workspaceSelects,
} from "../src/build/workspace-globs.ts";
import { appPlan } from "../src/build/generate-app.ts";
import { removeTempDir } from "./helpers/temp.ts";

/** Write `files` (path → text, objects as JSON) under a fresh real-path temp dir. */
async function tree(files: Record<string, string | object>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_wsglob_" }));
  for (const [rel, body] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(
      join(dir, rel),
      typeof body === "string" ? body : JSON.stringify(body, null, 2),
    );
  }
  return dir;
}

/** A Deno package `@t/<name>` at `rel`. */
const denoPkg = (rel: string, name: string) => ({
  [`${rel}/deno.json`]: { name: `@t/${name}`, exports: "./mod.ts" },
  [`${rel}/mod.ts`]: `export const n = "${name}";\n`,
});

/** An npm package `<name>` at `rel`. */
const npmPkg = (rel: string, name: string) => ({
  [`${rel}/package.json`]: { name, version: "1.0.0" },
});

/** The members' paths relative to `root`, `/`-separated. */
const rels = (root: string, dirs: readonly string[]) =>
  dirs.map((d) => d.slice(root.length + 1).replaceAll("\\", "/"));

/** Whether symlinks can be made here (Windows without the privilege can't). */
async function canSymlink(dir: string): Promise<boolean> {
  try {
    await Deno.symlink(dir, join(dir, ".probe-link"), { type: "dir" });
    await Deno.remove(join(dir, ".probe-link"));
    return true;
  } catch {
    return false;
  }
}

Deno.test("deno workspace: `**` and a mid-path glob reach members two levels down", async () => {
  const dir = await tree({
    "deno.json": { workspace: ["./packages/**", "./apps/*/web"] },
    ...denoPkg("packages/ui", "ui"),
    ...denoPkg("packages/group/a", "a"),
    ...denoPkg("packages/group/deep/b", "b"),
    "packages/group/notes.md": "no config: no member\n",
    "apps/site/web/deno.json": {},
    "apps/site/web/app/page.tsx": "export default () => null;\n",
  });
  try {
    const ws = await workspaceImports(join(dir, "apps/site/web/deno.json"));
    assertEquals(Object.keys(ws.imports).sort(), ["@t/a", "@t/b", "@t/ui"]);
    assertEquals(await workspaceApps(dir), ["apps/site/web"]);
    assertEquals(rels(dir, (await workspaceOf(join(dir, "packages/group/deep/b")))!.members), [
      "packages/group/a",
      "packages/group/deep/b",
      "packages/ui",
      "apps/site/web",
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("deno workspace: `!` exclusions, node_modules, dot folders and literal brackets", async () => {
  const dir = await tree({
    "deno.json": { workspace: ["./packages/**", "!./packages/legacy/**", "!./packages/a"] },
    ...denoPkg("packages/a", "a"),
    ...denoPkg("packages/a/inner", "inner"),
    ...denoPkg("packages/legacy", "legacy"),
    ...denoPkg("packages/legacy/old", "old"),
    ...denoPkg("packages/node_modules/nm", "nm"),
    ...denoPkg("packages/x/node_modules/nm2", "nm2"),
    ...denoPkg("packages/.hidden", "hidden"),
    ...denoPkg("packages/keep", "keep"),
  });
  try {
    // `!./packages/a` excludes that directory alone, as Deno does; its `inner` stays.
    assertEquals(rels(dir, (await workspaceOf(dir))!.members), [
      "packages/a/inner",
      "packages/keep",
    ]);
    // An exclusion applies wherever it sits in the list, and never to a path entry.
    assertEquals(
      rels(dir, expandWorkspaceMembers(dir, ["!./packages/keep", "./packages/*"], "deno")),
      ["packages/a", "packages/legacy"],
    );
    assertEquals(
      rels(dir, expandWorkspaceMembers(dir, ["./packages/keep", "!./packages/keep"], "deno")),
      ["packages/keep"],
    );
    // A dot folder only when spelled out; node_modules only through a literal segment.
    assertEquals(rels(dir, expandWorkspaceMembers(dir, ["./packages/.*"], "deno")), [
      "packages/.hidden",
    ]);
    assertEquals(expandWorkspaceMembers(dir, ["./packages/node_*"], "deno"), []);
    // Deno has no character classes or braces: `[ak]*` names a folder spelled that way.
    assertEquals(expandWorkspaceMembers(dir, ["./packages/[ak]*"], "deno"), []);
    // The root itself and anything outside it are never members.
    assertEquals(expandWorkspaceMembers(dir, ["./**/..", "../*", "/tmp/*", "."], "deno"), []);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("npm workspaces: `**`, a mid-path glob, braces, classes and `!`", async () => {
  const dir = await tree({
    "package.json": { name: "root", private: true, workspaces: ["packages/**", "!packages/a"] },
    ...npmPkg("packages/a", "a"),
    ...npmPkg("packages/a/inner", "inner"),
    ...npmPkg("packages/group/b", "b"),
    ...npmPkg("packages/group/deep/c", "c"),
    ...npmPkg("packages/node_modules/nm", "nm"),
    ...npmPkg("packages/.hidden", "hidden"),
    ...denoPkg("packages/deno-only", "deno-only"),
  });
  try {
    const ws = await npmWorkspaceOf(join(dir, "packages/group/deep/c"));
    assertEquals(rels(dir, ws!.members), [
      "packages/a/inner",
      "packages/group/b",
      "packages/group/deep/c",
    ]);
    // Yarn's `{ packages: [...] }` form, and the npm family's braces and classes.
    assertEquals(
      rels(dir, expandWorkspaceMembers(dir, ["packages/{a,group/*}", "packages/[ab]"], "npm")),
      ["packages/a", "packages/group/b"],
    );
    const yarn = await tree({
      "package.json": { private: true, workspaces: { packages: ["libs/*/*"] } },
      ...npmPkg("libs/x/one", "one"),
    });
    try {
      assertEquals(rels(yarn, (await npmWorkspaceOf(yarn))!.members), ["libs/x/one"]);
    } finally {
      await removeTempDir(yarn);
    }
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("pnpm-workspace.yaml: `**`, `!` exclusions and node_modules", async () => {
  const dir = await tree({
    "package.json": { name: "root", private: true },
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/**'\n  - '!**/test/**'\n",
    ...npmPkg("apps/web", "web"),
    ...npmPkg("packages/tools/cli", "cli"),
    "packages/tools/lint/package.yaml": "name: lint\n",
    ...npmPkg("packages/tools/test/fixture", "fixture"),
    ...npmPkg("packages/tools/node_modules/dep", "dep"),
  });
  try {
    const ws = await npmWorkspaceOf(join(dir, "packages/tools/cli"));
    assertEquals(rels(dir, ws!.members), [
      "apps/web",
      "packages/tools/cli",
      "packages/tools/lint",
    ]);
    assertEquals(await npmWorkspaceOf(join(dir, "packages/tools/test/fixture")), null);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("a symlink out of the root is never a member; one inside counts for npm only", async () => {
  const base = await tree({
    "outside/pkg/deno.json": { name: "@t/out", exports: "./mod.ts" },
    "outside/pkg/package.json": { name: "out" },
    ...denoPkg("root/packages/real", "real"),
    ...npmPkg("root/packages/real", "real"),
    ...denoPkg("root/elsewhere/twin", "twin"),
    ...npmPkg("root/elsewhere/twin", "twin"),
  });
  try {
    if (!await canSymlink(base)) return;
    const root = join(base, "root");
    await Deno.symlink(join(base, "outside/pkg"), join(root, "packages/out"), { type: "dir" });
    await Deno.symlink(join(base, "outside"), join(root, "packages/outdir"), { type: "dir" });
    await Deno.symlink(join(root, "elsewhere/twin"), join(root, "packages/twin"), { type: "dir" });
    for (const kind of ["deno", "npm", "pnpm"] as const) {
      for (const entry of ["./packages/*", "./packages/**", "./packages/outdir/*"]) {
        const found = rels(root, expandWorkspaceMembers(root, [entry], kind));
        assert(!found.some((f) => f.includes("out")), `${kind} ${entry}: ${found}`);
      }
    }
    // Deno's wildcards skip a symlinked folder; npm's (and pnpm's) take one inside the root.
    assertEquals(rels(root, expandWorkspaceMembers(root, ["./packages/*"], "deno")), [
      "packages/real",
    ]);
    assertEquals(rels(root, expandWorkspaceMembers(root, ["packages/*"], "npm")), [
      "packages/real",
      "packages/twin",
    ]);
  } finally {
    await removeTempDir(base);
  }
});

Deno.test("workspaceSelects: a list's patterns name a directory that need not exist", () => {
  const list = ["./apps/**", "./packages/*/", "!./apps/legacy"];
  assert(workspaceSelects(list, "apps/admin", "deno"));
  assert(workspaceSelects(list, "apps/team/admin", "deno"));
  assert(workspaceSelects(list, "packages/ui", "deno"));
  assert(!workspaceSelects(list, "apps/legacy", "deno"));
  assert(!workspaceSelects(list, "apps/node_modules/x", "deno"));
  assert(!workspaceSelects(list, "apps/.cache", "deno"));
  assert(!workspaceSelects(list, "packages/ui/inner", "deno"));
  assert(!workspaceSelects(list, "../apps/x", "deno"));
  // A Deno path entry stays a member even where a `!` entry matches it; npm's `!` applies.
  assert(workspaceSelects(["./x", "!./x"], "x", "deno"));
  assert(!workspaceSelects(["x", "!x"], "x", "npm"));
});

Deno.test("generate app: a `**` member already covers the new app", async () => {
  const dir = await tree({
    "deno.json": {
      workspace: ["./apps/**", "./packages/**"],
      imports: { denext: "jsr:@denext/denext@^4.0.0" },
    },
    ...denoPkg("packages/shared/ui", "ui"),
    ...denoPkg("packages/shared/shared", "shared"),
  });
  try {
    const plan = await appPlan(dir, "admin");
    const root = plan.find((f) => f.path === join(dir, "deno.json"))!;
    assertEquals(JSON.parse(root.contents).workspace, ["./apps/**", "./packages/**"]);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("a bad character class is a config error naming the entry, not a SyntaxError", () => {
  for (const [kind, list] of [["npm", "package.json"], ["pnpm", "pnpm-workspace.yaml"]] as const) {
    const error = assertThrows(
      () => expandWorkspaceMembers("/nonexistent-root", ["packages/*", "packages/[z-a]"], kind),
      WorkspaceEntryError,
      list,
    );
    assertEquals(error.entry, "packages/[z-a]");
    assert(error.message.includes('"packages/[z-a]"'), error.message);
    assertThrows(() => workspaceSelects(["apps/[z-a]*"], "apps/x", kind), WorkspaceEntryError);
  }
  // Deno has no classes: the same entry is a literal path there.
  assertEquals(
    expandWorkspaceMembers("/r", ["packages/[z-a]"], "deno"),
    [join("/r", "packages/[z-a]")],
  );
});

Deno.test("brace expansion is bounded: past the cap the entry is refused before it blows up", () => {
  // 2^10 = 1024 patterns: at the cap, still expanded.
  assert(workspaceSelects(["p/" + "{a,b}".repeat(10)], "p/" + "a".repeat(10), "npm"));
  assertEquals(MAX_BRACE_EXPANSIONS, 1024);
  // 2^25 patterns would take gigabytes: refused at once, naming the entry.
  const entry = "packages/" + "{a,b}".repeat(25);
  const started = performance.now();
  const error = assertThrows(
    () => expandWorkspaceMembers("/nonexistent-root", [entry], "pnpm"),
    WorkspaceEntryError,
    `more than ${MAX_BRACE_EXPANSIONS} patterns`,
  );
  assertEquals(error.entry, entry);
  assert(performance.now() - started < 2_000, "refused before expanding");
});
