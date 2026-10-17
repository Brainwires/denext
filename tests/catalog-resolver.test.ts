// Unit tests for the pnpm catalog/workspace resolver's pure logic (used by SPA
// mode's compat path to resolve `catalog:`/`workspace:*` packages the esbuild
// deno-loader can't). The full node-modules walk is exercised end-to-end by the
// T3 apps/web build; here we pin the specifier-split + exports-map resolution.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  catalogResolverPlugin,
  resolveExportsField,
  splitPackageSpecifier,
} from "../src/build/next-compat.ts";

Deno.test("splitPackageSpecifier: scoped, unscoped, root, subpath", () => {
  assertEquals(splitPackageSpecifier("effect"), ["effect", ""]);
  assertEquals(splitPackageSpecifier("effect/Array"), ["effect", "/Array"]);
  assertEquals(splitPackageSpecifier("@t3tools/shared"), ["@t3tools/shared", ""]);
  assertEquals(splitPackageSpecifier("@t3tools/shared/devProxy"), ["@t3tools/shared", "/devProxy"]);
  assertEquals(splitPackageSpecifier("@clerk/shared/internal/x"), ["@clerk/shared", "/internal/x"]);
});

Deno.test("resolveExportsField: string exports (root only)", () => {
  assertEquals(resolveExportsField("./index.js", ""), "./index.js");
  assertEquals(resolveExportsField("./index.js", "/sub"), null);
});

Deno.test("resolveExportsField: conditions object for root, browser>import>default", () => {
  const exp = { browser: "./b.js", import: "./i.js", require: "./r.js", default: "./d.js" };
  assertEquals(resolveExportsField(exp, ""), "./b.js");
  assertEquals(resolveExportsField({ import: "./i.js", default: "./d.js" }, ""), "./i.js");
  assertEquals(resolveExportsField({ require: "./r.js", default: "./d.js" }, ""), "./d.js");
});

Deno.test("resolveExportsField: SSR conditions are CJS-first (tslib dual-package hazard)", () => {
  // The SSR bundle passes CJS-first conditions so a CJS consumer gets a usable default
  // export. tslib's real shape: its `import` build is ESM with no default; only its
  // `default` (CJS `tslib.js`) has the `__extends`-carrying default a CJS require needs.
  const ssr = ["node", "require", "default", "import", "module"];
  const tslib = {
    module: "./tslib.es6.mjs",
    import: { node: "./modules/index.js", default: "./tslib.es6.mjs" },
    default: "./tslib.js",
  };
  // CJS-first → the CJS build (has the default). Browser/ESM-first would pick the
  // no-default `import` build and break `tslib.default.__extends`.
  assertEquals(resolveExportsField(tslib, "", ssr), "./tslib.js");
  assertEquals(resolveExportsField(tslib, ""), "./tslib.es6.mjs"); // default (browser) order → import/module
  // A pure-ESM package (only `import`) still resolves under SSR conditions (fallback).
  assertEquals(resolveExportsField({ import: "./esm.js" }, "", ssr), "./esm.js");
});

Deno.test("resolveExportsField: subpath map with nested conditions", () => {
  const exp = {
    ".": { import: "./esm/index.js", require: "./cjs/index.js" },
    "./Array": { import: "./esm/Array.js" },
  };
  assertEquals(resolveExportsField(exp, ""), "./esm/index.js");
  assertEquals(resolveExportsField(exp, "/Array"), "./esm/Array.js");
  assertEquals(resolveExportsField(exp, "/Missing"), null);
});

Deno.test("resolveExportsField: ./* wildcard subpath", () => {
  const exp = { "./*": { import: "./dist/esm/*.js" } };
  assertEquals(resolveExportsField(exp, "/Effect"), "./dist/esm/Effect.js");
  assertEquals(resolveExportsField(exp, "/internal/foo"), "./dist/esm/internal/foo.js");
});

