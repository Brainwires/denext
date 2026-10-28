// `"use client"` / `"use server"` files INSIDE npm packages (src/build/npm-boundary.ts): a Server
// Component importing a library's client components straight from the package (`@clerk/nextjs`'s
// `ClerkProvider`, `Show`, `SignInButton`) gets them as islands, and their action modules as
// server references — resolved the way the next-compat SERVER bundle resolves packages (its CJS
// build), so the islands are the very modules that bundle renders.

import { assert, assertEquals } from "@std/assert";
import { join, resolve, toFileUrl } from "@std/path";
import {
  importGraph,
  npmBoundaryByImporter,
  npmSpecifierToBare,
  packageNameOfPath,
} from "../src/build/npm-boundary.ts";
import { buildNextCompatModules } from "../src/build/next-compat-build.ts";
import { loadBundleRef } from "../src/build/next-compat-loader.ts";
import { stopNextCompat } from "../src/build/next-compat.ts";
import { defaultLoader } from "../src/server/mod.ts";
import {
  buildBoundaryManifest,
  npmBoundaryPackageNames,
  resetModuleGraphCache,
} from "../src/build/module-graph.ts";
import { compatModuleList } from "../src/build/pipeline-shared.ts";
import { removeTempDirSync } from "./helpers/temp.ts";
import { withSubstDrive } from "./helpers/subst-drive.ts";
import { watchTests } from "./helpers/watchdog.ts";
import "./helpers/esbuild-after-each.ts";

// Builds in this process: a stalled one fails its test instead of holding the CI job.
watchTests();

/** Write `files` (path → contents) under `root`. */
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/** A project with an app importing `ui-lib`, an npm package with an ESM and a CJS build. */
async function fixture(): Promise<string> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-npm-boundary-" }));
  const lib = "node_modules/ui-lib";
  await write(root, {
    "deno.json": "{}",
    "app/page.tsx": `import { Provider, helper } from "ui-lib";\nimport "./styles.css";\n` +
      `export default function Page() { return <Provider>{helper()}</Provider>; }\n`,
    "app/styles.css": "body{}",
    "app/island.tsx": `"use client";\nimport { Widget } from "ui-lib/widget";\n` +
      `export function Island() { return <Widget />; }\n`,
    [`${lib}/package.json`]: JSON.stringify({
      name: "ui-lib",
      exports: {
        ".": { import: "./esm/index.js", require: "./cjs/index.js" },
        "./widget": { import: "./esm/widget.js", require: "./cjs/widget.js" },
      },
    }),
    // The ESM build: never what the SSR bundle picks (`require` first), so never recorded.
    [`${lib}/esm/index.js`]: `export { Provider } from "./provider.js";\n`,
    [`${lib}/esm/provider.js`]: `"use client";\nexport function Provider() {}\n`,
    [`${lib}/esm/widget.js`]: `"use client";\nexport function Widget() {}\n`,
    // The CJS build, as a bundler emits it: `"use strict"` before the directive.
    [`${lib}/cjs/index.js`]: `"use strict";\nconst react = require("react");\n` +
      `const { Provider } = require("./provider");\nconst { helper } = require("./helper");\n` +
      `module.exports = { Provider, helper };\n`,
    [`${lib}/cjs/provider.js`]: `"use strict";\n"use client";\nvar __export = () => {};\n` +
      `var exp = {};\n__export(exp, { Provider: () => Provider, useThing: () => useThing });\n` +
      `const { act } = require("./actions");\nconst { Inner } = require("./inner");\n` +
      `function Provider() { return Inner; }\nfunction useThing() { return act; }\n`,
    // A client file below the island: client code, not a second island.
    [`${lib}/cjs/inner.js`]: `"use strict";\n"use client";\nexports.Inner = function Inner() {};\n`,
    // The island's action module: found below the island.
    [`${lib}/cjs/actions.js`]:
      `"use strict";\n"use server";\nexports.act = async function act() {};\n`,
    [`${lib}/cjs/helper.js`]:
      `"use strict";\nrequire("next/navigation");\nexports.helper = () => 1;\n`,
    [`${lib}/cjs/widget.js`]:
      `"use strict";\n"use client";\nexports.Widget = function Widget() {};\n`,
  });
  return root;
}

Deno.test("npm boundary: islands and actions inside a package, via the SSR (CJS) build", async () => {
  const root = await fixture();
  try {
    const page = join(root, "app/page.tsx");
    const island = join(root, "app/island.tsx");
    const found = await npmBoundaryByImporter([page, island, join(root, "app/styles.css")]);
    const cjs = join(root, "node_modules/ui-lib/cjs");
    // The page reaches the provider island (not the nested client file) and, below it, the
    // action module; the ESM build is never walked; `react` / `next/*` are not walked.
    assertEquals(found.get(page), {
      client: [join(cjs, "provider.js")],
      server: [join(cjs, "actions.js")],
      packages: ["ui-lib"],
    });
    // A local client island's npm imports are client code: no islands of their own.
    assertEquals(found.get(island), { client: [], server: [], packages: [] });
    assertEquals(found.get(join(root, "app/styles.css")), { client: [], server: [], packages: [] });
  } finally {
    removeTempDirSync(root);
  }
});

