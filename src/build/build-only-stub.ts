// fallow-ignore-file duplicate-export -- a stand-in carries the names of the modules it replaces
// What a compiled app (`denext build --compile`) loads in place of the framework's build-only
// modules a server's graph may still reach (`buildOnlyStubs` in ./compile-app.ts maps each one
// here): the plugin kit's build-step primitives (./plugin-kit-build.ts, ./remix-codegen.ts) and
// the public build entrypoints a plugin imports for its build steps (`denext/build/next-compat`,
// `denext/bundle`, `denext/build/css`). It has every export of each, the build ones refusing:
// a plugin's build steps never run in a compiled app, so nothing calls them there, and the binary
// embeds none of the build tooling behind them (esbuild, swc, lightningcss, sass, `@mdx-js/mdx`).
// The ones a server may use at run time (the next-compat loader, the server-only scan, the
// codegen's constants) are the real ones. tests/compile-slim.test.ts keeps the
// export sets in step.

export { createNextCompatServerLoader } from "./next-compat-loader.ts";
export { findServerOnlyLeaks } from "./server-only-scan.ts";

/** A build-only function's stand-in: it refuses, naming the function. */
type BuildOnly = (...args: unknown[]) => never;

/** A function that refuses: `name` is build tooling, absent from a compiled app. */
function buildOnly(name: string): BuildOnly {
  return () => {
    throw new Error(
      `${name} is denext build tooling: a compiled app (\`denext build --compile\`) does not ` +
        "embed it. Call it from a plugin's build step, which runs at `denext build`.",
    );
  };
}

/** Refuses in a compiled app. */
export const buildNextCompatModules: BuildOnly = buildOnly("buildNextCompatModules");
/** Refuses in a compiled app. */
export const buildNextCompatClientEntries: BuildOnly = buildOnly("buildNextCompatClientEntries");
/** Refuses in a compiled app. */
export const buildNextCompatFlightEntry: BuildOnly = buildOnly("buildNextCompatFlightEntry");
/** Refuses in a compiled app. */
export const detectNextCompat: BuildOnly = buildOnly("detectNextCompat");
/** Refuses in a compiled app. */
export const compileCssAsset: BuildOnly = buildOnly("compileCssAsset");
/** Refuses in a compiled app. */
export const compileMdxSource: BuildOnly = buildOnly("compileMdxSource");
/** Refuses in a compiled app. */
export const bundleRoutes: BuildOnly = buildOnly("bundleRoutes");
/** Refuses in a compiled app. */
export const platformClientRedirects: BuildOnly = buildOnly("platformClientRedirects");
/** Refuses in a compiled app. */
export const buildAppCss: BuildOnly = buildOnly("buildAppCss");
/** Refuses in a compiled app. */
export const extractRouteCss: BuildOnly = buildOnly("extractRouteCss");
/** Refuses in a compiled app. */
export const edgeFunctionSource: BuildOnly = buildOnly("edgeFunctionSource");

// The Remix route-module codegen (`remixCodegen` in the plugin kit, ./remix-codegen.ts): its
// constants are the real ones, its functions refuse.
export { GEN_HEADER, SERVER_EXPORTS } from "./remix-codegen-constants.ts";
/** Refuses in a compiled app. */
export const rewriteRemixImports: BuildOnly = buildOnly("remixCodegen.rewriteRemixImports");
/** Refuses in a compiled app. */
export const declaredNames: BuildOnly = buildOnly("remixCodegen.declaredNames");
/** Refuses in a compiled app. */
export const freeIdentifiers: BuildOnly = buildOnly("remixCodegen.freeIdentifiers");
/** Refuses in a compiled app. */
export const selectHelpers: BuildOnly = buildOnly("remixCodegen.selectHelpers");
/** Refuses in a compiled app. */
export const selectHelperDecls: BuildOnly = buildOnly("remixCodegen.selectHelperDecls");
/** Refuses in a compiled app. */
export const referencedIds: BuildOnly = buildOnly("remixCodegen.referencedIds");
/** Refuses in a compiled app. */
export const isTypeDecl: BuildOnly = buildOnly("remixCodegen.isTypeDecl");
/** Refuses in a compiled app. */
export const analyzeModule: BuildOnly = buildOnly("remixCodegen.analyzeModule");
/** Refuses in a compiled app. */
export const parseRouteModule: BuildOnly = buildOnly("remixCodegen.parseRouteModule");
/** Refuses in a compiled app. */
export const usedImports: BuildOnly = buildOnly("remixCodegen.usedImports");
/** Refuses in a compiled app. */
export const clientModuleSource: BuildOnly = buildOnly("remixCodegen.clientModuleSource");
/** Refuses in a compiled app. */
export const dataModuleSource: BuildOnly = buildOnly("remixCodegen.dataModuleSource");
/** Refuses in a compiled app. */
export const pageWrapperSource: BuildOnly = buildOnly("remixCodegen.pageWrapperSource");
/** Refuses in a compiled app. */
export const layoutWrapperSource: BuildOnly = buildOnly("remixCodegen.layoutWrapperSource");
/** Refuses in a compiled app. */
export const errorWrapperSource: BuildOnly = buildOnly("remixCodegen.errorWrapperSource");
/** Refuses in a compiled app. */
export const rootNeedsClient: BuildOnly = buildOnly("remixCodegen.rootNeedsClient");
/** Refuses in a compiled app. */
export const serverRootLayoutSource: BuildOnly = buildOnly("remixCodegen.serverRootLayoutSource");
/** Refuses in a compiled app. */
export const pageActionRouteSource: BuildOnly = buildOnly("remixCodegen.pageActionRouteSource");
/** Refuses in a compiled app. */
export const resourceRouteSource: BuildOnly = buildOnly("remixCodegen.resourceRouteSource");
/** Refuses in a compiled app. */
export const importedNames: BuildOnly = buildOnly("remixCodegen.importedNames");
/** Refuses in a compiled app. */
export const rewriteSpecifiers: BuildOnly = buildOnly("remixCodegen.rewriteSpecifiers");
/** Refuses in a compiled app. */
export const stripRootDoc: BuildOnly = buildOnly("remixCodegen.stripRootDoc");
