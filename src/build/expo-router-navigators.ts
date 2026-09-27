// React Native mode: Expo Router's `Stack` / `Tabs` drawn by `denext/navigation`.
//
// On the web, expo-router's `Stack` is React Navigation's native-stack, which has no
// animations, no gestures and renders `presentation: "modal" | "formSheet"` screens as plain
// stack routes; its `Tabs` unmount nothing but keep no per-tab scroll. This plugin swaps both
// for navigators built on `denext/navigation`'s views (kept screens, platform push/pop
// animations, the iOS edge swipe, Android predictive back, sheets and modals) while keeping
// React Navigation's routers, so `router.push`, `<Link>`, `Stack.Screen options` and deep
// links behave exactly as before.
//
// How: an app's `import { Stack } from "expo-router"` (or `expo-router/stack`,
// `expo-router/tabs`) resolves to a generated module that re-exports the real expo-router and
// overrides `Stack` / `Tabs` with `withLayoutContext(<denext navigator>)`, carrying over
// `Stack.Screen` / `Stack.Protected`. Imports from inside expo-router itself (and the generated
// module's own import of it) resolve to the real package, so nothing recurses.

import type * as esbuild from "esbuild";

/** The esbuild namespace of the generated modules. */
const NAMESPACE = "denext-expo-router-navigators";

/** The specifiers the plugin takes over. */
const FILTER = /^expo-router(?:\/(?:stack|tabs))?$/;

/** An importer inside a package that must keep the real expo-router (its own internals). */
const INTERNAL_IMPORTER = /[\\/]node_modules[\\/](?:expo-router|@expo[\\/]router)[\\/]/;

/** The marker the generated module's own imports carry, to reach the real package. */
const REAL = "denext-real";

/**
 * The generated module for `spec` (`expo-router`, `expo-router/stack` or `expo-router/tabs`):
 * the real module re-exported, with `Stack` and/or `Tabs` replaced.
 *
 * @param spec The specifier being replaced.
 * @returns The module source (ESM).
 */
export function expoRouterNavigatorsSource(spec: string): string {
  const real = JSON.stringify(`${spec}?${REAL}`);
  const expoRouter = JSON.stringify(`expo-router?${REAL}`);
  const wantsStack = spec !== "expo-router/tabs";
  const wantsTabs = spec !== "expo-router/stack";
  const lines = [
    `import * as __core from "@react-navigation/native";`,
    `import { withLayoutContext as __withLayoutContext } from ${expoRouter};`,
    `import * as __real from ${real};`,
    `import { createBottomTabNavigatorFactory as __tabs, createNativeStackNavigatorFactory as __stack } from "denext/navigation";`,
    `export * from ${real};`,
  ];
  if (wantsStack) {
    lines.push(
      `const __RealStack = __real.Stack ?? __real.default;`,
      `export const Stack = Object.assign(__withLayoutContext(__stack(__core)().Navigator), {`,
      `  Screen: __RealStack?.Screen,`,
      `  Protected: __RealStack?.Protected,`,
      `});`,
    );
    if (spec === "expo-router/stack") lines.push(`export default Stack;`);
  }
  if (wantsTabs) {
    lines.push(
      `const __RealTabs = __real.Tabs ?? __real.default;`,
      `export const Tabs = Object.assign(__withLayoutContext(__tabs(__core)().Navigator), {`,
      `  Screen: __RealTabs?.Screen,`,
      `  Protected: __RealTabs?.Protected,`,
      `});`,
    );
    if (spec === "expo-router/tabs") lines.push(`export default Tabs;`);
  }
  return lines.join("\n") + "\n";
}

/**
 * The esbuild plugin that draws Expo Router's `Stack` / `Tabs` with `denext/navigation` in
 * React Native mode. Add it to the React Native mode plugin list (ahead of the default
 * resolution of `expo-router`); `denext/navigation` must resolve to the prebuilt runtime like
 * `denext/mobile` does.
 *
 * @returns The plugin.
 */
export function expoRouterNavigatorsPlugin(): esbuild.Plugin {
  return {
    name: "denext-expo-router-navigators",
    setup(build) {
      build.onResolve(
        { filter: /\?denext-real$/ },
        (args) =>
          build.resolve(args.path.slice(0, -(REAL.length + 1)), {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
            pluginData: { [REAL]: true },
          }),
      );
      build.onResolve({ filter: FILTER }, (args) => {
        if ((args.pluginData as Record<string, unknown> | undefined)?.[REAL]) return undefined;
        if (INTERNAL_IMPORTER.test(args.importer)) return undefined;
        return {
          path: args.path,
          namespace: NAMESPACE,
          pluginData: { resolveDir: args.resolveDir },
        };
      });
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
        contents: expoRouterNavigatorsSource(args.path),
        loader: "js",
        resolveDir: (args.pluginData as { resolveDir?: string } | undefined)?.resolveDir,
      }));
    },
  };
}
