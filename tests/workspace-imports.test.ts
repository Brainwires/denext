// An app inside a Deno workspace (`denext create --monorepo`): the workspace as import-map entries
// the configs denext writes for a re-exec carry (src/build/workspace-imports.ts), and every
// resolver that has to treat a sibling package as the app's own — the server-copy compiler, the
// per-module dev loop, the import-map aliases and the CSS config.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  memberDirs,
  workspaceApps,
  workspaceImports,
  workspaceMemberDirs,
  workspaceMembers,
  workspacePackageDirs,
  workspaceRootHint,
  workspaceVerbTarget,
} from "../src/build/workspace-imports.ts";
import { mergeModuleConfig, writeMergedModuleConfig } from "../src/build/module-config.ts";
import { readImportAliases } from "../src/build/platform-extensions.ts";
import { ensureMergedConfig, resolveFirstParty } from "../src/build/dev-unbundled/resolve.ts";
import { createUnbundledState, norm } from "../src/build/dev-unbundled/state.ts";
import { createUseCacheLoaders, DevCopies } from "../src/build/use-cache-loader.ts";
import { buildAppCss } from "../src/build/css.ts";
import { removeTempDir } from "./helpers/temp.ts";
import { uiTargetOptions } from "../src/cli/commands/ui.ts";

/** Write `files` (path → text, objects as JSON) under a fresh real-path temp dir. */
async function tree(files: Record<string, string | object>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_ws_" }));
  for (const [rel, body] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(
      join(dir, rel),
      typeof body === "string" ? body : JSON.stringify(body, null, 2),
    );
  }
  return dir;
}

/** A monorepo: the root, an app, a UI package (two exports, own imports) and a nameless member. */
const MONOREPO = {
  "deno.json": {
    workspace: ["./apps/web", "./packages/ui", "./packages/plain", "./packages/missing"],
    imports: { "@root/": "./lib/", "zod": "jsr:@zod/zod@^4" },
  },
  "lib/x.ts": "export const x = 1;\n",
  "apps/web/deno.json": { imports: { "~/": "./" } },
  "apps/web/app/page.tsx": `import { Button } from "@acme/ui";\nexport default Button;\n`,
  "packages/ui/deno.json": {
    name: "@acme/ui",
    version: "0.1.0",
    exports: { ".": "./mod.ts", "./styles.css": "./styles.css", "./button": "./button.ts" },
    imports: { "dep": "jsr:@std/assert@^1", "#local/": "./local/" },
  },
  "packages/ui/mod.ts": `export { label as Button } from "./button.ts";\n`,
  "packages/ui/button.ts": `export const label = "ONE";\n`,
  "packages/ui/styles.css": ".ui { color: red; }\n",
  "packages/plain/deno.json": { imports: {} },
};

