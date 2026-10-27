// `denext create --monorepo`: the workspace's file tree and configs (src/build/scaffold-monorepo.ts),
// the app's monorepo-member variant (scaffold.ts's `monorepoScope`), and the pins planned over
// every config at once.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  MONOREPO_APP_DIR,
  MONOREPO_CONFIGS,
  monorepoAppOptions,
  monorepoConfigText,
  monorepoFiles,
  monorepoScope,
  scaffoldMonorepo,
} from "../src/build/scaffold-monorepo.ts";
import { denoJson, scaffoldFiles } from "../src/build/scaffold.ts";
import { pinEligibleFiles } from "../src/build/eligible-pins.ts";
import type { UpgradeLookups } from "../src/build/upgrade.ts";
import { effectiveRule } from "../src/build/dep-age.ts";
import { removeTempDir } from "./helpers/temp.ts";
import { VERSION } from "../mod.ts";

/** A parsed config. */
type Json = Record<string, unknown>;

const ROOT = "/work/my-shop";

/** The content of `path` among `files`. */
function content(files: { path: string; content: string }[], path: string): string {
  const file = files.find((f) => f.path === path);
  assert(file, `no ${path} among ${files.map((f) => f.path).join(", ")}`);
  return file.content;
}

Deno.test("monorepoScope: the root folder's name as a JSR-safe scope", () => {
  assertEquals(monorepoScope("/x/my-shop"), "@my-shop");
  assertEquals(monorepoScope("/x/My Shop_2"), "@my-shop-2");
  assertEquals(monorepoScope("/x/--Acme--"), "@acme");
  assertEquals(monorepoScope("/x/___"), "@app");
});

Deno.test("monorepoFiles: the root and the two packages", () => {
  const paths = monorepoFiles({ dir: ROOT }).map((f) => f.path).sort();
  assertEquals(paths, [
    ".gitignore",
    "README.md",
    "deno.json",
    "packages/shared/deno.json",
    "packages/shared/mod.test.ts",
    "packages/shared/mod.ts",
    "packages/ui/button.tsx",
    "packages/ui/card.tsx",
    "packages/ui/deno.json",
    "packages/ui/mod.ts",
    "packages/ui/styles.css",
    "packages/ui/ui.test.tsx",
  ]);
});

Deno.test("monorepo root deno.json: explicit members, root-only fields, shared options, tasks", () => {
  const root = JSON.parse(content(monorepoFiles({ dir: ROOT }), "deno.json")) as Json;
  // Listed one by one (a glob member works too, but the root says exactly what it holds).
  assertEquals(root.workspace, ["./apps/web", "./packages/ui", "./packages/shared"]);
  assertEquals(root.unstable, ["no-legacy-abort"]);
  assertEquals(root.allowScripts, { deny: ["npm:@parcel/watcher"] });
  assertEquals((root.compilerOptions as Json).jsxImportSource, "denext");
  assertEquals((root.lint as Json).plugins, [`jsr:@denext/denext@^${VERSION}/lint-plugin`]);
  assert(((root.fmt as Json).exclude as string[]).includes("**/.denext/"));
  assertEquals(root.exclude, [".deno/"]);
  const tasks = root.tasks as Record<string, string>;
  assertEquals(tasks.dev, "deno task --cwd apps/web dev");
  assertEquals(tasks.build, "deno task --cwd apps/web build");
  assertEquals(tasks.start, "deno task --cwd apps/web start");
  assertEquals(tasks.test, `deno run -A jsr:@denext/denext@^${VERSION}/cli test`);
  assertEquals(tasks.check, "deno fmt --check && deno lint && deno task test");
  for (const extra of ["desktop", "mobile:sync", "fallow:audit", "mcp"]) {
    assertEquals(tasks[extra], undefined, extra);
  }
});