Deno.test("npm boundary: the boundary manifest adds them only when asked (compat)", async () => {
  const root = await fixture();
  try {
    resetModuleGraphCache();
    const appDir = join(root, "app");
    const page = join(appDir, "page.tsx");
    const plain = await buildBoundaryManifest(appDir, [page]);
    assertEquals([...plain.client.values()].length, 0);
    assertEquals(npmBoundaryPackageNames(), []);
    resetModuleGraphCache();
    const bm = await buildBoundaryManifest(appDir, [page], { npm: npmBoundaryByImporter });
    // What the server bundle resolves from node_modules under `nodeResolve: false`.
    assertEquals(npmBoundaryPackageNames(), ["ui-lib"]);
    const provider = toFileUrl(join(root, "node_modules/ui-lib/cjs/provider.js")).href;
    const client = [...bm.client.values()].find((r) => r.url === provider);
    assert(client, "the npm island is in the manifest");
    // Export names read statically from the CJS build (it cannot be imported under Deno).
    assertEquals(client.exports.sort(), ["Provider", "useThing"]);
    const action = [...bm.server.values()].find((r) => r.url.endsWith("/cjs/actions.js"));
    assertEquals(action?.exports, ["act"]);
  } finally {
    resetModuleGraphCache();
    removeTempDirSync(root);
  }
});

Deno.test("npm boundary: an unbuildable graph answers nothing (the app's own boundary stands)", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-npm-boundary-" }));
  try {
    const page = join(root, "page.tsx");
    await Deno.writeTextFile(page, "export default function P( { return 1 }\n"); // syntax error
    assertEquals((await npmBoundaryByImporter([page])).get(page), {
      client: [],
      server: [],
      packages: [],
    });
    assertEquals((await npmBoundaryByImporter([])).size, 0);
  } finally {
    removeTempDirSync(root);
  }
});

// A build run from one Windows drive over files on another: esbuild has no relative form for them,
// so its metafile names them absolutely (`C:/…`). That colon is the drive's, not a plugin
// namespace's — the walk skipped every such module, so a project on another drive than the working
// directory reached no npm island at all. Plain strings: this runs on every OS.
Deno.test("importGraph: a file on another drive (absolute in the metafile) is walked, a namespace is not", () => {
  const root = "D:/work";
  const page = "C:/app/page.tsx";
  const lib = "C:/app/node_modules/ui-lib/cjs/index.js";
  const graph = importGraph({
    inputs: {
      [page]: { bytes: 1, imports: [{ path: lib, kind: "import-statement" }] },
      [lib]: {
        bytes: 1,
        imports: [
          { path: "C:\\app\\node_modules\\ui-lib\\cjs\\provider.js", kind: "require-call" },
          { path: "react", kind: "require-call", external: true },
          { path: "denext-empty:x.css", kind: "import-statement" },
        ],
      },
      "src/local.ts": { bytes: 1, imports: [] },
      "denext-empty:x.css": { bytes: 1, imports: [] },
    },
    outputs: {},
  }, root);
  assertEquals([...graph.keys()], [page, lib, "src/local.ts"].map((p) => resolve(root, p)));
  assertEquals(graph.get(resolve(root, page)), [resolve(root, lib)]);
  assertEquals(graph.get(resolve(root, lib)), [
    resolve(root, "C:\\app\\node_modules\\ui-lib\\cjs\\provider.js"),
  ]);
});

Deno.test({
  name: "npm boundary: a project on another drive than the working directory (subst) is walked",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const root = await fixture();
    try {
      await withSubstDrive(root, async (drive) => {
        const page = join(drive, "app/page.tsx");
        const cjs = join(drive, "node_modules/ui-lib/cjs");
        const found = await npmBoundaryByImporter([page]);
        // esbuild reports the package's files by their real path (the mapped drive's target).
        const real = (p: string) => Deno.realPath(p);
        assertEquals(found.get(page), {
          client: [await real(join(cjs, "provider.js"))],
          server: [await real(join(cjs, "actions.js"))],
          packages: ["ui-lib"],
        });
      });
    } finally {
      removeTempDirSync(root);
    }
  },
});

Deno.test("npmSpecifierToBare: import-map npm specifiers become package paths", () => {
  assertEquals(npmSpecifierToBare("npm:@clerk/nextjs@^7.9.8"), "@clerk/nextjs");
  assertEquals(npmSpecifierToBare("npm:@clerk/nextjs@^7.9.8/server"), "@clerk/nextjs/server");
  assertEquals(npmSpecifierToBare("npm:react@19/jsx-runtime"), "react/jsx-runtime");
  assertEquals(npmSpecifierToBare("npm:/lodash@4/fp"), "lodash/fp");
});

