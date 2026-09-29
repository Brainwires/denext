// React Native mode's list adapters at build time (see src/react-native/lists/manifest.ts):
// react-native-web's FlatList / SectionList / VirtualizedList modules load as denext's
// adapters built over the app's own View / StyleSheet / RefreshControl, and the aliased list
// packages (`@shopify/flash-list`, `@legendapp/list`) resolve to generated modules that build
// their components the same way. `reactNative: { lists: "library" }` turns both off.

import { dirname } from "@std/path";
import type * as esbuild from "esbuild";
import {
  LIST_PACKAGES,
  type ListPackage,
  RN_LIST_COMPONENTS,
} from "../react-native/lists/manifest.ts";

/** The prebuilt runtime specifier of the overlay (`src/react-native/mod.ts`). */
const OVERLAY = "denext/react-native";

/** A replaced list module of react-native-web (ES or CommonJS build); 1 is `cjs/`, 2 the name. */
const LIST_MODULE = new RegExp(
  `[\\\\/]react-native-web[\\\\/]dist[\\\\/](cjs[\\\\/])?exports[\\\\/](${
    RN_LIST_COMPONENTS.join("|")
  })[\\\\/]index\\.js$`,
);

/** The primitives each list module takes from its react-native-web siblings. */
const PRIMITIVES = ["View", "StyleSheet", "RefreshControl"] as const;

/**
 * The source that stands in for react-native-web's list module `name`: denext's
 * `create<name>({ View, StyleSheet, RefreshControl })` over the sibling modules (the
 * `RefreshControl` sibling is itself denext's, through the shell overlay).
 *
 * @param name A react-native-web list component (`FlatList`, …).
 * @param cjs Whether the module is from react-native-web's CommonJS build.
 * @returns The module source.
 */
export function listModuleSource(name: string, cjs: boolean): string {
  if (!cjs) {
    return PRIMITIVES.map((p) => `import ${p} from "../${p}";\n`).join("") +
      `import { create${name} } from "${OVERLAY}";\n` +
      `export default /* @__PURE__ */ create${name}({ ${PRIMITIVES.join(", ")} });\n`;
  }
  const req = (spec: string) => `require(${JSON.stringify(spec)})`;
  return `"use strict";\nfunction d(m) { return m && m.__esModule ? m.default : m; }\n` +
    `module.exports = ${req(OVERLAY)}.create${name}({ ${
      PRIMITIVES.map((p) => `${p}: d(${req(`../${p}`)})`).join(", ")
    } });\n`;
}

/** The esbuild namespace of the generated list-package modules. */
const PACKAGE_NAMESPACE = "denext-rn-lists";

/** The package a list specifier belongs to, or undefined. */
function listPackageOf(spec: string): ListPackage | undefined {
  return Object.values(LIST_PACKAGES).find((p) => p.specifiers.includes(spec));
}

/**
 * The generated module an aliased list package resolves to: its components built from
 * react-native-web's primitives, animated variants, and the rest re-exported from denext's
 * prebuilt runtime module.
 *
 * @param pkg The manifest entry.
 * @returns The module source.
 */
export function listPackageSource(pkg: ListPackage): string {
  const factories = Object.values(pkg.components);
  const animated = Object.entries(pkg.animated ?? {});
  const rn = [...PRIMITIVES, ...(animated.length > 0 ? ["Animated"] : [])].sort();
  const lines = [
    `import { ${rn.join(", ")} } from "react-native";`,
    `import { ${factories.join(", ")} } from "${pkg.runtime}";`,
    `export { ${pkg.reexports.join(", ")} } from "${pkg.runtime}";`,
    ...Object.entries(pkg.components).map(([name, factory]) =>
      `export const ${name} = /* @__PURE__ */ ${factory}({ ${PRIMITIVES.join(", ")} });`
    ),
    ...animated.map(([name, of]) =>
      `export const ${name} = /* @__PURE__ */ Animated.createAnimatedComponent(${of});`
    ),
  ];
  return lines.join("\n") + "\n";
}

/** Every aliased specifier. */
const PACKAGE_FILTER = new RegExp(
  `^(?:${
    Object.values(LIST_PACKAGES).flatMap((p) => p.specifiers).map((s) =>
      s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    ).join("|")
  })$`,
);

/**
 * The esbuild plugin behind React Native mode's list adapters: react-native-web's list modules
 * and the aliased list packages load as denext's.
 *
 * @param projectDir Where the generated modules resolve `react-native` from.
 */
export function listAdaptersPlugin(projectDir: string): esbuild.Plugin {
  return {
    name: "denext-react-native-lists",
    setup(build) {
      build.onLoad({ filter: LIST_MODULE }, (args) => {
        const [, cjs, name] = LIST_MODULE.exec(args.path)!;
        return {
          contents: listModuleSource(name, cjs !== undefined),
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
      build.onResolve({ filter: PACKAGE_FILTER }, (args) => ({
        path: args.path,
        namespace: PACKAGE_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: PACKAGE_NAMESPACE }, (args) => ({
        contents: listPackageSource(listPackageOf(args.path)!),
        loader: "js",
        resolveDir: projectDir,
      }));
    },
  };
}
