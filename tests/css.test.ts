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
  transformCss,
} from "../src/build/css.ts";

Deno.test("isCss / isCssModule classify file names", () => {
  assert(isCss("a/b.css"));
  assert(isCss("a/b.module.css"));
  assert(!isCss("a/b.ts"));
  assert(isCssModule("a/b.module.css"));
  assert(!isCssModule("a/b.css"));
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
