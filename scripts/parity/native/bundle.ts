// The ACTUAL side of the react-native target, measured on what an app gets: a bundle of
// `export * from "react-native"` built with React Native mode's own esbuild plugins
// (`reactNativeBundleOptions`, src/build/react-native.ts) over the pinned react-native-web,
// so the shell overlay, the entry additions (codegen stand-ins, `PermissionsAndroid`,
// `useAnimatedValue`, …) and every other alias are counted. The earlier gate imported raw
// react-native-web and so listed names the build does provide (TurboModuleRegistry,
// codegenNative*) as missing.
//
//   • names: the export list esbuild's metafile reports for the bundle (the built module
//     graph);
//   • statics: the bundle is executed (with react / react-dom / `denext/*` external to the
//     framework's own source, as the prebuilt runtime would supply them) and each export's
//     own and inherited property names are recorded as its `members`, so the diff's
//     MEMBER_MISSING check covers class statics and object members (`Image.prefetch`,
//     `PermissionsAndroid.RESULTS`, `Platform.constants`).
//
// react-native-web is installed into a temp dir with `deno install` (from Deno's npm cache when
// present), so the repo root stays clean.

import { join, toFileUrl } from "@std/path";
import * as esbuild from "esbuild";
import { reactNativeBundleOptions } from "../../../src/build/react-native.ts";
import type { Surface, SurfaceSymbol } from "../types.ts";
import { REACT_NATIVE_WEB_PACKAGE, REACT_NATIVE_WEB_PIN } from "./spec.ts";

/**
 * The prebuilt runtime entries React Native mode's modules import, as the framework source
 * each stands for (the SPA build loads the prebuilt copies of these same files).
 */
const RUNTIME_SOURCES: Readonly<Record<string, string>> = {
  "denext/react-native": "src/react-native/mod.ts",
  "denext/react-native/flash-list": "src/react-native/flash-list.ts",
  "denext/react-native/legend-list": "src/react-native/legend-list.ts",
};

/** `react`, `react-dom` and `denext/*`: external, pointed at the framework's own source. */
const EXTERNAL_FILTER = /^(?:react(?:-dom)?(?:\/.*)?|denext\/.*)$/;

/** The framework file a runtime specifier stands for, from `deno.json` exports or the table. */
function runtimeSource(exportsMap: Record<string, string>, spec: string): string | null {
  if (Object.hasOwn(RUNTIME_SOURCES, spec)) return RUNTIME_SOURCES[spec];
  const sub = spec.startsWith("denext/") ? spec.slice("denext/".length) : spec;
  const rel = exportsMap[`./${sub}`];
  return rel ? rel.replace(/^\.\//, "") : null;
}

/** The esbuild plugin that makes the runtime specifiers external `file:` URLs into `root`. */
function frameworkExternals(root: string, exportsMap: Record<string, string>): esbuild.Plugin {
  return {
    name: "parity-framework-externals",
    setup(build) {
      build.onResolve({ filter: EXTERNAL_FILTER }, (args) => {
        const rel = runtimeSource(exportsMap, args.path);
        return rel ? { path: toFileUrl(join(root, rel)).href, external: true } : null;
      });
    },
  };
}

/** Install the pinned react-native-web into `dir` (Deno's npm cache when it has it). */
async function installReactNativeWeb(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "denext-parity-rn-bundle",
      private: true,
      dependencies: { [REACT_NATIVE_WEB_PACKAGE]: REACT_NATIVE_WEB_PIN },
    }),
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["install", "--quiet"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `deno install ${REACT_NATIVE_WEB_PACKAGE} failed:\n` +
        new TextDecoder().decode(out.stderr),
    );
  }
}

/**
 * The property names of `value` (an object or function) up its prototype chain, stopping at
 * `Object.prototype` / `Function.prototype`: an object's members, a class's statics.
 */
export function memberNames(value: unknown): string[] | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  const names = new Set<string>();
  for (
    let o: object | null = value as object;
    o && o !== Object.prototype && o !== Function.prototype;
    o = Object.getPrototypeOf(o)
  ) {
    for (const key of Object.getOwnPropertyNames(o)) names.add(key);
  }
  return [...names].sort();
}

/** What {@link rnBundleSurface} measured. */
export interface BundleMeasure {
  /** The surface: one value symbol per export, with its runtime members. */
  surface: Surface;
  /** The bundle's size in bytes (for the report line). */
  bytes: number;
}

/**
 * Build `export * from "<specifier>"` through React Native mode's plugins over the pinned
 * react-native-web, read its export names from the metafile, run it, and record each
 * export's members.
 *
 * @param root The framework root (absolute).
 * @param specifier What an app imports (`"react-native"`, `"react-native-windows"`); the
 *   surface is tagged with it.
 * @returns The measured surface.
 */
export async function rnBundleSurface(root: string, specifier: string): Promise<BundleMeasure> {
  const dir = await Deno.makeTempDir({ prefix: "denext_parity_rn_bundle_" });
  try {
    await installReactNativeWeb(dir);
    const exportsMap = JSON.parse(await Deno.readTextFile(join(root, "deno.json")))
      .exports as Record<string, string>;
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false);
    if (!options) throw new Error("reactNativeBundleOptions returned null for reactNative: true");
    const result = await esbuild.build({
      stdin: {
        contents: `export * from ${JSON.stringify(specifier)};\n`,
        resolveDir: dir,
        loader: "js",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      metafile: true,
      logLevel: "silent",
      absWorkingDir: dir,
      define: { ...options.define, "process.env.NODE_ENV": '"production"' },
      resolveExtensions: [...options.platformExtensions, ".tsx", ".ts", ".jsx", ".js", ".json"],
      loader: { ".js": "jsx" },
      plugins: [frameworkExternals(root, exportsMap), ...options.plugins],
    });
    const output = Object.values(result.metafile!.outputs)[0];
    const names = output.exports.filter((n) => n !== "default" && !n.startsWith("__"));
    const file = join(dir, "bundle.mjs");
    const code = result.outputFiles![0].contents;
    await Deno.writeFile(file, code);
    const ns = await import(toFileUrl(file).href) as Record<string, unknown>;
    const symbols: Record<string, SurfaceSymbol> = {};
    for (const name of names) {
      symbols[name] = {
        name,
        kind: "value",
        isValue: true,
        isType: false,
        members: memberNames(ns[name]),
      };
    }
    return { surface: { specifier, resolved: true, symbols }, bytes: code.byteLength };
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
