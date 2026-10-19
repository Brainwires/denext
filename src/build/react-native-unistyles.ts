// React Native mode's Unistyles 3 support: what `react-native-unistyles/plugin` (its Babel
// plugin) does to the app's own modules, applied when the app has `react-native-unistyles`
// installed (unless `reactNative.unistyles` is `false`). Without it every Unistyles style was
// dropped on the web: react-native-web's components do not read a Unistyles style, only
// Unistyles' own wrappers of them do.
//
//   - `react-native` imported from the app's own modules (not node_modules) resolves to a
//     generated module: react-native as it is, with the components Unistyles wraps (`View`,
//     `Text`, `Pressable`, `ScrollView`, `FlatList`, `Image`, …, and React Native 0.83's
//     `unstable_NativeView` / `unstable_NativeText`) taken from
//     `react-native-unistyles/components/native/<Name>` (the plugin's import rewrite);
//   - `styles.useVariants(variants)` as a statement is rewritten the way the plugin's variants
//     pass does: the rest of its block reads the variant styles, from
//     `const styles = <the stylesheet>.useVariants(variants)` in a nested block.
//
// The plugin's third pass (each style's `uni__dependencies`) is not needed on the web for the
// theme (CSS variables carry it); a style that depends on the breakpoint or another runtime
// value is recomputed when the component re-renders.

import { join } from "@std/path";
import type * as esbuild from "./esbuild/mod.ts";
import { findInstalledPackage } from "./installed-package.ts";
import { transformWorklets, WORKLETS_GATE } from "./reanimated.ts";
import { firstPartyTsxPlugin } from "./spa-onload.ts";
import {
  applyEdits,
  endOf,
  matchLineEndings,
  type Node,
  parseModule,
  startOf,
  txt,
  walkAst,
} from "./swc-ast.ts";
import { type DenextConfig, reactNativeOptions } from "../server/config.ts";

/** The package. */
const PACKAGE = "react-native-unistyles";

/** The components Unistyles wraps (its plugin's `REACT_NATIVE_COMPONENT_NAMES`). */
const COMPONENTS = [
  "ActivityIndicator",
  "View",
  "Text",
  "Image",
  "ImageBackground",
  "KeyboardAvoidingView",
  "Pressable",
  "ScrollView",
  "FlatList",
  "SectionList",
  "Switch",
  "TextInput",
  "RefreshControl",
  "TouchableHighlight",
  "TouchableOpacity",
  "VirtualizedList",
  "Animated",
  "SafeAreaView",
] as const;

/** React Native 0.83's root exports of the host components, and Unistyles' modules for them. */
const HOST_COMPONENTS: Readonly<Record<string, string>> = {
  unstable_NativeView: "NativeView",
  unstable_NativeText: "NativeText",
};

/** The esbuild namespace of the generated `react-native` module. */
const NAMESPACE = "denext-unistyles-react-native";

/** pluginData marking a resolve made for the generated module (the real `react-native`). */
const REAL = "denextUnistylesReal";

/** Whether `path` lies in a node_modules folder. */
const inNodeModules = (path: string) => /[\\/]node_modules[\\/]/.test(path);

/**
 * Whether React Native mode's Unistyles support is on for `config` (`reactNative` set and
 * `reactNative.unistyles` not `false`).
 *
 * @param config The app config.
 */
export function unistylesEnabled(config: DenextConfig | null | undefined): boolean {
  const options = reactNativeOptions(config);
  return options !== null && options.unistyles !== false;
}

/**
 * The generated `react-native` module: react-native re-exported, with each of `names` (the
 * components the installed Unistyles ships) from Unistyles' wrapper.
 *
 * @param names The component modules found under `components/native/`.
 * @returns The module source.
 */