Deno.test("monorepo root: --desktop / --capacitor / --fallow / --mcp add their root tasks", () => {
  const opts = { dir: ROOT, desktop: true, fastlane: true, fallow: true, mcp: true };
  const files = monorepoFiles(opts);
  const tasks = (JSON.parse(content(files, "deno.json")) as Json).tasks as Record<string, string>;
  assertEquals(tasks.desktop, "deno task --cwd apps/web desktop");
  assertEquals(tasks["mobile:sync"], "deno task --cwd apps/web mobile:sync");
  assertStringIncludes(tasks["fallow:audit"], "npm:fallow@");
  assertStringIncludes(tasks.mcp, `jsr:@denext/denext@^${VERSION}/cli mcp`);
  // fallow's single-app path patterns match at any depth, so they reach apps/web.
  const toml = content(files, "fallow.toml");
  assertStringIncludes(toml, '"**/denext.config.ts",');
  assertStringIncludes(toml, '"**/app/**/page.tsx",');
  assertStringIncludes(toml, '"**/.denext/**",');
  assert(!/^\s*"(?!\*\*\/)[^"]+",$/m.test(toml), toml);
  assertStringIncludes(content(files, "AGENTS.md"), "denext_");
  assertStringIncludes(content(files, ".gitignore"), "coverage/");
  const readme = content(files, "README.md");
  for (const row of ["desktop", "mobile:sync", "fallow:audit"]) assertStringIncludes(readme, row);
});

