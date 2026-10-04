// `react/compiler-runtime` resolves to denext. npm libraries precompiled with the React Compiler
// import the memo-cache hook as `c` from it; without an alias that loaded real React's compiler
// runtime, a second React whose dispatcher is never installed. Each test builds a library in
// node_modules in the compiler's output shape (inline sentinel checks against
// `Symbol.for("react.memo_cache_sentinel")`) and renders it through one alias path: the
// next-compat drop-in's SSR bundle (externals into the framework source) and a compat SPA bundle
// (the prebuilt shared runtime). The specifier tables themselves are guarded by
// tests/react-specifiers.test.ts; the codemod's rewrite by tests/codemod.test.ts.

import { assert, assertEquals, assertStrictEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { buildNextCompatModules } from "../src/build/next-compat-build.ts";
import { loadBundleRef } from "../src/build/next-compat-loader.ts";
import { stopNextCompat } from "../src/build/next-compat.ts";
import { bundleSpaInto } from "../src/build/spa/bundle.ts";
import { resolveProject } from "../src/build/paths.ts";
import { defaultLoader } from "../src/server/mod.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { useMemoCache } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";

const ROOT = new URL("../", import.meta.url);

/**
 * A library as the React Compiler emits it for production: a constant subtree cached behind a
 * sentinel check, and the output cached on its one reactive input.
 */
const COMPILED_LIBRARY = `import { c as _c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
export function Greeting(t0) {
  const $ = _c(4);
  const { name } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = jsx("span", { children: "COMPILED_CONST" });
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== name || $[2] !== t1) {
    t2 = jsxs("p", { children: ["Hello ", name, t1] });
    $[1] = name;
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  return t2;
}
`;

/** Write the compiled library to `<dir>/node_modules/compiled-greeting`. */
async function writeCompiledLibrary(dir: string): Promise<void> {
  const pkg = join(dir, "node_modules", "compiled-greeting");
  await Deno.mkdir(pkg, { recursive: true });
  await Deno.writeTextFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "compiled-greeting",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./index.js" },
      peerDependencies: { react: "^19" },
    }),
  );
  await Deno.writeTextFile(join(pkg, "index.js"), COMPILED_LIBRARY);
}

Deno.test("react/compiler-runtime entry: exactly React's surface, `c`, on denext's useMemoCache", async () => {
  // react@19.3.0's `react/compiler-runtime` exports only `c` (the memo-cache hook).
  const mod = await import("../src/compat/react-compiler-runtime.ts");
  assertEquals(Object.keys(mod), ["c"]);
  assertStrictEquals(mod.c, useMemoCache);
  const exportsMap = JSON.parse(await Deno.readTextFile(new URL("deno.json", ROOT))).exports;
  assertEquals(
    exportsMap["./react/compiler-runtime"],
    "./src/compat/react-compiler-runtime.ts",
    "the JSR subpath migrate/scaffold import maps point react/compiler-runtime at",
  );
});

Deno.test({
  name: "next-compat drop-in: a React-Compiler-precompiled library in node_modules renders on SSR",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_compiler_rt_nc_" }));
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ nodeModulesDir: "manual", imports: {} }),
    );
    // A migrated app's layout: package.json dependencies installed into node_modules.
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "compiled-greeting": "1.0.0" } }),
    );
    await writeCompiledLibrary(dir);
    await Deno.mkdir(join(dir, "app"));
    const pagePath = join(dir, "app", "page.tsx");
    await Deno.writeTextFile(
      pagePath,
      `import { createElement as h } from "react";
import { Greeting } from "compiled-greeting";
export default function Page() {
  return h("main", null, h(Greeting, { name: "denext" }));
}
`,
    );
    const moduleMap = await buildNextCompatModules({
      projectDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
      modules: [pagePath],
    });
    const ref = moduleMap.get(pagePath);
    assert(ref, "the page has a compat bundle");
    const page = await loadBundleRef(defaultLoader, ref) as { default: () => VNode };
    // The bundle's `c` is the framework's own module, so it runs on the renderer's dispatcher;
    // a second React's `c` would throw (no dispatcher), and a mismatched sentinel would render
    // the sentinel symbol instead of the constant subtree.
    assertEquals(
      await renderToString(page.default()),
      "<main><p>Hello denext<span>COMPILED_CONST</span></p></main>",
    );
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** Point the bundle's absolute `/_denext/client/` chunk URLs at the output dir itself. */
async function localizeChunks(clientDir: string): Promise<void> {
  for await (const entry of Deno.readDir(clientDir)) {
    if (!entry.name.endsWith(".js")) continue;
    const file = join(clientDir, entry.name);
    const text = await Deno.readTextFile(file);
    await Deno.writeTextFile(file, text.replaceAll('"/_denext/client/', '"./'));
  }
}

Deno.test({
  name:
    "compat SPA build: a React-Compiler-precompiled library resolves to the shared prebuilt runtime",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_compiler_rt_spa_" }));
  try {
    await writeCompiledLibrary(dir);
    await Deno.mkdir(join(dir, "src"));
    // Renders through react-dom/server — another prebuilt entry — so the library's `c` must share
    // its hook dispatcher: one runtime instance, or the call has no dispatcher to reach.
    await Deno.writeTextFile(
      join(dir, "src", "main.tsx"),
      `import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Greeting } from "compiled-greeting";
console.log("html:" + renderToString(h(Greeting, { name: "spa" })));
`,
    );
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { mode: "spa", compatibilityMode: true, spa: { entry: "./src/main.tsx" } };\n`,
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": new URL("mod.ts", ROOT).href,
          "denext/jsx-runtime": new URL("src/jsx/jsx-runtime.ts", ROOT).href,
          "denext/client": new URL("src/client/mod.ts", ROOT).href,
          "denext/class-runtime": new URL("src/class-runtime.ts", ROOT).href,
        },
      }),
    );
    const paths = await resolveProject(dir);
    const clientDir = join(dir, "out");
    await Deno.mkdir(clientDir);
    await bundleSpaInto(paths, join(dir, "src", "main.tsx"), clientDir, false);
    let all = "";
    for await (const e of Deno.readDir(clientDir)) {
      if (e.isFile && e.name.endsWith(".js")) {
        all += await Deno.readTextFile(join(clientDir, e.name));
      }
    }
    assert(
      !all.includes("__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"),
      "no real React compiler runtime in the bundle",
    );
    await localizeChunks(clientDir);
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", toFileUrl(join(clientDir, "index.js")).href],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(run.stdout);
    assertStringIncludes(
      out,
      "html:<p>Hello spa<span>COMPILED_CONST</span></p>",
      new TextDecoder().decode(run.stderr),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