Deno.test("compatModuleList: middleware.ts is bundled with the routes (compat)", () => {
  const page = {
    kind: "page" as const,
    pattern: [],
    routePath: "/",
    filePath: "/app/page.tsx",
    layoutChain: ["/app/layout.tsx"],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  // deno-lint-ignore no-explicit-any
  const list = compatModuleList([page as any], null, [], "/middleware.ts");
  assert(list.includes("/middleware.ts"));
  // deno-lint-ignore no-explicit-any
  assert(!compatModuleList([page as any], null, []).includes("/middleware.ts"));
});

Deno.test("serverStubPlugin: an npm `use server` file outside the boundary never ships", async () => {
  const esbuild = await import("../src/build/esbuild/mod.ts");
  const { serverStubPlugin } = await import("../src/build/next-compat.ts");
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-npm-stub-" }));
  try {
    await write(root, {
      // The package's OTHER build of its action module (the boundary holds the CJS one).
      "node_modules/ui-lib/esm/actions.js": `"use server";\nconst SECRET = "db-password";\n` +
        `export async function act() { return SECRET; }\n`,
      "entry.js": `import { act } from "./node_modules/ui-lib/esm/actions.js";\nexport { act };\n`,
    });
    const stubs: string[] = [];
    const out = await esbuild.build({
      entryPoints: [join(root, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      absWorkingDir: root,
      external: ["denext/client-runtime"],
      plugins: [serverStubPlugin([], (id, names) => {
        stubs.push(`${id} ${names.join(",")}`);
        return `export const act = "stub:${id}";`;
      })],
    });
    const code = out.outputFiles[0].text;
    assert(!code.includes("db-password"), "the server code is stubbed out");
    assertEquals(stubs, ["unregistered:ui-lib/esm/actions.js act"]);
  } finally {
    await (await import("../src/build/esbuild/mod.ts")).stop();
    removeTempDirSync(root);
  }
});

Deno.test("packageNameOfPath: the package a node_modules file belongs to", () => {
  assertEquals(packageNameOfPath("/a/node_modules/ui-lib/cjs/x.js"), "ui-lib");
  assertEquals(packageNameOfPath("/a/node_modules/@s/p/x.js"), "@s/p");
  assertEquals(
    packageNameOfPath("/a/node_modules/.pnpm/p@1/node_modules/@s/p/dist/x.js"),
    "@s/p",
  );
  assertEquals(packageNameOfPath("C:\\a\\node_modules\\ui-lib\\x.js"), "ui-lib");
  assertEquals(packageNameOfPath("/a/src/x.js"), null);
});

Deno.test({
  name: "npm boundary, nodeResolve: false: the server bundle's island is the walk's module",
}, async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-npm-boundary-nr-" }));
  try {
    const lib = "node_modules/ui-lib";
    await write(root, {
      // Deno resolves the package itself (no `nodeResolve`): through package.json into
      // node_modules, with Deno's conditions (`import` first → the ESM build).
      "deno.json": JSON.stringify({ nodeModulesDir: "manual", imports: {} }),
      "package.json": JSON.stringify({ name: "app", dependencies: { "ui-lib": "1.0.0" } }),
      "app/page.tsx":
        `export { Provider } from "ui-lib";\nexport default function Page() { return null; }\n`,
      [`${lib}/package.json`]: JSON.stringify({
        name: "ui-lib",
        version: "1.0.0",
        exports: { ".": { import: "./esm/index.js", require: "./cjs/index.js" } },
      }),
      [`${lib}/esm/index.js`]: `"use client";\nexport function Provider() { return "esm"; }\n`,
      [`${lib}/cjs/index.js`]: `"use strict";\n"use client";\n` +
        `exports.Provider = function Provider() { return "cjs"; };\n`,
    });
    const page = join(root, "app/page.tsx");
    const found = (await npmBoundaryByImporter([page])).get(page)!;
    const island = join(root, lib, "cjs/index.js");
    assertEquals(found.client, [island]);
    assertEquals(found.packages, ["ui-lib"]);
    const moduleMap = await buildNextCompatModules({
      projectDir: root,
      configPath: join(root, "deno.json"),
      outDir: join(root, ".denext"),
      modules: [page, island],
      resolveAllNodeModules: false,
      boundaryPackages: found.packages,
    });
    type Mod = { Provider: () => string };
    const fromPage = await loadBundleRef(defaultLoader, moduleMap.get(page)!) as Mod;
    const fromIsland = await loadBundleRef(defaultLoader, moduleMap.get(island)!) as Mod;
    // One module: the page's `Provider` IS the registered island's (so it renders as one).
    assertEquals(fromPage.Provider(), "cjs");
    assert(fromPage.Provider === fromIsland.Provider, "the page imports the island module");
  } finally {
    await stopNextCompat().catch(() => {});
    removeTempDirSync(root);
  }
});
