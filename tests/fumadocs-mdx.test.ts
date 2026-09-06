// The fumadocs-mdx bridge: detection + the esbuild plugin that compiles `x.mdx?collection=…`
// and `meta.json?collection=…` through fumadocs' Node loader hosted in a byonm child. A FAKE
// `fumadocs-mdx/node/_loader` stands in for the real package so the test exercises the
// protocol, the query → `suffix` routing and the fall-through for unqueried JSON.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import {
  detectFumadocsMdx,
  disposeFumadocsHosts,
  fumadocsMdxPlugin,
} from "../src/build/fumadocs-mdx.ts";
import { resolveNodeFrom, SSR_CONDITIONS } from "../src/build/next-compat.ts";

const resolve = (dir: string, spec: string) => resolveNodeFrom(dir, spec, SSR_CONDITIONS);

const FAKE_LOADER = `
let cfg;
export function initialize(o) { cfg = o; }
export async function load(url, _ctx, next) {
  const u = new URL(url);
  if (!/\\.(mdx|json)$/.test(u.pathname)) return next(url);
  const collection = u.searchParams.get("collection");
  const body = await Deno.readTextFile(u);
  if (u.pathname.endsWith(".json")) {
    return { source: "export default " + JSON.stringify({ meta: JSON.parse(body), collection }), format: "module" };
  }
  const fm = { collection, config: cfg.configPath, cwd: Deno.cwd() };
  return {
    source: "export const frontmatter = " + JSON.stringify(fm) +
      "; export default function Doc() { return " + JSON.stringify(body.trim()) + "; }",
    format: "module",
  };
}
`;

async function writeApp(): Promise<string> {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_fumadocs_" }));
  const pkg = join(app, "node_modules", "fumadocs-mdx");
  await Deno.mkdir(join(pkg, "dist", "node"), { recursive: true });
  await Deno.writeTextFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "fumadocs-mdx",
      exports: { "./node/_loader": "./dist/node/_loader.js" },
    }),
  );
  await Deno.writeTextFile(join(pkg, "dist", "node", "_loader.js"), FAKE_LOADER);
  await Deno.writeTextFile(join(app, "doc.mdx"), "# Hello\n");
  await Deno.writeTextFile(join(app, "meta.json"), JSON.stringify({ title: "Docs" }));
  await Deno.writeTextFile(join(app, "plain.json"), JSON.stringify({ plain: 1 }));
  await Deno.writeTextFile(
    join(app, "entry.js"),
    [
      `import Doc, { frontmatter } from "./doc.mdx?collection=docs";`,
      `import meta from "./meta.json?collection=docs";`,
      `import plain from "./plain.json";`,
      `import { frontmatter as bare } from "./doc.mdx";`,
      `export const all = { Doc, frontmatter, meta, plain, bare };`,
    ].join("\n"),
  );
  return app;
}

Deno.test("fumadocs-mdx: detection needs BOTH source.config.* and the package", async () => {
  const app = await writeApp();
  try {
    assertEquals(await detectFumadocsMdx(app, resolve), null, "no source.config yet");
    await Deno.writeTextFile(join(app, "source.config.ts"), "export default {};");
    const found = await detectFumadocsMdx(app, resolve);
    assert(found, "detected");
    assertEquals(found.configName, "source.config.ts");
    assertStringIncludes(found.loaderPath, join("fumadocs-mdx", "dist", "node", "_loader.js"));
    assertEquals(
      await detectFumadocsMdx(join(app, "node_modules"), resolve),
      null,
      "no config there",
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test({
  name: "fumadocs-mdx: queried MDX/meta imports compile through the hosted loader",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = await writeApp();
  await Deno.writeTextFile(join(app, "source.config.ts"), "export default {};");
  try {
    const install = (await detectFumadocsMdx(app, resolve))!;
    const result = await esbuild.build({
      entryPoints: [join(app, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      absWorkingDir: app,
      plugins: [fumadocsMdxPlugin(install)],
      logLevel: "silent",
    });
    const out = result.outputFiles[0].text;
    // The doc compiled with its collection, fumadocs' config name, and the app dir as cwd.
    assertStringIncludes(out, `"collection": "docs"`);
    assertStringIncludes(out, `"config": "source.config.ts"`);
    assertStringIncludes(out, JSON.stringify(app));
    assertStringIncludes(out, `"# Hello"`);
    // meta.json?collection=docs went through the meta loader; plain.json did not.
    assertStringIncludes(out, `"meta": {`);
    assertStringIncludes(out, `plain: 1`);
    // An unqueried .mdx still compiles through fumadocs (collection null).
    assertStringIncludes(out, `"collection": null`);
  } finally {
    disposeFumadocsHosts();
    await esbuild.stop();
    await Deno.remove(app, { recursive: true });
  }
});
