import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  buildAppCss,
  concatCss,
  discoverCssFiles,
  extractRouteCss,
  generateCssAssets,
  isCss,
  isCssModule,
  isSass,
  isStyleFile,
  transformCss,
} from "../src/build/css.ts";

Deno.test("isCss / isCssModule / isSass / isStyleFile classify file names", () => {
  assert(isCss("a/b.css"));
  assert(isCss("a/b.module.css"));
  assert(!isCss("a/b.ts"));
  assert(!isCss("a/b.scss"));
  assert(isCssModule("a/b.module.css"));
  assert(isCssModule("a/b.module.scss"));
  assert(!isCssModule("a/b.css"));
  assert(isSass("a/b.scss"));
  assert(isSass("a/b.sass"));
  assert(!isSass("a/b.css"));
  assert(isStyleFile("a/b.css") && isStyleFile("a/b.scss") && isStyleFile("a/b.sass"));
  assert(!isStyleFile("a/b.ts"));
});

Deno.test("generateCssAssets compiles a .scss file to CSS through lightningcss", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scss_" });
  try {
    const scss = join(dir, "styles.scss");
    // Nesting + a variable — pure Sass syntax lightningcss alone can't handle.
    await Deno.writeTextFile(
      scss,
      "$c: red;\n.card { color: $c; .title { font-weight: bold; } }\n",
    );
    const shimDir = join(dir, "shims");
    await Deno.mkdir(shimDir, { recursive: true });
    const assets = await generateCssAssets([scss], shimDir);
    const css = assets.css.get(scss)!;
    assertStringIncludes(css, ".card");
    assertStringIncludes(css, ".card .title"); // nesting was flattened by sass
    assertStringIncludes(css, "red"); // the variable resolved
    // A global sheet gets an empty-object shim (side-effect import).
    assertStringIncludes(await Deno.readTextFile(join(shimDir, "css_0.js")), "export default {}");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateCssAssets scopes a .module.scss and exports the class map", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scssmod_" });
  try {
    const scss = join(dir, "x.module.scss");
    await Deno.writeTextFile(scss, ".title { .inner { color: green; } }\n");
    const shimDir = join(dir, "shims");
    await Deno.mkdir(shimDir, { recursive: true });
    const assets = await generateCssAssets([scss], shimDir);
    const map = assets.classMaps.get(scss)!;
    // The `title` local is scoped to a hashed name (CSS-module semantics on compiled Sass).
    assert(map.title && map.title !== "title", "title class is scoped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("transformCss scopes module classes + resolves composes", async () => {
  const { css, exports } = await transformCss(
    ".base { color: red } .card { composes: base; padding: 8px } :global(.util) { margin: 0 }",
    "styles.module.css",
    { cssModules: true },
  );
  // base and card are scoped; :global stays literal.
  assert(exports.base && exports.base !== "base", "base should be scoped");
  assertStringIncludes(exports.card, exports.base.split(" ")[0]); // card composes base
  assertStringIncludes(css, ".util"); // global class kept as-is
  assert(!css.includes(".base "), "raw local name should not appear un-scoped");
});

Deno.test("transformCss leaves a global stylesheet's class names intact", async () => {
  const { exports } = await transformCss(".btn { color: blue }", "globals.css", {
    cssModules: false,
  });
  assertEquals(exports, {}); // no scoping map for globals
});

