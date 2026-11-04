// The App Router React Native fixture: a Server Component page and a `"use client"` island
// that both import `react-native`, a `.web.*` file, and a small react-native-web stand-in with
// its shape (an ES `dist/index.js` entry, a `StyleSheet` whose `getSheet()` returns the sheet the
// server writes), so a test needs no network. Shared by the export and the dev-loop tests.

import { dirname, join } from "@std/path";

const RN_APP_ROUTER_FILES: Record<string, string> = {
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
    // Imported by no fixture module: the dev-loop test adds an import of it.
    'export { default as Pressable } from "./exports/View";',
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
export async function writeRnAppRouterFixture(dir: string, config: string): Promise<void> {
  for (const [rel, text] of Object.entries(RN_APP_ROUTER_FILES)) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  await Deno.writeTextFile(join(dir, "denext.config.ts"), `export default ${config};\n`);
}
