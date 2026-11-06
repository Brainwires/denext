// Package-dir resolution for the compat bundler: `exports` maps per condition set, the
// legacy `module`/`main` fallbacks (browser prefers ESM, SSR prefers the Node build),
// subpaths, and a dir without a package.json.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import {
  appResolverPlugin,
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
  resolveInPackageDir,
  SSR_CONDITIONS,
} from "../src/build/next-compat.ts";

async function pkg(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

Deno.test("resolveInPackageDir honors the exports map per condition set", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({
      exports: { ".": { browser: "./browser.js", node: "./node.js", default: "./index.js" } },
    }),
    "browser.js": "",
    "node.js": "",
    "index.js": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "browser.js")),
  );
  assertEquals(
    await resolveInPackageDir(dir, "", SSR_CONDITIONS),
    await Deno.realPath(join(dir, "node.js")),
  );
});

Deno.test("resolveInPackageDir: without exports the browser prefers module, SSR prefers main", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({ module: "./esm.mjs", main: "./cjs.cjs" }),
    "esm.mjs": "",
    "cjs.cjs": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "esm.mjs")),
  );
  assertEquals(
    await resolveInPackageDir(dir, "", SSR_CONDITIONS),
    await Deno.realPath(join(dir, "cjs.cjs")),
  );
});

Deno.test("resolveInPackageDir: a subpath probes extensions and index files; a missing file is null", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({ main: "index.js" }),
    "index.js": "",
    "util/index.ts": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "/util"),
    await Deno.realPath(join(dir, "util", "index.ts")),
  );
  assertEquals(await resolveInPackageDir(dir, "/nope"), null);
  assertEquals(await resolveInPackageDir(await Deno.makeTempDir(), ""), null, "no package.json");
});

// A broken `module` field (lucide 0.564: `dist/esm/lucide.js` is not in the tarball; rollup's
// preserveModules put the ESM entry at `dist/esm/lucide/src/lucide.js`). esbuild then falls back
// to the CJS `main`, which it cannot tree-shake: 379 KB of icons for four. The browser bundle
// tries the package's other ESM entries before CJS.

Deno.test("resolveInPackageDir: a missing `module` finds the preserved-modules ESM entry, not CJS", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({
      main: "dist/cjs/lucide.js",
      module: "dist/esm/lucide.js",
      source: "src/lucide.js",
      sideEffects: false,
    }),
    "dist/cjs/lucide.js": "module.exports = {};",
    "dist/esm/lucide/src/lucide.js": "export {};",
    "dist/esm/lucide/src/icons/a.js": "export {};",
    "dist/esm/shared/src/utils/x.js": "export {};",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "dist/esm/lucide/src/lucide.js")),
  );
  // Without a `source` field the same entry is found by its file name, one or two levels down.
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ main: "dist/cjs/lucide.js", module: "dist/esm/lucide.js" }),
  );
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "dist/esm/lucide/src/lucide.js")),
  );
  // SSR keeps preferring the Node build.
  assertEquals(
    await resolveInPackageDir(dir, "", SSR_CONDITIONS),
    await Deno.realPath(join(dir, "dist/cjs/lucide.js")),
  );
});

Deno.test("resolveInPackageDir: a missing `module` tries the legacy ESM fields, then `main`", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({
      main: "cjs/index.js",
      module: "esm/missing.js",
      "jsnext:main": "es/index.js",
    }),
    "cjs/index.js": "",
    "es/index.js": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "es/index.js")),
  );
  // No ESM candidate at all: the CJS `main`, rather than giving up on the package.
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ main: "cjs/index.js", module: "esm/missing.js" }),
  );
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "cjs/index.js")),
  );
});

Deno.test("resolveInPackageDir: two same-named ESM files are not guessed between", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({ main: "dist/cjs/pkg.js", module: "dist/esm/pkg.js" }),
    "dist/cjs/pkg.js": "",
    "dist/esm/a/pkg.js": "",
    "dist/esm/b/pkg.js": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "dist/cjs/pkg.js")),
  );
});

Deno.test("resolveInPackageDir: an `exports` target that is missing falls through to the next condition", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({
      exports: {
        ".": {
          browser: "./dist/browser.js",
          import: "./dist/index.mjs",
          require: "./dist/index.cjs",
        },
      },
    }),
    "dist/index.mjs": "",
    "dist/index.cjs": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "dist/index.mjs")),
  );
});

