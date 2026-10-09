// The bare `denext` entry (and every other client `denext/*` subpath) in a compatibility-mode
// SPA export resolves to the ONE prebuilt runtime, never to the deno-loader. An app installed
// the way `denext migrate` writes it maps `denext` to `jsr:@denext/denext@^x`; the portable
// deno-loader cannot read that without a lockfile ("Failed reading lockfile", or with
// `"lock": false` "jsr: specifiers are not supported in the portable loader without a
// lockfile"), and a `file://` link only built because the loader then bundled a SECOND copy of
// denext's sources (a second hook dispatcher). Each fixture here maps denext to `jsr:` with no
// lockfile, so any `denext` specifier that falls through fails the export.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import type { Platform } from "../src/build/platform-extensions.ts";
import {
  DENEXT_RUNTIME_FILES,
  DENEXT_SERVER_SUBPATHS,
  runtimeEntryPoints,
} from "../src/build/next-compat.ts";

const JSR = "jsr:@denext/denext@^3.4.1";
const exportsMap = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
).exports as Record<string, string>;
/** Every public specifier: `denext`, `denext/client`, `denext/expo/haptics`, … */
const PUBLIC = Object.keys(exportsMap).map((k) => k === "." ? "denext" : `denext/${k.slice(2)}`);
const CLIENT = PUBLIC.filter((s) => !DENEXT_SERVER_SUBPATHS.has(s));

/** The hook dispatcher's own error text: one per copy of denext's hooks in a bundle. */
const DISPATCHER = "no dispatcher installed";

Deno.test("every public denext subpath is a prebuilt runtime file or a server-only external", () => {
  const entries = new Set(Object.keys(runtimeEntryPoints("file:///fw/")).map((k) => `${k}.js`));
  for (const spec of PUBLIC) {
    const file = Object.hasOwn(DENEXT_RUNTIME_FILES, spec) ? DENEXT_RUNTIME_FILES[spec] : null;
    assert(
      file !== null || DENEXT_SERVER_SUBPATHS.has(spec),
      `${spec} would fall through to the deno-loader: add it to DENEXT_RUNTIME_FILES ` +
        `(client) or DENEXT_SERVER_SUBPATHS (server/tooling)`,
    );
    assert(file === null || !DENEXT_SERVER_SUBPATHS.has(spec), `${spec} is in both`);
    if (file) assert(entries.has(file), `${spec} → ${file}, which the prebuild does not emit`);
  }
  for (const spec of DENEXT_SERVER_SUBPATHS) assert(PUBLIC.includes(spec), `${spec} not exported`);
  assertEquals(DENEXT_RUNTIME_FILES["denext"], "denext.js");
});

/** A compat SPA whose deno.json maps denext the way `denext migrate` does: to JSR. */
async function project(files: Record<string, string>, lock?: false): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_bare_alias_" });
  const imports: Record<string, string> = {};
  for (const spec of CLIENT) imports[spec] = spec === "denext" ? JSR : `${JSR}/${spec.slice(7)}`;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      ...(lock === false ? { lock: false } : {}),
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports,
    }),
  );
  const all: Record<string, string> = {
    "denext.config.ts": `export default { mode: "spa", spa: { entry: "./src/main.tsx" }, ` +
      `compatibilityMode: true };\n`,
    ...files,
  };
  for (const [name, src] of Object.entries(all)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

/** Every client `.js` file of an export, concatenated. */
async function clientJs(outDir: string): Promise<string> {
  const client = join(outDir, "_denext", "client");
  let js = "";
  for await (const e of Deno.readDir(client)) {
    if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(client, e.name));
  }
  return js;
}

/** Strings of root-barrel modules the fixture never uses (render-to-string, api-client, …). */
const BARREL_UNUSED = [
  "a fallback must render synchronously.",
  "denext.apiClient.inflight",
  "denext.native.refreshToken",
  "data-denext-virtual-list",
];

/** Occurrences of `needle` in `hay`. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** The app: `Row` from bare `denext` in a phone platform file, a plain `Row` elsewhere. */
const ROW_APP = {
  "src/main.tsx": `import { createRoot } from "denext/react-dom/client";\n` +
    `import { useState } from "denext";\nimport { Row } from "./Row";\n` +
    `function App(){ const [n] = useState(1); return <main data-n={n}><Row/></main>; }\n` +
    `createRoot(document.getElementById("root")!).render(<App/>);\n`,
  "src/Row.tsx": `export function Row(){ return <p>PLAIN_ROW</p>; }\n`,
  "src/Row.mobile.tsx": `import { SwipeableRow, useState } from "denext";\n` +
    `export function Row(){ const [n] = useState(0);\n` +
    `  return <SwipeableRow trailing={[{ label: "MOBILE_ROW", onPress(){} }]}><p>{n}</p>` +
    `</SwipeableRow>; }\n`,
};

const CASES: ReadonlyArray<readonly [Platform, string, false | undefined]> = [
  ["web", "PLAIN_ROW", undefined],
  ["ios", "MOBILE_ROW", undefined],
  ["android", "MOBILE_ROW", false],
  ["macos", "PLAIN_ROW", false],
];

for (const [platform, want, lock] of CASES) {
  const how = lock === false ? `"lock": false` : "no lockfile";
  Deno.test(`compat SPA export --platform ${platform}: bare "denext" from JSR (${how}) is the prebuilt runtime`, async () => {
    const dir = await project(ROW_APP, lock);
    try {
      const js = await clientJs((await staticExport(dir, { platform })).outDir);
      assertStringIncludes(js, want);
      for (const other of ["PLAIN_ROW", "MOBILE_ROW"].filter((l) => l !== want)) {
        assert(!js.includes(other), `${other} bundled for ${platform}`);
      }
      assertEquals(count(js, DISPATCHER), 1, "exactly one copy of denext's hooks");
      // Tree-shaken: the rest of the root barrel (its server renderer, typed API client,
      // VirtualList) stays out of the bundle.
      for (const unused of BARREL_UNUSED) assert(!js.includes(unused), `bundled: ${unused}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("compat SPA export: every client denext subpath, mapped to JSR, bundles from the prebuilt runtime", async () => {
  const imports = CLIENT.map((s, i) => `import * as m${i} from "${s}";`).join("\n");
  const uses = CLIENT.map((_, i) => `m${i}`).join(", ");
  const dir = await project({ "src/main.tsx": `${imports}\nconsole.log([${uses}].length);\n` });
  try {
    const js = await clientJs((await staticExport(dir, { platform: "web" })).outDir);
    assertEquals(count(js, DISPATCHER), 1, "exactly one copy of denext's hooks");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
