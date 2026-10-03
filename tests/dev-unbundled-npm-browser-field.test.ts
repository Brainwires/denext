// Unbundled dev, compat mode: the npm dependency bundle resolves packages through denext's own
// node_modules resolver, which must honor a package's `browser` field as esbuild does for a
// browser build (jszip's `"./lib/index": "./dist/jszip.min.js"` main replacement and its
// `"readable-stream": "./lib/readable-stream-browser.js"` remap). Without it T3 Code's dev
// server bundled jszip's Node build, which reached `events`/`stream` and failed the WHOLE
// bundle: every `/_denext/@npm/*` module answered 500.

import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  BROWSER_CONDITIONS,
  resolveBrowserSpecifier,
  resolveNodeFrom,
  SSR_CONDITIONS,
} from "../src/build/next-compat.ts";

const pkg = (o: Record<string, unknown>) => JSON.stringify(o);

const FILES: Record<string, string> = {
  "deno.json": "{}",
  // The object form's main replacement: the Node build imports `events`, which a browser
  // build cannot resolve.
  "node_modules/bf-main/package.json": pkg({
    name: "bf-main",
    main: "./lib/index",
    browser: { "./lib/index": "./dist/web.js" },
  }),
  "node_modules/bf-main/lib/index.js": 'require("events"); module.exports = "bf-main-node";',
  "node_modules/bf-main/dist/web.js": 'module.exports = "bf-main-web";',
  // Specifier remaps: to a file of the package, and `false` (an empty module). Neither target
  // package is installed, so the build fails unless the map is honored.
  "node_modules/bf-remap/package.json": pkg({
    name: "bf-remap",
    main: "index.js",
    browser: { "readable-stream": "./rs-browser.js", "node-only-thing": false },
  }),
  "node_modules/bf-remap/index.js": [
    'const rs = require("readable-stream");',
    'const nodeOnly = require("node-only-thing");',
    'module.exports = rs + ":" + JSON.stringify(nodeOnly);',
  ].join("\n"),
  "node_modules/bf-remap/rs-browser.js": 'module.exports = "rs-browser";',
  // The string form: a browser main.
  "node_modules/bf-string/package.json": pkg({
    name: "bf-string",
    main: "./node.js",
    browser: "./web.js",
  }),
  "node_modules/bf-string/node.js": 'require("events"); module.exports = "bf-string-node";',
  "node_modules/bf-string/web.js": 'module.exports = "bf-string-web";',
  // Isolation: one package that cannot bundle, one that can.
  "node_modules/broken-dep/package.json": pkg({ name: "broken-dep", main: "index.js" }),
  "node_modules/broken-dep/index.js": 'export * from "does-not-exist-anywhere";',
  "node_modules/good-dep/package.json": pkg({ name: "good-dep", main: "index.js" }),
  "node_modules/good-dep/index.js": 'export const value = "good-dep-value";',
};

async function project(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-browser-field-" }));
  for (const [rel, text] of Object.entries(FILES)) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  return dir;
}

Deno.test("resolver: a browser build honors the package.json browser field; SSR does not", async () => {
  const dir = await project();
  try {
    const nm = join(dir, "node_modules");
    assertEquals(
      await resolveNodeFrom(dir, "bf-main", BROWSER_CONDITIONS),
      join(nm, "bf-main/dist/web.js"),
    );
    assertEquals(
      await resolveNodeFrom(dir, "bf-string", BROWSER_CONDITIONS),
      join(nm, "bf-string/web.js"),
    );
    assertEquals(
      await resolveNodeFrom(dir, "bf-main", SSR_CONDITIONS),
      join(nm, "bf-main/lib/index.js"),
    );
    assertEquals(
      await resolveNodeFrom(dir, "bf-string", SSR_CONDITIONS),
      join(nm, "bf-string/node.js"),
    );
    const importer = join(nm, "bf-remap/index.js");
    assertEquals(
      await resolveBrowserSpecifier(importer, "readable-stream"),
      join(nm, "bf-remap/rs-browser.js"),
    );
    assertEquals(await resolveBrowserSpecifier(importer, "node-only-thing"), false);
    assertEquals(await resolveBrowserSpecifier(importer, "something-else"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
