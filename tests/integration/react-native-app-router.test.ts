// React Native mode on the App Router, end to end through `denext export`: a Server Component
// page and a `"use client"` island both import `react-native`, which resolves to the installed
// react-native-web in the server bundle and in the Flight (client) bundle; `.web.*` files win
// and `__DEV__` is defined on the server too; react-native-web's style sheet is written into the
// document head as `<style id="react-native-stylesheet">`, which its client adopts. Without
// `reactNative` the same app does not build (`react-native` is the real, Flow-source package).
//
// The react-native-web here is a small stand-in with its shape (an ES `dist/index.js` entry, a
// `StyleSheet` whose `getSheet()` returns the sheet the server writes), so the test needs no
// network; tests/e2e/react-native-app-router.e2e.test.ts runs the real one.

import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { exportInChild } from "../helpers/bounded-build.ts";

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  // The real react-native's entry is Flow: reaching it fails the bundle.
  "node_modules/react-native/package.json": JSON.stringify({
    name: "react-native",
    main: "index.js",
  }),
  "node_modules/react-native/index.js": "import typeof View from './View';\nexport default 1;\n",
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js": [
    'export { default as View } from "./exports/View";',
    'export { default as Text } from "./exports/Text";',
    'export { default as StyleSheet } from "./exports/StyleSheet";',
    "",
  ].join("\n"),
  "node_modules/react-native-web/dist/exports/StyleSheet/index.js": `const rules = [];
const StyleSheet = {
  create(styles) {
    const out = {};
    for (const key of Object.keys(styles)) {
      const cls = "r-" + key;
      const body = Object.entries(styles[key]).map(([p, v]) => p + ":" + v).join(";");
      rules.push("." + cls + "{" + body + "}");
      out[key] = cls;
    }
    return out;
  },
  getSheet() {
    return { id: "react-native-stylesheet", textContent: rules.join("\\n") };
  },
};
export default StyleSheet;
`,
  "node_modules/react-native-web/dist/exports/View/index.js":
    `import { createElement } from "react";
export default function View(props) {
  return createElement("div", { className: props.style, "data-rnw": "RNW_VIEW" }, props.children);
}
`,
  "node_modules/react-native-web/dist/exports/Text/index.js":
    `import { createElement } from "react";
export default function Text(props) {
  return createElement("span", { className: props.style, "data-rnw": "RNW_TEXT" }, props.children);
}
`,
  "components/label.tsx": 'export const label = "NATIVE_LABEL";\n',
  "components/label.web.tsx": 'export const label = "WEB_LABEL";\n',
  "components/counter.tsx": `"use client";
import { createElement as h, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
const styles = StyleSheet.create({ button: { color: "ISLAND_BLUE" } });
export function Counter() {
  const [n] = useState(0);
  return h(View, { style: styles.button }, h(Text, null, "RN_ISLAND:" + n));
}
`,
  "app/page.tsx": `import { createElement as h } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Counter } from "../components/counter.tsx";
import { label } from "../components/label";
declare const __DEV__: boolean;
const styles = StyleSheet.create({ box: { color: "SERVER_RED" } });
export default function Page() {
  return h(
    View,
    { style: styles.box },
    h(Text, null, "RN_SERVER_TEXT " + label + " DEV:" + String(__DEV__)),
    h(Counter, null),
  );
}
`,
};

/** Write the fixture under `dir` with `config` as its denext.config.ts default export. */
async function writeFixture(dir: string, config: string): Promise<void> {
  for (const [rel, text] of Object.entries(FILES)) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  await Deno.writeTextFile(join(dir, "denext.config.ts"), `export default ${config};\n`);
}

/** The client JS files of an export, by name. */
async function clientFiles(outDir: string): Promise<Map<string, string>> {
  const client = join(outDir, "_denext", "client");
  const files = new Map<string, string>();
  for await (const e of Deno.readDir(client)) {
    if (e.isFile && e.name.endsWith(".js")) {
      files.set(e.name, await Deno.readTextFile(join(client, e.name)));
    }
  }
  return files;
}

Deno.test({
  name: "export (App Router, reactNative): react-native-web renders server-side with its sheet",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_app_router_" });
  try {
    await writeFixture(dir, "{ reactNative: true }");
    const result = await exportInChild(dir);
    const html = await Deno.readTextFile(join(result.outDir, "index.html"));
    // The server render: react-native-web's markup, `.web.*` first, `__DEV__` defined.
    assertStringIncludes(html, 'data-rnw="RNW_VIEW"');
    assertStringIncludes(html, "RN_SERVER_TEXT WEB_LABEL DEV:false");
    assertStringIncludes(html, "RN_ISLAND:0");
    // The sheet, in the head, with the page's and the island's rules.
    const head = html.slice(0, html.indexOf("</head>"));
    const sheet = /<style id="react-native-stylesheet">([^<]*)<\/style>/.exec(head);
    assert(sheet, "react-native-web's style sheet is in the head");
    assertStringIncludes(sheet[1], ".r-box{color:SERVER_RED}");
    assertStringIncludes(sheet[1], ".r-button{color:ISLAND_BLUE}");
    assertStringIncludes(html, 'class="r-box"');
    // The client: the island's `react-native` is react-native-web, in the Flight bundle.
    const files = await clientFiles(result.outDir);
    const all = [...files.values()].join("\n");
    assertStringIncludes(all, "RN_ISLAND:");
    assertStringIncludes(all, "RNW_VIEW", "react-native → react-native-web in the client bundle");
    assertStringIncludes(all, "ISLAND_BLUE");
    assert(!all.includes("RN_SERVER_TEXT"), "server-component code stays on the server");
  } finally {
    await stopNextCompat();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("denext.serverStyleSheets")];
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "export (App Router, no reactNative): react-native stays the real package and fails",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_app_router_off_" });
  try {
    await writeFixture(dir, "{ compatibilityMode: true }");
    await assertRejects(() => exportInChild(dir));
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