export function unistylesReactNativeSource(names: readonly string[]): string {
  const lines = [`export * from "react-native";`];
  for (const name of COMPONENTS) {
    if (names.includes(name)) {
      lines.push(`export { ${name} } from "${PACKAGE}/components/native/${name}";`);
    }
  }
  for (const [exported, module] of Object.entries(HOST_COMPONENTS)) {
    if (names.includes(module)) {
      lines.push(
        `export { ${module} as ${exported} } from "${PACKAGE}/components/native/${module}";`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

/** The component modules the installed Unistyles ships for the web (`lib/module/…/<Name>.js`). */
async function componentNames(pkgDir: string): Promise<string[]> {
  const dir = join(pkgDir, "lib", "module", "components", "native");
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const m = entry.name.match(/^(\w+)\.js$/);
      if (entry.isFile && m) names.push(m[1]);
    }
  } catch { /* an older layout: nothing to swap */ }
  return names.sort();
}

/** The innermost statement list of a block (`BlockStatement.stmts`). */
const statementsOf = (node: Node): Node[] | null =>
  node?.type === "BlockStatement" && Array.isArray(node.stmts) ? node.stmts : null;

/** Whether `node` is an identifier named `name` (any name when omitted). */
const isIdent = (node: Node, name?: string): boolean =>
  node?.type === "Identifier" && (name === undefined || node.value === name);

/** The `callee` of `stmt` when it is a call statement with exactly one plain argument. */
function oneArgCall(stmt: Node): Node | null {
  const call = stmt?.type === "ExpressionStatement" ? stmt.expression : null;
  const ok = call?.type === "CallExpression" && call.arguments?.length === 1 &&
    !call.arguments[0].spread;
  return ok ? call : null;
}

/** `NAME.useVariants(arg)` as a statement: the stylesheet's name and the argument, else null. */
function variantsStatement(stmt: Node): { name: string; arg: Node } | null {
  const call = oneArgCall(stmt);
  const callee = call?.callee;
  if (callee?.type !== "MemberExpression") return null;
  if (!isIdent(callee.object) || !isIdent(callee.property, "useVariants")) return null;
  return { name: callee.object.value, arg: call.arguments[0].expression };
}

/**
 * Rewrite each `styles.useVariants(variants);` statement in `source` as Unistyles' Babel plugin
 * does: `const _styles = styles; { const styles = _styles.useVariants(variants); …the rest of
 * the block }`, so what follows reads the variant styles.
 *
 * @param source A module of the app.
 * @returns The new source, or null when it has no such statement.
 */
export async function rewriteUseVariants(source: string): Promise<string | null> {
  if (!source.includes(".useVariants(")) return null;
  const parsed = await parseModule(source);
  if (!parsed) return null;
  const { ctx } = parsed;
  const edits: { start: number; end: number; text: string }[] = [];
  let n = 0;
  walkAst(parsed.body, (node) => {
    const stmts = statementsOf(node);
    if (!stmts) return;
    for (const stmt of stmts) {
      const call = variantsStatement(stmt);
      if (!call) continue;
      const shadow = `__unistyles${n++}_${call.name}`;
      edits.push({
        start: startOf(ctx, stmt),
        end: endOf(ctx, stmt),
        text: `const ${shadow} = ${call.name}; { const ${call.name} = ${shadow}.useVariants(${
          txt(ctx, call.arg)
        });`,
      });
      // Before the block's closing brace.
      const close = endOf(ctx, node) - 1;
      edits.push({ start: close, end: close, text: "}" });
    }
  });
  return edits.length === 0 ? null : applyEdits(ctx.bytes, matchLineEndings(source, edits));
}

/**
 * The esbuild plugins behind React Native mode's Unistyles support (see the module comment).
 * They do nothing when `react-native-unistyles` is not installed. Registered ahead of the
 * react-native-web resolver (which then resolves the generated module's own `react-native`).
 *
 * @param projectDir Where `react-native-unistyles` is looked up from.
 * @returns The plugins.
 */
export function unistylesPlugins(projectDir: string): esbuild.Plugin[] {
  let found: Promise<{ dir: string; names: string[] } | null> | null = null;
  const unistyles = () =>
    found ??= findInstalledPackage(projectDir, PACKAGE).then(async (dir) =>
      dir ? { dir, names: await componentNames(dir) } : null
    );
  const resolver: esbuild.Plugin = {
    name: "denext-react-native-unistyles",
    setup(build) {
      build.onResolve({ filter: /^react-native$/ }, async (args) => {
        const data = args.pluginData as Record<string, unknown> | undefined;
        if (data?.[REAL] || args.namespace !== "file" || inNodeModules(args.importer)) {
          return undefined;
        }
        const pkg = await unistyles();
        if (!pkg || pkg.names.length === 0) return undefined;
        return { path: "react-native", namespace: NAMESPACE };
      });
      // The generated module's imports resolve as from a file in the app's folder.
      build.onResolve({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: join(projectDir, "denext-generated.js"),
          namespace: "file",
          resolveDir: projectDir,
          pluginData: { [REAL]: true },
        });
        if (result.errors.length > 0) return { errors: result.errors };
        const { path, namespace, external, sideEffects } = result;
        return { path, namespace, external, sideEffects };
      });
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async () => ({
        contents: unistylesReactNativeSource((await unistyles())?.names ?? []),
        loader: "js",
        resolveDir: projectDir,
      }));
    },
  };
  const variants = firstPartyTsxPlugin(
    "denext-unistyles-variants",
    projectDir,
    async (source, path) => {
      if (!(await unistyles())) return null;
      const out = await rewriteUseVariants(source);
      if (out === null) return null;
      // esbuild keeps the first onLoad that answers: run the worklets pass here as well.
      if (!WORKLETS_GATE.test(out)) return out;
      return (await transformWorklets(out, path, { diagnostics: true, helper: "import" })).code;
    },
    { filter: /\.(?:tsx|jsx|m?ts|m?js)$/, deferUnless: ".useVariants(" },
  );
  return [resolver, variants];
}