Deno.test("resolveExportsField: exact key wins over wildcard", () => {
  const exp = { "./special": "./special.js", "./*": "./dist/*.js" };
  assertEquals(resolveExportsField(exp, "/special"), "./special.js");
  assertEquals(resolveExportsField(exp, "/other"), "./dist/other.js");
});

// ---------------------------------------------------------------------------------------------
// The plugin itself, driven through a stub esbuild `build`: which bare specifiers it claims.

/** A package at `dir` with a CommonJS `index.js`. */
async function pkg(dir: string, name: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
  await Deno.writeTextFile(join(dir, "index.js"), "module.exports = {};\n");
}

/** The plugin's onResolve callback for `packages` (a stub build collects it). */
function resolver(projectDir: string, packages: Set<string> | "all") {
  let cb: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  catalogResolverPlugin(projectDir, packages).setup({
    onResolve: (_o: unknown, fn: typeof cb) => void (cb = fn),
    onLoad: () => {},
  } as never);
  return async (spec: string, importer: string) => {
    const out = await cb!({ path: spec, importer, namespace: "file", kind: "import-statement" });
    return (out as { path?: string } | null)?.path ?? null;
  };
}

Deno.test("catalogResolverPlugin (narrow): app code's non-catalog imports fall through to the deno-loader", async () => {
  // A monorepo: the app at <root>/app, a workspace package beside it and one nested inside it.
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-catalog-" }));
  const app = join(root, "app");
  try {
    await Deno.mkdir(join(app, "src"), { recursive: true });
    await Deno.writeTextFile(join(app, "package.json"), JSON.stringify({ name: "app" }));
    await pkg(join(app, "node_modules", "effect"), "effect"); // a catalog: dep
    await pkg(join(app, "node_modules", "zod"), "zod"); // an ordinary dep (import map / npm:)
    await pkg(join(app, "node_modules", "fast-check"), "fast-check"); // effect's own dep
    await pkg(join(root, "shared"), "@acme/shared"); // a workspace package outside the app
    await pkg(join(root, "shared", "node_modules", "nanoid"), "nanoid");
    await pkg(join(app, "packages", "ui"), "@acme/ui"); // a workspace package inside the app
    await pkg(join(app, "packages", "ui", "node_modules", "clsx"), "clsx");
    const narrow = resolver(app, new Set(["effect", "@acme/shared"]));
    const appFile = join(app, "src", "main.ts");

    // The catalog set resolves from the app's node_modules…
    assertEquals(await narrow("effect", appFile), join(app, "node_modules", "effect", "index.js"));
    // …and nothing else app code imports: that is the deno-loader's (the import map, npm:).
    assertEquals(await narrow("zod", appFile), null);
    assertEquals(await narrow("npm:zod@3", appFile), null);
    // A catalog package's own dependencies resolve importer-relative (its subtree).
    const effectFile = join(app, "node_modules", "effect", "index.js");
    assertEquals(
      await narrow("fast-check", effectFile),
      join(app, "node_modules", "fast-check", "index.js"),
    );
    // A workspace package's raw source resolves its own local deps, inside or outside the app.
    assertEquals(
      await narrow("nanoid", join(root, "shared", "index.js")),
      join(root, "shared", "node_modules", "nanoid", "index.js"),
    );
    assertEquals(
      await narrow("clsx", join(app, "packages", "ui", "index.js")),
      join(app, "packages", "ui", "node_modules", "clsx", "index.js"),
    );
    // …and a catalog name from anywhere outside node_modules still resolves from the app root.
    assertEquals(
      await narrow("effect", join(root, "shared", "index.js")),
      join(app, "node_modules", "effect", "index.js"),
    );

    // `"all"` (nodeResolve, the default) still claims every bare specifier it can find.
    const all = resolver(app, "all");
    assertEquals(await all("zod", appFile), join(app, "node_modules", "zod", "index.js"));
    assertEquals(await all("npm:zod@3", appFile), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