Deno.test("workspaceImports: the root's imports, members by name, member imports as scopes", async () => {
  const dir = await tree(MONOREPO);
  try {
    const ws = await workspaceImports(join(dir, "apps/web/deno.json"));
    const url = (rel: string) => toFileUrl(join(dir, rel)).href;
    assertEquals(ws.imports, {
      "@root/": `${url("lib")}/`,
      "zod": "jsr:@zod/zod@^4",
      "@acme/ui": url("packages/ui/mod.ts"),
      "@acme/ui/styles.css": url("packages/ui/styles.css"),
      "@acme/ui/button": url("packages/ui/button.ts"),
    });
    assertEquals(ws.scopes, {
      [`${url("packages/ui")}/`]: {
        "dep": "jsr:@std/assert@^1",
        "#local/": `${url("packages/ui/local")}/`,
      },
    });
    assertEquals(await workspaceMemberDirs(join(dir, "apps/web")), [
      join(dir, "packages/ui"),
      join(dir, "packages/plain"),
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("workspaceImports: a glob member, the object form, and an app that is the root", async () => {
  const dir = await tree({
    "deno.json": { workspace: { members: ["apps/*", "packages/*/"] } },
    "apps/web/deno.json": {},
    "packages/ui/deno.json": { name: "@acme/ui", exports: "./mod.ts" },
  });
  try {
    const ws = await workspaceImports(join(dir, "apps/web/deno.json"));
    assertEquals(Object.keys(ws.imports), ["@acme/ui"]);
    assertEquals(await memberDirs(dir, "x/**/y"), []);
    assertEquals(await memberDirs(dir, "nowhere/*"), []);
    // The root itself an app: its members, and no root imports to add.
    const root = await tree({
      "deno.json": { workspace: ["./packages/ui"], imports: { a: "./a.ts" } },
      "packages/ui/deno.json": { name: "@acme/ui", exports: { ".": "./mod.ts" } },
    });
    try {
      assertEquals(Object.keys((await workspaceImports(join(root, "deno.json"))).imports), [
        "@acme/ui",
      ]);
    } finally {
      await removeTempDir(root);
    }
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("workspaceImports: an app the workspace doesn't list, and no workspace at all", async () => {
  const dir = await tree({
    "deno.json": { workspace: ["./packages/ui"] },
    "apps/web/deno.json": {},
    "packages/ui/deno.json": { name: "@acme/ui", exports: "./mod.ts" },
    "solo/deno.json": {},
  });
  try {
    // Deno runs an unlisted app on its own config; so does denext.
    assertEquals(await workspaceImports(join(dir, "apps/web/deno.json")), {
      imports: {},
      scopes: {},
    });
    assertEquals(await workspaceMemberDirs(join(dir, "apps/web")), []);
    assertEquals(workspaceMembers(null), null);
    assertEquals(workspaceMembers({ workspace: "nope" }), null);
  } finally {
    await removeTempDir(dir);
  }
  const lone = await tree({ "deno.json": { imports: {} } });
  try {
    assertEquals((await workspaceImports(join(lone, "deno.json"))).imports, {});
  } finally {
    await removeTempDir(lone);
  }
});

Deno.test("workspaceApps / workspaceRootHint: name the apps of a workspace root", async () => {
  const dir = await tree({
    "deno.json": { workspace: ["./apps/web", "./apps/admin", "./packages/ui"] },
    "apps/web/app/page.tsx": "export default () => null;\n",
    "apps/admin/src/app/page.tsx": "export default () => null;\n",
    "packages/ui/deno.json": {},
  });
  try {
    assertEquals(await workspaceApps(dir), ["apps/web", "apps/admin"]);
    assertEquals(await workspacePackageDirs(join(dir, "apps/web")), [join(dir, "packages/ui")]);
    const hint = await workspaceRootHint(dir);
    assertStringIncludes(hint!, "its denext apps are apps/web, apps/admin");
    assertStringIncludes(hint!, "`denext dev apps/web`");
    assertEquals(await workspaceRootHint(join(dir, "apps/web")), null);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("workspaceVerbTarget: a monorepo root stands for its one app; several are named", async () => {
  const dir = await tree({
    "deno.json": { workspace: ["./apps/*", "./packages/ui"] },
    // An SPA member: no app/ folder, a denext.config.ts.
    "apps/web/denext.config.ts": "export default { mode: 'spa' };\n",
    "apps/web/capacitor.config.ts": "export default {};\n",
    "packages/ui/deno.json": { name: "@x/ui", exports: "./mod.ts" },
  });
  try {
    const command = "denext ui";
    assertEquals(await workspaceVerbTarget(dir, { command }), {
      dir: join(dir, "apps/web"),
      app: "apps/web",
    });
    // An app itself, a package and a plain directory run where they are.
    for (const own of [join(dir, "apps/web"), join(dir, "packages/ui"), join(dir, "apps")]) {
      assertEquals(await workspaceVerbTarget(own, { command }), { dir: own });
    }
    await Deno.mkdir(join(dir, "apps/admin/app"), { recursive: true });
    await Deno.writeTextFile(join(dir, "apps/admin/deno.json"), "{}");
    const several = await workspaceVerbTarget(dir, { command });
    assert("error" in several);
    assertStringIncludes(several.error, "several apps (apps/admin, apps/web)");
    assertStringIncludes(several.error, "`denext ui --cwd apps/admin`");
    // A verb for one kind of member (Capacitor shells) still finds the only one.
    const capacitor = (d: string) =>
      Deno.stat(join(d, "capacitor.config.ts")).then(() => true, () => false);
    assertEquals(
      await workspaceVerbTarget(dir, {
        command: "denext mobile",
        accepts: capacitor,
        dirFlag: "--dir",
      }),
      { dir: join(dir, "apps/web"), app: "apps/web" },
    );
    // A root that is an app of its own keeps the verb.
    await Deno.mkdir(join(dir, "app"));
    assertEquals(await workspaceVerbTarget(dir, { command }), { dir });
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("uiTargetOptions: denext ui at a monorepo root serves its app", async () => {
  const dir = await tree({
    "deno.json": { workspace: ["./apps/web", "./packages/ui"] },
    "apps/web/app/page.tsx": "export default () => null;\n",
    "packages/ui/deno.json": { name: "@x/ui", exports: "./mod.ts" },
  });
  try {
    const options = { dir, port: 0, signal: new AbortController().signal };
    assertEquals((await uiTargetOptions(options)).dir, join(dir, "apps/web"));
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("mergeModuleConfig: the workspace sits between the framework's map and the app's", () => {
  const merged = mergeModuleConfig(
    { a: "fw-a", b: "fw-b" },
    { b: "app-b" },
    {},
    { imports: { a: "ws-a", b: "ws-b", c: "ws-c" }, scopes: { "file:///p/": { d: "x" } } },
  );
  assertEquals(merged.imports, { a: "ws-a", b: "app-b", c: "ws-c" });
  assertEquals(merged.scopes, { "file:///p/": { d: "x" } });
  assertEquals(mergeModuleConfig({}, {}, {}).scopes, undefined);
});

Deno.test("writeMergedModuleConfig: the re-exec config resolves the workspace's packages", async () => {
  const dir = await tree(MONOREPO);
  try {
    const fw = join(dir, "fw.json");
    await Deno.writeTextFile(fw, JSON.stringify({ imports: { "@std/path": "jsr:@std/path@^1" } }));
    const path = await writeMergedModuleConfig(
      join(dir, "apps/web/.denext"),
      join(dir, "apps/web/deno.json"),
      fw,
    );
    const merged = JSON.parse(await Deno.readTextFile(path));
    assertEquals(merged.imports["@acme/ui"], toFileUrl(join(dir, "packages/ui/mod.ts")).href);
    assertEquals(merged.imports["@std/path"], "jsr:@std/path@^1");
    assert(merged.scopes[`${toFileUrl(join(dir, "packages/ui")).href}/`]);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("readImportAliases: a workspace package is a local alias of the app's", async () => {
  const dir = await tree(MONOREPO);
  try {
    const aliases = new Map(await readImportAliases(join(dir, "apps/web")));
    assertEquals(aliases.get("@acme/ui"), toFileUrl(join(dir, "packages/ui/mod.ts")).href);
    assertEquals(aliases.get("@root/"), `${toFileUrl(join(dir, "lib")).href}/`);
    assertEquals(aliases.has("zod"), false); // a registry package, not a file
    assertEquals(aliases.get("~/"), `${toFileUrl(join(dir, "apps/web")).href}/`); // the app's own
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("dev loop: a workspace package's modules are first-party (@fs), not bare", async () => {
  const dir = await tree(MONOREPO);
  try {
    const web = join(dir, "apps/web");
    const st = createUnbundledState({
      projectDir: web,
      appDir: join(web, "app"),
      configPath: join(web, "deno.json"),
      outDir: join(web, ".denext"),
    });
    const page = join(web, "app/page.tsx");
    assertEquals(
      await resolveFirstParty(st, "@acme/ui", page),
      norm(join(dir, "packages/ui/mod.ts")),
    );
    assertEquals(
      await resolveFirstParty(st, "@acme/ui/button", page),
      norm(join(dir, "packages/ui/button.ts")),
    );
    // The deno-loader config the dev loop bundles through carries them too.
    const merged = JSON.parse(await Deno.readTextFile(await ensureMergedConfig(st)));
    assertEquals(merged.imports["@acme/ui"], toFileUrl(join(dir, "packages/ui/mod.ts")).href);
    assert(merged.scopes);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("dev copies: an edit in a workspace package reaches the app's render", async () => {
  const dir = await tree({
    ...MONOREPO,
    "apps/web/deno.json": { imports: {} },
    "apps/web/app/page.ts":
      `import { Button } from "@acme/ui";\nexport const text = () => Button;\n`,
  });
  try {
    const web = join(dir, "apps/web");
    const dev = new DevCopies(web);
    const load = (n: number) => {
      const [loader] = createUseCacheLoaders([(u) => import(u)], {
        projectDir: web,
        cacheDir: join(web, ".denext", "server-cache", `dev${n}`),
        dev,
      });
      return loader(join(web, "app/page.ts")) as Promise<{ text: () => string }>;
    };
    // Nothing edited, the page loads as itself (Deno resolves `@acme/ui` through the workspace;
    // this test's process can't). Edited, every module on the way to the edit is a copy, the
    // package's included, and the copies import each other by URL.
    const button = join(dir, "packages/ui/button.ts");
    await Deno.writeTextFile(button, `export const label = "TWO";\n`);
    dev.markEdited([button]);
    assertEquals((await load(1)).text(), "TWO");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("CSS config: a package's stylesheet export maps straight to its shim", async () => {
  const dir = await tree({
    ...MONOREPO,
    "deno.json": { workspace: ["./apps/web", "./packages/ui", "./apps/admin"] },
    // A sibling app's stylesheet (a Tailwind input lightningcss can't read) is not the app's.
    "apps/admin/app/page.tsx": "export default () => null;\n",
    "apps/admin/styles/tailwind.css": '@import "tailwindcss";\n',
    "apps/web/app/layout.tsx": `import "@acme/ui/styles.css";\nexport default () => null;\n`,
  });
  try {
    const web = join(dir, "apps/web");
    // No entry files, as the CLI's CSS re-exec builds it: the walk covers the packages.
    const css = await buildAppCss({
      projectDir: web,
      configPath: join(web, "deno.json"),
      outDir: join(web, ".denext"),
    });
    assert(css, "the package's stylesheet was found");
    const config = JSON.parse(await Deno.readTextFile(css.configPath));
    const file = toFileUrl(join(dir, "packages/ui/styles.css")).href;
    assert(config.imports[file], JSON.stringify(config.imports));
    assertEquals(config.imports["@acme/ui/styles.css"], config.imports[file]);
    assertEquals(config.imports["@acme/ui"], toFileUrl(join(dir, "packages/ui/mod.ts")).href);
    assert(!css.cssFiles.some((f) => f.includes("admin")), css.cssFiles.join(", "));
  } finally {
    await removeTempDir(dir);
  }
});
