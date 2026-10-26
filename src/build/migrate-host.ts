/**
 * Internal: the framework modules `@denext/migrate` (the `denext migrate` migrators, published as
 * its own package) is built on. Not a public API — it changes with any release.
 * `@denext/migrate` X.Y.Z imports exactly `@denext/denext` X.Y.Z, and denext X.Y.Z loads exactly
 * `@denext/migrate` X.Y.Z (on first use, by a dynamic import), so both sides always agree on it.
 *
 * @module
 */

export { readFrameworkJson } from "./bundle.ts";
export {
  CAPACITOR_CONFIGS,
  readCapacitorConfig,
  withCapacitorConfigValue,
} from "./capacitor-config.ts";
export { nativeDirsOf } from "./capacitor-native-dirs.ts";
export { CAPACITOR_VERSION, capacitorBuildIgnores, YARN_NO_SCRIPTS_ENV } from "./capacitor-pins.ts";
export { unwrap } from "./config-edit.ts";
export { DENEXT_EXCLUDE } from "./dep-age.ts";
export { DESKTOP_ICON_FILE, detectIconSource } from "./desktop-icon.ts";
export { PLUGIN_USAGE_STRINGS, readExpoAppConfig, readJsonFile } from "./expo-app-config.ts";
export type { ExpoAppConfig } from "./expo-app-config.ts";
export {
  capacitorAppearanceConfig,
  hasAppearance,
  pageBackgroundStyle,
  resolveAppearance,
} from "./expo-appearance.ts";
export { appendGitignore } from "./gitignore.ts";
export { applyJailExceptions } from "./jail-scripts.ts";
export type { JailReport } from "./jail-scripts.ts";
export { confineWrites, dryRunMigration, mfs } from "./migrate-io.ts";
export type { PlannedChange } from "./migrate-io.ts";
export { MOBILE_CAPABILITIES } from "./mobile-capabilities.ts";
export type { CommandRunner, PlannedCommand } from "./mobile-capabilities.ts";
export {
  COMPUTED_ICON_FIX,
  formatIconSearch,
  mobileIconConfig,
  resolveIconSource,
} from "./mobile-icon-source.ts";
export type { IconSearch } from "./mobile-icon-source.ts";
export {
  evalNextConfigProgram,
  LOAD_NEXT_CONFIG,
  NEXT_CONFIG_NEEDS_RUN,
} from "./next-config-eval.ts";
export { projectSourceFiles } from "./platform-extensions.ts";
export { findReactNativeWeb } from "./react-native.ts";
export { REACT_FAMILY_CLIENT, REACT_FAMILY_CORE } from "./react-specifiers.ts";
export {
  analyzeModule,
  clientModuleSource,
  dataModuleSource,
  declaredNames,
  errorWrapperSource,
  freeIdentifiers,
  GEN_HEADER,
  isTypeDecl,
  layoutWrapperSource,
  pageActionRouteSource,
  pageWrapperSource,
  parseRouteModule,
  referencedIds,
  resourceRouteSource,
  rewriteRemixImports,
  rewriteSpecifiers,
  rootNeedsClient,
  selectHelperDecls,
  selectHelpers,
  SERVER_EXPORTS,
  serverRootLayoutSource,
  stripRootDoc,
  usedImports,
} from "./remix-codegen.ts";
export type { HelperDecl, ModuleParts } from "./remix-codegen.ts";
export { ensureVscodeDeno, withDenextUnstable } from "./scaffold.ts";
export { findSqliteWasm } from "./sqlite-wasm.ts";
export { applyEdits, forEachChild, swcParse, txt, walkAst } from "./swc-ast.ts";
export type { Ctx, Edit, Node } from "./swc-ast.ts";
export { resolveTsPaths, tsPathAliases } from "./tsconfig-paths.ts";
export { EXPO_SHIMS } from "../expo/manifest.ts";
export { default as PLUGIN_CATALOG } from "../plugin/catalog.json" with { type: "json" };
export { COMMUNITY_ALIASES } from "../react-native-compat/manifest.ts";
export { normalizeSpaAssetsDir } from "../server/config-validate.ts";
export type { SpaTanstackRouterConfig } from "../server/config.ts";
export { denoSqlHasColumns } from "../server/prisma-adapter/client.ts";
export { VERSION } from "../version.ts";
