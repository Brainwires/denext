// React Native mode's expo-router Stack (src/build/expo-router-navigators.ts): expo-router 56+'s
// `Stack.Screen` is `StackScreen`, which expo-router's own Stack maps to the base `Screen` before
// `withLayoutContext` reads its children. The generated Stack passed them through as written, so
// `withLayoutContext` dropped every `<Stack.Screen>` ("Layout children must be of type Screen")
// and its `options` (a header title) with it. The generated module is bundled here over stand-in
// modules and the children its navigator receives are checked.

import { assertEquals, assertStrictEquals } from "@std/assert";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { expoRouterNavigatorsSource } from "../src/build/expo-router-navigators.ts";
import { Children, createElement, isValidElement } from "../src/compat/react.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const STAND_INS: Record<string, string> = {
  "react": "export const { Children, createElement, isValidElement } = globalThis.__t.react;",
  "denext/navigation": "export const createNativeStackNavigatorFactory = () => () => " +
    "({ Navigator: globalThis.__t.Navigator });\nexport const createBottomTabNavigatorFactory = " +
    "() => () => ({ Navigator: globalThis.__t.Navigator });",
  "denext-expo-router-core": "export {};",
  "expo-router?denext-real": "export const withLayoutContext = globalThis.__t.withLayoutContext;",
  "expo-router/build/views/Screen?denext-real": "export const Screen = globalThis.__t.Screen;",
  "expo-router/stack?denext-real": "export const Stack = globalThis.__t.RealStack;\n" +
    "export default globalThis.__t.RealStack;",
};

/** The generated `expo-router/stack` module, bundled over {@link STAND_INS} and imported. */
async function generatedStack(): Promise<Any> {
  const out = await esbuild.build({
    stdin: { contents: expoRouterNavigatorsSource("expo-router/stack"), loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    logLevel: "silent",
    plugins: [{
      name: "stand-ins",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => ({ path: args.path, namespace: "s" }));
        build.onLoad({ filter: /.*/, namespace: "s" }, (args) => ({
          contents: STAND_INS[args.path],
          loader: "js",
        }));
      },
    }],
  });
  await esbuild.stop();
  const url = "data:text/javascript;base64," + btoa(out.outputFiles[0].text);
  return await import(url);
}

Deno.test("expo-router Stack: <Stack.Screen> children reach withLayoutContext as base Screens", async () => {
  function Screen() {
    return null;
  }
  function StackScreen() {
    return null;
  }
  function Protected() {
    return null;
  }
  function Navigator() {
    return null;
  }
  let received: Any[] = [];
  const t = {
    react: { Children, createElement, isValidElement },
    Navigator,
    Screen,
    RealStack: Object.assign(() => null, { Screen: StackScreen, Protected }),
    withLayoutContext: () => (props: Any) => {
      received = Children.toArray(props.children);
      return null;
    },
  };
  (globalThis as Any).__t = t;
  try {
    const { Stack } = await generatedStack();
    assertStrictEquals(Stack.Screen, StackScreen, "Stack.Screen stays expo-router's");
    const tree = Stack({
      screenOptions: { headerShown: true },
      children: [
        createElement(Stack.Screen, { name: "index", options: { title: "Home" } }),
        createElement(Stack.Protected, {
          guard: true,
          children: createElement(Stack.Screen, { name: "secret", options: { title: "S" } }),
        }),
      ],
    });
    // The navigator element renders withLayoutContext's component.
    tree.type(tree.props);
    assertEquals(tree.props.screenOptions, { headerShown: true });
    assertStrictEquals(received[0].type, Screen);
    assertEquals(received[0].props, { name: "index", options: { title: "Home" } });
    assertStrictEquals(received[1].type, Protected);
    const inner = Children.toArray(received[1].props.children) as Any[];
    assertStrictEquals(inner[0].type, Screen);
    assertEquals(inner[0].props.name, "secret");
  } finally {
    delete (globalThis as Any).__t;
  }
});
