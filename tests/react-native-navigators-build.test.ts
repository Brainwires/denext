// React Native mode resolves an app's `expo-router` / `expo-router/stack` / `expo-router/tabs`
// imports to the Expo Router navigators drawn by `denext/navigation` (the plugin itself is
// tested in navigation-native-dom.test.ts): the app's `Stack` / `Tabs` are denext's, every
// other expo-router export and expo-router's own internal imports stay the real package, and the
// SPA bundle carries the Activity runtime the hidden stack screens need.

import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import { reactNativeBundleOptions } from "../src/build/react-native.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

const FIXTURE: Record<string, string> = {
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
  }),
  "node_modules/react-native-web/dist/index.js": "export const View = 'RNW_View';\n",
  "node_modules/expo-router/package.json": JSON.stringify({
    name: "expo-router",
    exports: { ".": "./index.js", "./stack": "./stack.js", "./tabs": "./tabs.js" },
  }),
  "node_modules/expo-router/index.js": `import { Stack as OwnStack } from "expo-router/stack";
export const Stack = OwnStack;
export const Tabs = { Screen: "REAL_TABS_SCREEN" };
export const Link = "REAL_LINK";
export const internalStack = OwnStack;
export function withLayoutContext(nav) { return "LAYOUT(" + nav + ")"; }
`,
  "node_modules/expo-router/stack.js":
    `export const Stack = { Screen: "REAL_STACK_SCREEN", Protected: "REAL_PROTECTED" };
export default Stack;
`,
  "node_modules/expo-router/tabs.js": `export const Tabs = { Screen: "REAL_TABS_SCREEN" };
export default Tabs;
`,
  "node_modules/@react-navigation/native/package.json": JSON.stringify({
    name: "@react-navigation/native",
    main: "index.js",
  }),
  "node_modules/@react-navigation/native/index.js": "export const core = 'CORE';\n",
  "entry.js": `import { Stack, Tabs, Link, internalStack } from "expo-router";
import StackOnly from "expo-router/stack";
export const result = {
  Stack: String(Stack),
  StackScreen: Stack.Screen,
  Tabs: String(Tabs),
  Link,
  internalStack: internalStack.Screen,
  StackOnly: String(StackOnly),
};
`,
};

/** `denext/navigation` stand-in: each factory returns a navigator named after it. */
const NAVIGATION =
  `export const createNativeStackNavigatorFactory = () => () => ({ Navigator: "DENEXT_STACK" });
export const createBottomTabNavigatorFactory = () => () => ({ Navigator: "DENEXT_TABS" });
`;

Deno.test("reactNative bundle: expo-router's Stack / Tabs resolve to denext/navigation's; the rest stays real", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_nav_" });
  try {
    await writeTree(dir, FIXTURE);
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false)!;
    assertEquals(options.usesActivity, true, "hidden stack screens need the Activity runtime");
    const standIn: esbuild.Plugin = {
      name: "stand-in",
      setup(build) {
        build.onResolve({ filter: /^denext\/navigation$/ }, () => ({
          path: "nav",
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
          contents: NAVIGATION,
          loader: "js",
        }));
      },
    };
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [...options.plugins, standIn],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    const { result } = await import(url);
    assertEquals(result.Stack, "LAYOUT(DENEXT_STACK)");
    assertEquals(result.StackScreen, "REAL_STACK_SCREEN", "Stack.Screen is carried over");
    assertEquals(result.Tabs, "LAYOUT(DENEXT_TABS)");
    assertEquals(result.Link, "REAL_LINK", "every other export is the real package's");
    assertEquals(
      result.internalStack,
      "REAL_STACK_SCREEN",
      "expo-router's own imports keep the real module",
    );
    assertEquals(result.StackOnly, "LAYOUT(DENEXT_STACK)", "expo-router/stack too");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