Deno.test("bundle: a lucide-shaped package (broken `module`) is tree-shaken from its ESM build", async () => {
  // The CJS build exports every icon from one object, which esbuild keeps whole; the ESM build's
  // unused icons are dropped. Resolved through the nodeResolve chain the compat bundles use.
  const dir = await pkg({
    "deno.json": "{}",
    "node_modules/icons/package.json": JSON.stringify({
      name: "icons",
      main: "dist/cjs/icons.js",
      module: "dist/esm/icons.js",
      sideEffects: false,
    }),
    "node_modules/icons/dist/cjs/icons.js": "exports.Used = () => 'USED_ICON';\n" +
      "exports.Unused = () => 'UNUSED_ICON';\n",
    "node_modules/icons/dist/esm/icons/src/icons.js":
      "export { Used } from './used.js';\nexport { Unused } from './unused.js';\n",
    "node_modules/icons/dist/esm/icons/src/used.js": "export const Used = () => 'USED_ICON';\n",
    "node_modules/icons/dist/esm/icons/src/unused.js":
      "export const Unused = () => 'UNUSED_ICON';\n",
    "main.js": "import { Used } from 'icons';\nconsole.log(Used());\n",
  });
  try {
    const result = await esbuild.build({
      entryPoints: [join(dir, "main.js")],
      bundle: true,
      format: "esm",
      write: false,
      logLevel: "silent",
      plugins: [appResolverPlugin(join(dir, "deno.json")), catalogResolverPlugin(dir, "all")],
    });
    const out = result.outputFiles[0].text;
    assert(out.includes("USED_ICON"), out);
    assert(!out.includes("UNUSED_ICON"), `the unused icon was bundled (CJS build?):\n${out}`);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("nodeResolve: an import-map alias to jsr:/a URL wins over the installed npm package", async () => {
  // `denext migrate` aliases `next-intl` to denext's compat module but leaves the npm package
  // installed; walking node_modules bundled the real next-intl (its react-client server build).
  const dir = await pkg({
    "deno.json": JSON.stringify({
      imports: {
        "next-intl": "jsr:@denext/denext@^4/next-intl",
        "next-intl/server": "jsr:@denext/denext@^4/next-intl/server",
        "server-only": "https://example.test/empty.ts",
        "pinned": "npm:pinned@1",
      },
    }),
    "node_modules/next-intl/package.json": JSON.stringify({ name: "next-intl", main: "i.js" }),
    "node_modules/next-intl/i.js": "export const real = 'NPM_NEXT_INTL';\n",
    "node_modules/next-intl/server.js": "export const real = 'NPM_NEXT_INTL_SERVER';\n",
    "node_modules/server-only/package.json": JSON.stringify({ name: "server-only" }),
    "node_modules/server-only/index.js": "throw new Error('NPM_SERVER_ONLY');\n",
    "node_modules/pinned/package.json": JSON.stringify({ name: "pinned", main: "p.js" }),
    "node_modules/pinned/p.js": "export const p = 'NPM_PINNED';\n",
    // A package's own import of an aliased name keeps Node resolution (Deno's import map does
    // not apply inside npm packages either).
    "node_modules/lib/package.json": JSON.stringify({ name: "lib", main: "l.js" }),
    "node_modules/lib/l.js": "export { real as viaLib } from 'next-intl';\n",
    "main.js":
      "import { real } from 'next-intl';\nimport { real as s } from 'next-intl/server';\n" +
      "import 'server-only';\nimport { p } from 'pinned';\nimport { viaLib } from 'lib';\n" +
      "console.log(real, s, p, viaLib);\n",
  });
  const deferred: string[] = [];
  try {
    const result = await esbuild.build({
      entryPoints: [join(dir, "main.js")],
      bundle: true,
      format: "esm",
      write: false,
      logLevel: "silent",
      plugins: [
        appResolverPlugin(join(dir, "deno.json")),
        catalogResolverPlugin(dir, "all", SSR_CONDITIONS, undefined, join(dir, "deno.json")),
        // Stands in for the deno-loader: records what reached it.
        {
          name: "loader-stand-in",
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              deferred.push(args.path);
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    const out = result.outputFiles[0].text;
    assertEquals(deferred.sort(), ["next-intl", "next-intl/server", "server-only"]);
    assert(out.includes("NPM_PINNED"), "an npm: alias still resolves from node_modules");
    assert(/NPM_NEXT_INTL["']/.test(out), "a package's own import keeps Node resolution");
    assert(!out.includes("NPM_SERVER_ONLY"), out);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