Deno.test("monorepo packages: named under the scope, with exports and their own imports", () => {
  const files = monorepoFiles({ dir: ROOT });
  const ui = JSON.parse(content(files, "packages/ui/deno.json")) as Json;
  assertEquals(ui.name, "@my-shop/ui");
  assertEquals(ui.exports, { ".": "./mod.ts", "./styles.css": "./styles.css" });
  assertEquals(
    (ui.imports as Json)["denext/jsx-runtime"],
    `jsr:@denext/denext@^${VERSION}/jsx-runtime`,
  );
  const shared = JSON.parse(content(files, "packages/shared/deno.json")) as Json;
  assertEquals(shared.name, "@my-shop/shared");
  assertEquals(shared.exports, "./mod.ts");
  // Components with no hooks: a Server Component and an island both render them.
  for (const file of ["packages/ui/button.tsx", "packages/ui/card.tsx"]) {
    const source = content(files, file);
    assert(!source.trimStart().startsWith(`"use client"`), file);
    assert(!/\buse[A-Z]\w*\(/.test(source), file);
    assertStringIncludes(source, "): VNode {"); // JSR's no-slow-types: explicit return types
  }
  assertStringIncludes(content(files, "packages/shared/mod.ts"), "export function pluralize(");
});

Deno.test("monorepo app: a normal app that imports the shared packages by name", () => {
  const opts = monorepoAppOptions({ dir: ROOT, mcp: true, fallow: true, tailwind: true });
  assertEquals(opts.dir, join(ROOT, MONOREPO_APP_DIR));
  assertEquals(opts.monorepoScope, "@my-shop");
  assertEquals([opts.vscode, opts.mcp, opts.fallow], [false, false, false]);
  assertEquals(opts.tailwind, true);
  const files = scaffoldFiles(opts);
  const config = JSON.parse(content(files, "deno.json")) as Json;
  // Fields a member may not set (Deno warns), and the lint the root shares, stay at the root.
  for (const key of ["allowScripts", "unstable", "lint"]) assertEquals(config[key], undefined, key);
  assertEquals((config.compilerOptions as Json).jsxImportSource, "denext");
  assertStringIncludes(content(files, "app/layout.tsx"), 'import "@my-shop/ui/styles.css";');
  const page = content(files, "app/page.tsx");
  assertStringIncludes(page, 'import { Card } from "@my-shop/ui";');
  assertStringIncludes(page, '<Card title="Shared components">');
  const counter = content(files, "app/counter.tsx");
  assertStringIncludes(counter, 'import { Button } from "@my-shop/ui";');
  assertStringIncludes(counter, 'import { pluralize } from "@my-shop/shared";');
  assertStringIncludes(counter, '{pluralize(count, "time")}');
  // Tailwind scans the app's folder: the packages are named as a source.
  assertStringIncludes(content(files, "styles/tailwind.css"), '@source "../../../packages";');
});

Deno.test("monorepo app: the minimal template renders the shared Card", () => {
  const files = scaffoldFiles(monorepoAppOptions({ dir: ROOT, template: "minimal" }));
  const page = content(files, "app/page.tsx");
  assertStringIncludes(page, 'import { Card } from "@my-shop/ui";');
  assert(!files.some((f) => f.path === "app/counter.tsx"));
});

Deno.test("a standalone app keeps every root field (no monorepo scope)", () => {
  const config = JSON.parse(denoJson({ dir: "/x" })) as Json;
  for (const key of ["allowScripts", "unstable", "lint"]) assert(config[key] !== undefined, key);
  const page = content(scaffoldFiles({ dir: "/x" }), "app/page.tsx");
  assert(!page.includes("Card"), page);
});

Deno.test("monorepoConfigText: every config's pins, planned together", () => {
  const text = monorepoConfigText({ dir: ROOT });
  // root tasks + lint, the app's imports and tasks, both packages' imports
  assert(text.includes('"workspace"'));
  assert(text.includes('"@my-shop/ui"'));
  assert(text.includes('"denext/deploy"'));
  assertEquals(MONOREPO_CONFIGS, [
    "deno.json",
    "apps/web/deno.json",
    "packages/ui/deno.json",
    "packages/shared/deno.json",
  ]);
});

Deno.test("scaffoldMonorepo: writes the tree, the root's .vscode and MCP configs", async () => {
  const dir = join(await Deno.makeTempDir({ prefix: "denext_monorepo_" }), "acme");
  try {
    const written = await scaffoldMonorepo({ dir, mcp: true });
    for (
      const path of [
        "deno.json",
        "packages/ui/button.tsx",
        "apps/web/deno.json",
        "apps/web/app/page.tsx",
        ".vscode/settings.json",
        ".mcp.json",
      ]
    ) {
      assert(written.includes(path), `${path} not in ${written.join(", ")}`);
      await Deno.stat(join(dir, path));
    }
    // The app's own .vscode / MCP configs are the root's.
    for (const path of ["apps/web/.vscode", "apps/web/.mcp.json"]) {
      await assertRejects(() => Deno.stat(join(dir, path)), Deno.errors.NotFound);
    }
    const app = JSON.parse(await Deno.readTextFile(join(dir, "apps/web/deno.json"))) as Json;
    assertEquals((app.imports as Json)["@acme/ui"], undefined); // resolved by the workspace
    await assertRejects(() => scaffoldMonorepo({ dir }), Error, "is not empty");
  } finally {
    await removeTempDir(join(dir, ".."));
  }
});

Deno.test("scaffoldMonorepo: --no-vscode writes no .vscode anywhere", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_monorepo_" });
  try {
    const written = await scaffoldMonorepo({ dir, vscode: false });
    assert(!written.some((p) => p.includes(".vscode")), written.join(", "));
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("pinEligibleFiles: one plan moves the pin in every config", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_monorepo_pins_" });
  try {
    await scaffoldMonorepo({ dir, vscode: false });
    const paths = MONOREPO_CONFIGS.map((c) => join(dir, c));
    const now = new Date("2026-10-20T20:00:00Z");
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    // This release is inside Deno's two-day hold; an older one is past it.
    const lookups: UpgradeLookups = {
      versions: (name) =>
        Promise.resolve(
          name === "@denext/denext"
            ? {
              latest: VERSION,
              versions: ["4.0.0", VERSION],
              published: { "4.0.0": ago(300), [VERSION]: ago(3) },
            }
            : null,
        ),
      denextRange: () => Promise.resolve(null),
    };
    const out = await pinEligibleFiles(paths, dir, {
      lookups,
      rule: effectiveRule({ now }),
      now,
    });
    assert(out.ok, out.error);
    assertEquals(out.notes.length, 1);
    for (const path of paths.slice(0, 3)) {
      const text = await Deno.readTextFile(path);
      assertStringIncludes(text, "jsr:@denext/denext@^4.0.0", path);
      assert(!text.includes(`@denext/denext@^${VERSION}`), path);
    }
    // Nothing old enough: an error, and no file touched.
    const none: UpgradeLookups = {
      ...lookups,
      versions: () =>
        Promise.resolve({ latest: VERSION, versions: [VERSION], published: { [VERSION]: ago(3) } }),
    };
    const before = await Deno.readTextFile(paths[2]);
    await Deno.writeTextFile(paths[2], before.replaceAll("^4.0.0", `^${VERSION}`));
    const refused = await pinEligibleFiles([paths[2]], dir, { lookups: none, now });
    assertEquals(refused.ok, false);
  } finally {
    await removeTempDir(dir);
  }
});

/** Run `denext create|init` with `flags` (the dependency-age hold off: no JSR lookups). */
async function runVerb(
  verb: "create" | "init",
  positionals: string[],
  flags: Record<string, unknown>,
): Promise<{ logs: string[]; errors: string[]; exit?: number }> {
  const { createCommand, initCommand } = await import("../src/cli/commands/create.ts");
  const logs: string[] = [];
  const errors: string[] = [];
  const { log, error } = console;
  const realExit = Deno.exit;
  const prior = Deno.env.get("DENEXT_MIN_DEP_AGE");
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  (Deno as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as typeof Deno.exit;
  Deno.env.set("DENEXT_MIN_DEP_AGE", "0");
  try {
    const command = verb === "create" ? createCommand : initCommand;
    await command.run({ positionals, flags, global: { json: false }, rest: [] } as never);
    return { logs, errors };
  } catch (err) {
    const code = /^EXIT:(\d+)$/.exec((err as Error).message)?.[1];
    if (code === undefined) throw err;
    return { logs, errors, exit: Number(code) };
  } finally {
    console.log = log;
    console.error = error;
    Deno.exit = realExit;
    if (prior === undefined) Deno.env.delete("DENEXT_MIN_DEP_AGE");
    else Deno.env.set("DENEXT_MIN_DEP_AGE", prior);
  }
}

Deno.test("denext create --monorepo scaffolds the workspace and says where the app is", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_monorepo_create_" });
  try {
    const dir = join(root, "shop");
    const out = await runVerb("create", [dir], {
      yes: true,
      monorepo: true,
      "no-vscode": true,
      template: "minimal",
    });
    assertEquals(out.exit, undefined, out.errors.join("\n"));
    const text = out.logs.join("\n");
    assertStringIncludes(text, "Scaffolding a denext monorepo");
    assertStringIncludes(text, "+ apps/web/app/page.tsx");
    assertStringIncludes(text, "Monorepo: the app is apps/web");
    const app = JSON.parse(await Deno.readTextFile(join(dir, "apps/web/deno.json"))) as Json;
    assertEquals((app.imports as Json).denext, `jsr:@denext/denext@^${VERSION}`);
    await Deno.stat(join(dir, "packages/ui/deno.json"));
  } finally {
    await removeTempDir(root);
  }
});

Deno.test("denext init --monorepo refuses: a monorepo is a new directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_monorepo_init_" });
  try {
    const out = await runVerb("init", [root], { yes: true, monorepo: true });
    assertEquals(out.exit, 1);
    assertStringIncludes(out.errors.join("\n"), "denext create <dir> --monorepo");
    assertEquals([...Deno.readDirSync(root)], []);
  } finally {
    await removeTempDir(root);
  }
});