Deno.test("discoverCssFiles finds css across the import graph", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_css_disc_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), `{ "imports": {} }\n`);
    await Deno.writeTextFile(join(dir, "a.module.css"), ".x { color: red }\n");
    await Deno.writeTextFile(join(dir, "globals.css"), "body { margin: 0 }\n");
    await Deno.writeTextFile(
      join(dir, "child.tsx"),
      `import "./globals.css";\nexport const y = 1;\n`,
    );
    await Deno.writeTextFile(
      join(dir, "page.tsx"),
      `import s from "./a.module.css";\nimport { y } from "./child.tsx";\nexport default function P() { return s.x + y; }\n`,
    );
    const found = await discoverCssFiles([join(dir, "page.tsx")]);
    assertEquals(found, [join(dir, "a.module.css"), join(dir, "globals.css")].sort());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateCssAssets writes shims + import map + extracted css", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_css_assets_" });
  const shimDir = join(dir, "shims");
  await Deno.mkdir(shimDir);
  try {
    const mod = join(dir, "a.module.css");
    const glob = join(dir, "g.css");
    await Deno.writeTextFile(mod, ".title { color: red }\n");
    await Deno.writeTextFile(glob, ".hero { padding: 0 }\n");

    const assets = await generateCssAssets([mod, glob], shimDir, { minify: true });

    // Import map redirects both css files to shim modules.
    assertEquals(Object.keys(assets.importMap).length, 2);
    // Module shim exports the scoped class map as default.
    const moduleShimUrl = assets.importMap[new URL(`file://${mod}`).href];
    const shimSrc = await Deno.readTextFile(new URL(moduleShimUrl));
    const scoped = assets.classMaps.get(mod)!.title;
    assert(scoped && scoped !== "title");
    assertStringIncludes(shimSrc, scoped);
    // Global shim exports {}.
    const globShimUrl = assets.importMap[new URL(`file://${glob}`).href];
    assertStringIncludes(await Deno.readTextFile(new URL(globShimUrl)), "export default {}");
    // Concatenated CSS contains both stylesheets' rules.
    const all = concatCss(assets.css);
    assertStringIncludes(all, "color:red");
    assertStringIncludes(all, "padding:0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildAppCss with entryFiles picks up a stylesheet outside projectDir", async () => {
  // A monorepo shape: the app dir and a sibling workspace package share a root, and
  // the app imports the sibling's `.scss`. The `projectDir` filesystem walk can't see
  // it (it's outside projectDir); the entry-graph crawl must.
  const root = await Deno.makeTempDir({ prefix: "denext_xpkg_" });
  const app = join(root, "app");
  const pkg = join(root, "packages", "ui");
  await Deno.mkdir(app, { recursive: true });
  await Deno.mkdir(pkg, { recursive: true });
  try {
    await Deno.writeTextFile(join(app, "deno.json"), `{ "imports": {} }\n`);
    // Sibling-package Sass with a variable + nesting (proves it's compiled, not copied).
    await Deno.writeTextFile(
      join(pkg, "button.scss"),
      "$brand: #3366ff;\n.button { color: $brand; .icon { fill: $brand; } }\n",
    );
    // The app's only in-tree stylesheet, so the walk alone would find just this one.
    await Deno.writeTextFile(join(app, "local.css"), ".local { padding: 3px }\n");
    const entry = join(app, "entry.tsx");
    await Deno.writeTextFile(
      entry,
      `import "./local.css";\nimport "../packages/ui/button.scss";\nexport default function A() { return null; }\n`,
    );

    const css = await buildAppCss({
      projectDir: app,
      configPath: join(app, "deno.json"),
      outDir: join(app, ".denext"),
      entryFiles: [entry],
    });
    assert(css, "expected CSS assets");

    // The sibling-package sheet was discovered and compiled through the pipeline.
    const scss = join(pkg, "button.scss");
    assert(css!.cssFiles.includes(scss), "cross-package .scss should be discovered");
    const compiled = css!.css.get(scss)!;
    assertStringIncludes(compiled, ".button .icon"); // Sass nesting flattened
    assertStringIncludes(compiled, "#36f"); // $brand resolved (and lightningcss-shortened)
    // The in-tree sheet is still present (union, not replacement).
    assert(css!.cssFiles.some((f) => f === join(app, "local.css")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildAppCss carries the app's nodeModulesDir into css-config (manual-mode npm linking)", async () => {
  // The CLI re-execs the build with css-config.json; a manual-`node_modules` app then
  // needs `nodeModulesDir` preserved or Deno refuses to link its npm deps.
  const dir = await Deno.makeTempDir({ prefix: "denext_nmd_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      `{ "nodeModulesDir": "manual", "imports": {} }\n`,
    );
    await Deno.writeTextFile(join(dir, "a.css"), ".x { color: red }\n");
    await Deno.writeTextFile(join(dir, "page.tsx"), `import "./a.css";\nexport const y = 1;\n`);
    const css = await buildAppCss({
      projectDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
    });
    assert(css, "expected CSS assets");
    const cfg = JSON.parse(await Deno.readTextFile(css!.configPath));
    assertEquals(cfg.nodeModulesDir, "manual", "nodeModulesDir carried into css-config");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildAppCss emits a config redirecting css + returns per-route extraction", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_appcss_" });
  const app = join(dir, "app");
  await Deno.mkdir(join(app, "shared"), { recursive: true });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), `{ "imports": {} }\n`);
    await Deno.writeTextFile(join(app, "a.module.css"), ".on { padding: 7px }\n");
    await Deno.writeTextFile(join(app, "unused.module.css"), ".off { margin: 99px }\n");
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `import s from "./a.module.css";\nexport default function P() { return s.on; }\n`,
    );

    const css = await buildAppCss({
      projectDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
    });
    assert(css, "expected CSS assets");

    // The generated config redirects each css file to its shim.
    const cfg = JSON.parse(await Deno.readTextFile(css!.configPath));
    assertStringIncludes(cfg.imports[toFileUrl(join(app, "a.module.css")).href], "css-shims");

    // Per-route extraction only includes CSS the route actually reaches.
    const routeCss = await extractRouteCss([join(app, "page.tsx")], css!);
    assertStringIncludes(routeCss, "7px");
    assert(!routeCss.includes("99px"), "unused stylesheet must not leak into the route");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
