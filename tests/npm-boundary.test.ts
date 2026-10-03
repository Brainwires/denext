// `"use client"` / `"use server"` files INSIDE npm packages (src/build/npm-boundary.ts): a Server
// Component importing a library's client components straight from the package (`@clerk/nextjs`'s
// `ClerkProvider`, `Show`, `SignInButton`) gets them as islands, and their action modules as
// server references — resolved the way the next-compat SERVER bundle resolves packages (its CJS
// build), so the islands are the very modules that bundle renders.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { npmBoundaryByImporter, npmSpecifierToBare } from "../src/build/npm-boundary.ts";
import { buildBoundaryManifest, resetModuleGraphCache } from "../src/build/module-graph.ts";
import { compatModuleList } from "../src/build/pipeline-shared.ts";
import { removeTempDirSync } from "./helpers/temp.ts";

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
    });
    // A local client island's npm imports are client code: no islands of their own.
    assertEquals(found.get(island), { client: [], server: [] });
    assertEquals(found.get(join(root, "app/styles.css")), { client: [], server: [] });
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
    resetModuleGraphCache();
    const bm = await buildBoundaryManifest(appDir, [page], { npm: npmBoundaryByImporter });
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
    assertEquals((await npmBoundaryByImporter([page])).get(page), { client: [], server: [] });
    assertEquals((await npmBoundaryByImporter([])).size, 0);
  } finally {
    removeTempDirSync(root);
  }
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
  const esbuild = await import("esbuild");
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
    await (await import("esbuild")).stop();
    removeTempDirSync(root);
  }
});
