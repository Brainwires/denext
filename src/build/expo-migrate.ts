// `denext migrate --from expo`: what an Expo / React Native app needs to build on denext
// (React Native mode, `reactNative: true`) and to ship in a Capacitor shell.
//
// This module only READS the app and computes; migrate.ts writes the files. It covers:
//
//   - the app config: `app.json` (`expo` key or top level) and `app.config.{ts,js,…}`, read
//     STATICALLY — the config is parsed with swc and only literal data is taken (top-level
//     `const`s, member access on them, template literals, `as const`/`satisfies`, spreads of
//     literal arrays/objects, both branches of a `?:` for list-valued fields). Project code is
//     never executed: a value that depends on code (`process.env`, a function call) is
//     reported as not statically readable, and `app.json` is the fallback for it;
//   - the web entry: `main` in package.json, `expo-router/entry`, or Expo's default `App`;
//   - the Capacitor shell: appId / appName, and the `denext mobile add` capabilities the
//     app's `expo-*` packages, config plugins, iOS usage strings, Android permissions,
//     scheme and associated domains call for;
//   - a dependency report: each `expo-*` package's shim status (`EXPO_SHIMS`) and the
//     native-only React Native packages (Nitro, TurboModule / Fabric codegen, Expo native
//     modules) that have no web build.

import { dirname, join } from "@std/path";
import { EXPO_SHIMS } from "../expo/manifest.ts";
import { unwrap } from "./config-edit.ts";
import { MOBILE_CAPABILITIES } from "./mobile-capabilities.ts";
import { type Node, swcParse } from "./swc-ast.ts";

// --- static evaluation --------------------------------------------------------------------

/** A value the static reader could not determine (it depends on code). */
const UNKNOWN: unique symbol = Symbol("unknown");

/** Both branches of a `cond ? a : b` whose branches differ. */
class Alternatives {
  constructor(readonly values: readonly unknown[]) {}
}

/** The module's top-level bindings the reader can follow: `const`s and function declarations. */
interface Scope {
  consts: Map<string, Node>;
  functions: Map<string, Node>;
}

/** Deeper than this, a value is unknown (cycles, pathological configs). */
const MAX_DEPTH = 40;

/** The literal an arrow/function body yields: the expression, or a lone `return`'s argument. */
function returnedExpression(body: Node): Node | null {
  const b = unwrap(body);
  if (b.type !== "BlockStatement") return b.type ? b : null;
  const returns = (b.stmts ?? []).filter((s: Node) => s.type === "ReturnStatement");
  return returns.length === 1 ? returns[0].argument ?? null : null;
}

/** A property key as a string, or null for a computed key the reader cannot name. */
function keyName(key: Node, scope: Scope, depth: number): string | null {
  if (key.type === "Identifier" || key.type === "StringLiteral") return String(key.value);
  if (key.type === "NumericLiteral") return String(key.value);
  if (key.type === "Computed") {
    const v = evaluate(key.expression, scope, depth + 1);
    return typeof v === "string" || typeof v === "number" ? String(v) : null;
  }
  return null;
}

/** An object literal's statically known members (spreads of known objects merged in). */
function evaluateObject(node: Node, scope: Scope, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties ?? []) {
    if (prop.type === "SpreadElement") {
      const spread = evaluate(prop.arguments, scope, depth + 1);
      if (spread && typeof spread === "object" && !(spread instanceof Alternatives)) {
        Object.assign(out, spread);
      }
    } else if (prop.type === "KeyValueProperty") {
      const name = keyName(prop.key, scope, depth);
      if (name !== null) out[name] = evaluate(prop.value, scope, depth + 1);
    } else if (prop.type === "Identifier") {
      out[prop.value] = evaluate(prop, scope, depth + 1);
    }
  }
  return out;
}

/** An array literal's elements; a spread of a `?:` contributes every branch's elements. */
function evaluateArray(node: Node, scope: Scope, depth: number): unknown[] {
  const out: unknown[] = [];
  for (const el of node.elements ?? []) {
    if (!el) continue;
    const value = evaluate(el.expression, scope, depth + 1);
    if (!el.spread) {
      out.push(value);
      continue;
    }
    const branches = value instanceof Alternatives ? value.values : [value];
    for (const branch of branches) if (Array.isArray(branch)) out.push(...branch);
  }
  return out;
}

/** Member access on a known value (`VARIANT.assets.appIcon`). */
function evaluateMember(node: Node, scope: Scope, depth: number): unknown {
  const object = evaluate(node.object, scope, depth + 1);
  if (object === UNKNOWN || object === null || typeof object !== "object") return UNKNOWN;
  if (object instanceof Alternatives) return UNKNOWN;
  const prop = node.property;
  const name = prop.type === "Identifier" ? prop.value : keyName(prop, scope, depth);
  if (name === null) return UNKNOWN;
  return Object.hasOwn(object, name) ? (object as Record<string, unknown>)[name] : UNKNOWN;
}

/** A template literal whose parts are all known strings / numbers. */
function evaluateTemplate(node: Node, scope: Scope, depth: number): unknown {
  let text = "";
  for (const [i, quasi] of (node.quasis ?? []).entries()) {
    text += quasi.cooked ?? quasi.raw ?? "";
    const expr = node.expressions?.[i];
    if (!expr) continue;
    const v = evaluate(expr, scope, depth + 1);
    if (typeof v !== "string" && typeof v !== "number") return UNKNOWN;
    text += String(v);
  }
  return text;
}

/**
 * The static value of an expression: literals, objects, arrays, known `const`s and member
 * access on them, template literals; `?:` yields its branches as {@linkcode Alternatives}
 * (or the value both share). Anything else — calls, `process.env`, operators — is
 * {@linkcode UNKNOWN}. Nothing is executed.
 */
function evaluate(input: Node, scope: Scope, depth = 0): unknown {
  if (!input || depth > MAX_DEPTH) return UNKNOWN;
  const node = unwrap(input);
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "TemplateLiteral":
      return evaluateTemplate(node, scope, depth);
    case "ObjectExpression":
      return evaluateObject(node, scope, depth);
    case "ArrayExpression":
      return evaluateArray(node, scope, depth);
    case "MemberExpression":
      return evaluateMember(node, scope, depth);
    case "Identifier": {
      if (node.value === "undefined") return undefined;
      const init = scope.consts.get(node.value);
      return init ? evaluate(init, scope, depth + 1) : UNKNOWN;
    }
    case "ConditionalExpression": {
      const a = evaluate(node.consequent, scope, depth + 1);
      const b = evaluate(node.alternate, scope, depth + 1);
      return JSON.stringify(a) === JSON.stringify(b) && a !== UNKNOWN
        ? a
        : new Alternatives([a, b]);
    }
    default:
      return UNKNOWN;
  }
}

/** The top-level `const`s and function declarations of a module body. */
function moduleScope(body: Node[]): Scope {
  const scope: Scope = { consts: new Map(), functions: new Map() };
  for (const item of body) {
    declare(scope, item.type === "ExportDeclaration" ? item.declaration : item);
  }
  return scope;
}

/** Record a top-level `const` or function declaration in `scope`. */
function declare(scope: Scope, decl: Node): void {
  if (decl?.type === "FunctionDeclaration" && decl.identifier) {
    scope.functions.set(decl.identifier.value, decl);
    return;
  }
  if (decl?.type !== "VariableDeclaration" || decl.kind !== "const") return;
  for (const d of decl.declarations ?? []) {
    if (d.id?.type === "Identifier" && d.init) scope.consts.set(d.id.value, d.init);
  }
}

/** The expression a module exports as its config, following one level of indirection. */
function exportedConfig(body: Node[], scope: Scope): Node | null {
  let target: Node | null = null;
  for (const item of body) {
    if (item.type === "ExportDefaultExpression") target = item.expression;
    else if (item.type === "ExportDefaultDeclaration") target = item.decl;
    else if (
      item.type === "ExpressionStatement" && item.expression.type === "AssignmentExpression" &&
      item.expression.left?.type === "MemberExpression" &&
      item.expression.left.object?.value === "module" &&
      item.expression.left.property?.value === "exports"
    ) target = item.expression.right;
  }
  if (!target) return null;
  let node = unwrap(target);
  if (node.type === "Identifier") {
    node = scope.consts.get(node.value) ?? scope.functions.get(node.value) ?? node;
    node = unwrap(node);
  }
  const isFunction = node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" || node.type === "FunctionDeclaration";
  return isFunction ? returnedExpression(node.body) : node;
}

/**
 * Read an `app.config.*` source statically.
 *
 * @param source The config module's source.
 * @returns The config object (`expo` key unwrapped), with {@linkcode UNKNOWN} for the parts
 *   that depend on code; or null when no config object could be found.
 */
export async function readStaticAppConfig(
  source: string,
): Promise<Record<string, unknown> | null> {
  let ast: Node;
  try {
    ast = await (await swcParse())(source);
  } catch {
    return null;
  }
  const body: Node[] = ast?.body ?? [];
  const scope = moduleScope(body);
  const node = exportedConfig(body, scope);
  if (!node) return null;
  const value = evaluate(node, scope);
  if (!value || typeof value !== "object" || value instanceof Alternatives) return null;
  const obj = value as Record<string, unknown>;
  return obj.expo && typeof obj.expo === "object" ? obj.expo as Record<string, unknown> : obj;
}

// --- the app config -----------------------------------------------------------------------

/** What migrate needs from the app config. */
export interface ExpoAppConfig {
  /** Where it was read from (`app.config.ts`, `app.json`, both joined by `+`), or null. */
  source: string | null;
  name?: string;
  slug?: string;
  version?: string;
  /** The deep-link schemes (Expo's `scheme`: one or a list). */
  schemes: string[];
  iosBundleIdentifier?: string;
  androidPackage?: string;
  /** Every `ios.infoPlist` key, with its value when it is a static string. */
  infoPlist: Record<string, string | null>;
  /** `android.permissions`, as full names (`android.permission.CAMERA`). */
  androidPermissions: string[];
  /** Config plugin names (every branch of a conditional list). */
  plugins: string[];
  /** Hosts of `ios.associatedDomains` `applinks:` entries. */
  linkDomains: string[];
  /** The statically known subset the app reads at run time (`expo-constants`). */
  runtimeConfig: Record<string, unknown>;
  /** Fields that depend on code (`ios.bundleIdentifier`, …) and could not be read. */
  unresolved: string[];
  /** Notes for the report. */
  notes: string[];
}

/** The config files Expo reads, in its order of precedence. */
const APP_CONFIG_FILES = [
  "app.config.ts",
  "app.config.mts",
  "app.config.js",
  "app.config.mjs",
  "app.config.cjs",
];

/** A known string, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `obj.a.b…` or {@linkcode UNKNOWN} when a step is unknown / missing (undefined). */
function at(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === UNKNOWN) return UNKNOWN;
    if (!cur || typeof cur !== "object" || cur instanceof Alternatives) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * A field from the dynamic config, else from app.json; a field the dynamic config computes
 * is listed as unresolved (and app.json's value, if any, is used).
 */
function pick(
  dynamic: Record<string, unknown> | null,
  json: Record<string, unknown> | null,
  path: string[],
  unresolved: string[],
): unknown {
  const fromDynamic = dynamic ? at(dynamic, path) : undefined;
  const computed = fromDynamic === UNKNOWN || fromDynamic instanceof Alternatives;
  if (fromDynamic !== undefined && !computed) return fromDynamic;
  const fromJson = json ? at(json, path) : undefined;
  if (computed && !str(fromJson)) unresolved.push(path.join("."));
  return fromJson;
}

/** Plain data: {@linkcode UNKNOWN} leaves and conditional values dropped. */
function known(value: unknown): unknown {
  if (value === UNKNOWN || value instanceof Alternatives) return undefined;
  if (Array.isArray(value)) return value.map(known).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const kv = known(v);
      if (kv !== undefined) out[k] = kv;
    }
    // An object whose every member depended on code says nothing.
    const emptied = Object.keys(out).length === 0 && Object.keys(value).length > 0;
    return emptied ? undefined : out;
  }
  return value;
}

/** Every string among `value`'s alternatives / list members. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value instanceof Alternatives) return value.values.flatMap(strings);
  if (Array.isArray(value)) return value.flatMap(strings);
  return [];
}

/**
 * The iOS usage strings Expo's config plugins write from their options
 * (`["expo-camera", { cameraPermission: "…" }]`); `false` turns one off.
 */
const PLUGIN_USAGE_STRINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "expo-camera": {
    cameraPermission: "NSCameraUsageDescription",
    microphonePermission: "NSMicrophoneUsageDescription",
  },
  "expo-audio": { microphonePermission: "NSMicrophoneUsageDescription" },
  "expo-image-picker": {
    photosPermission: "NSPhotoLibraryUsageDescription",
    cameraPermission: "NSCameraUsageDescription",
    microphonePermission: "NSMicrophoneUsageDescription",
  },
  "expo-media-library": {
    photosPermission: "NSPhotoLibraryUsageDescription",
    savePhotosPermission: "NSPhotoLibraryAddUsageDescription",
  },
  "expo-location": {
    locationWhenInUsePermission: "NSLocationWhenInUseUsageDescription",
    locationAlwaysAndWhenInUsePermission: "NSLocationAlwaysAndWhenInUseUsageDescription",
  },
  "expo-contacts": { contactsPermission: "NSContactsUsageDescription" },
  "expo-calendar": { calendarPermission: "NSCalendarsUsageDescription" },
  "expo-local-authentication": { faceIDPermission: "NSFaceIDUsageDescription" },
};

/** The usage strings the config plugins' options set (a static string, or null when computed). */
function pluginUsageStrings(value: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const entry of Array.isArray(value) ? value : []) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const keys = PLUGIN_USAGE_STRINGS[entry[0]];
    const options = entry[1];
    if (!keys || !options || typeof options !== "object") continue;
    for (const [option, plistKey] of Object.entries(keys)) {
      const v = (options as Record<string, unknown>)[option];
      if (v === false || v === undefined) continue;
      out[plistKey] = str(v) ?? null;
    }
  }
  return out;
}

/** Config plugin names: `"expo-camera"` or `["expo-camera", {…}]`. */
function pluginNames(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const names = list.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (Array.isArray(entry) && typeof entry[0] === "string") return [entry[0]];
    return [];
  });
  return [...new Set(names)];
}

/** Read `path` as JSON, or null. */
async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await Deno.readTextFile(path));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** The top-level app-config keys worth handing to the app at run time (not native build config). */
const RUNTIME_KEYS = [
  "name",
  "slug",
  "version",
  "scheme",
  "owner",
  "description",
  "orientation",
  "userInterfaceStyle",
  "primaryColor",
  "updates",
  "extra",
];

/** The dynamic config file's static value, or null with a note when it has none. */
async function readDynamicConfig(
  dir: string,
  notes: string[],
): Promise<{ file: string | null; value: Record<string, unknown> | null }> {
  for (const file of APP_CONFIG_FILES) {
    let source: string;
    try {
      source = await Deno.readTextFile(join(dir, file));
    } catch {
      continue;
    }
    const value = await readStaticAppConfig(source);
    if (!value) {
      notes.push(
        `${file} could not be read statically (it computes its config in code; migrate ` +
          "never runs project code), so app.json's values are used.",
      );
    }
    return { file, value };
  }
  return { file: null, value: null };
}

/**
 * Read the app config of the Expo app at `dir` without running it.
 *
 * @param dir The app directory.
 * @returns What migrate needs, with the fields it could not read listed.
 */
export async function readExpoAppConfig(dir: string): Promise<ExpoAppConfig> {
  const notes: string[] = [];
  const unresolved: string[] = [];
  const raw = await readJsonFile(join(dir, "app.json"));
  const json = raw
    ? (raw.expo && typeof raw.expo === "object" ? raw.expo : raw) as Record<
      string,
      unknown
    >
    : null;
  const dynamic = await readDynamicConfig(dir, notes);
  const d = dynamic.value;
  const get = (...path: string[]) => pick(d, json, path, unresolved);
  const both = (...path: string[]) => [...strings(at(json, path)), ...strings(at(d, path))];
  const sources = [dynamic.file, raw ? "app.json" : null].filter(Boolean);
  return {
    source: sources.length > 0 ? sources.join(" + ") : null,
    name: str(get("name")),
    slug: str(get("slug")),
    version: str(get("version")),
    schemes: [...new Set(strings(get("scheme")))],
    iosBundleIdentifier: str(get("ios", "bundleIdentifier")),
    androidPackage: str(get("android", "package")),
    infoPlist: usageStrings([json, d]),
    androidPermissions: [
      ...new Set(
        both("android", "permissions").map((p) => p.includes(".") ? p : `android.permission.${p}`),
      ),
    ],
    plugins: [
      ...new Set([...pluginNames(at(json, ["plugins"])), ...pluginNames(at(d, ["plugins"]))]),
    ],
    linkDomains: [...new Set(both("ios", "associatedDomains").flatMap(applinksHost))],
    runtimeConfig: runtimeSubset(json, d),
    unresolved: [...new Set(unresolved)],
    notes,
  };
}

/** Every `ios.infoPlist` key (and the usage strings config plugins write), with static values. */
function usageStrings(sources: unknown[]): Record<string, string | null> {
  const infoPlist: Record<string, string | null> = {};
  for (const source of sources) {
    Object.assign(infoPlist, pluginUsageStrings(at(source, ["plugins"])));
    const plist = at(source, ["ios", "infoPlist"]);
    if (!plist || typeof plist !== "object" || plist instanceof Alternatives) continue;
    for (const [key, value] of Object.entries(plist)) infoPlist[key] = str(value) ?? null;
  }
  return infoPlist;
}

/** The host of an `applinks:` associated domain, as a list (empty for other entries). */
function applinksHost(entry: string): string[] {
  const m = /^applinks:([^?/]+)/.exec(entry);
  return m ? [m[1]] : [];
}

/** The runtime keys' static values: the dynamic config's where it sets them, else app.json's. */
function runtimeSubset(
  json: Record<string, unknown> | null,
  dynamic: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RUNTIME_KEYS) {
    const fromDynamic = dynamic ? at(dynamic, [key]) : undefined;
    const v = known(fromDynamic !== undefined ? fromDynamic : at(json, [key]));
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// --- the entry ----------------------------------------------------------------------------

/** How the app starts on the web. */
export interface ExpoEntry {
  /** The SPA entry, `./`-relative. */
  entry: string;
  /**
   * A web entry migrate writes: for Expo's default `App` entry (no file of its own), or
   * expo-router's entry without Metro's runtime.
   */
  generated?: { path: string; source: string; kind: "app" | "expo-router" };
  /** The app uses expo-router (its `main` is `expo-router/entry`, or it depends on it). */
  expoRouter: boolean;
}

/** Source extensions an entry may have, in the order Metro prefers them. */
const ENTRY_EXTS = [".tsx", ".ts", ".jsx", ".js"];

/** The first `base + ext` that exists, as a `./`-relative path, or null. */
async function probeEntry(dir: string, base: string): Promise<string | null> {
  const plain = base.replace(/^\.\//, "");
  const candidates = /\.[cm]?[jt]sx?$/.test(plain) ? [plain] : ENTRY_EXTS.map((e) => plain + e);
  for (const rel of [...candidates, ...ENTRY_EXTS.map((e) => join(plain, "index" + e))]) {
    try {
      if ((await Deno.stat(join(dir, rel))).isFile) return "./" + rel.replaceAll("\\", "/");
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * The web entry for an expo-router app: expo-router's own `entry-classic` minus its first
 * import, `@expo/metro-runtime` (Metro's module runtime and HMR client, which the denext bundle
 * replaces). The routes come from React Native mode's generated `expo-router/_ctx`.
 */
const EXPO_ROUTER_ENTRY =
  `// ${"index.web.ts"} — expo-router's web entry (expo-router/entry-classic) without
// @expo/metro-runtime, Metro's own runtime. denext generates the route context from app/.
import { App } from "expo-router/build/qualified-entry";
import { renderRootComponent } from "expo-router/build/renderRootComponent";

renderRootComponent(App);
`;

/** The web entry migrate writes for Expo's default `App` entry (`expo/AppEntry`). */
const EXPO_DEFAULT_ENTRY_FILE = "index.web.ts";

/**
 * The web entry of the Expo app at `dir`: package.json `main` when it is a file of the app;
 * for `expo-router/entry`, that; with no `main` (or `expo/AppEntry`), Expo's default — the
 * app's `App` component, mounted by a small generated entry.
 *
 * @param dir The app directory.
 * @param pkg The app's package.json.
 * @param deps Its dependencies.
 * @returns The entry, or null when none was found.
 */
export async function expoWebEntry(
  dir: string,
  pkg: Record<string, unknown>,
  deps: Record<string, string>,
): Promise<ExpoEntry | null> {
  const main = typeof pkg.main === "string" ? pkg.main : undefined;
  const expoRouter = main === "expo-router/entry" || "expo-router" in deps;
  if (main === "expo-router/entry" || main === "expo-router/entry-classic") {
    return {
      entry: "./" + EXPO_DEFAULT_ENTRY_FILE,
      generated: { path: EXPO_DEFAULT_ENTRY_FILE, source: EXPO_ROUTER_ENTRY, kind: "expo-router" },
      expoRouter,
    };
  }
  if (main && !/^expo\/AppEntry(\.js)?$/.test(main)) {
    const entry = await probeEntry(dir, main);
    return entry ? { entry, expoRouter } : null;
  }
  const app = await probeEntry(dir, "App");
  if (!app) return null;
  const source =
    `// ${EXPO_DEFAULT_ENTRY_FILE} — written by \`denext migrate\`: Expo's default entry
// (expo/AppEntry) mounts ./App; denext needs the entry as a file of the app.
import { registerRootComponent } from "expo";
import App from ${JSON.stringify(app.replace(/\.[jt]sx?$/, ""))};

registerRootComponent(App);
`;
  return {
    entry: "./" + EXPO_DEFAULT_ENTRY_FILE,
    generated: { path: EXPO_DEFAULT_ENTRY_FILE, source, kind: "app" },
    expoRouter,
  };
}

// --- capabilities -------------------------------------------------------------------------

/** One `denext mobile add` capability and why migrate suggests it. */
export interface CapabilitySuggestion {
  readonly capability: string;
  readonly because: string;
}

/** The capability each `expo-*` package's shim calls natively. */
const PACKAGE_CAPABILITIES: Readonly<Record<string, string>> = {
  "expo-haptics": "haptics",
  "expo-clipboard": "clipboard",
  "expo-sharing": "share",
  "expo-device": "device",
  "expo-network": "network",
  "expo-keep-awake": "keep-awake",
  "expo-splash-screen": "splash",
  "expo-secure-store": "secure-store",
  "expo-web-browser": "browser",
  "expo-linking": "deep-links",
  "expo-auth-session": "auth-session",
  "expo-notifications": "push",
  "expo-file-system": "filesystem",
  "expo-image-picker": "camera",
  "expo-camera": "barcode",
  "expo-document-picker": "document-picker",
  "expo-quick-actions": "quick-actions",
  "expo-sqlite": "sqlite",
};

/** iOS usage strings a capability writes itself (key → capability). */
const PLIST_CAPABILITIES: Readonly<Record<string, string>> = {
  NSCameraUsageDescription: "camera",
  NSPhotoLibraryUsageDescription: "camera",
  NSPhotoLibraryAddUsageDescription: "camera",
};

/** Android permissions a capability declares itself (permission → capability). */
const PERMISSION_CAPABILITIES: Readonly<Record<string, string>> = {
  "android.permission.CAMERA": "camera",
  "android.permission.POST_NOTIFICATIONS": "push",
  "android.permission.ACCESS_NETWORK_STATE": "network",
  "android.permission.VIBRATE": "haptics",
};

/** What `denext mobile add` should install, and what it cannot carry over. */
export interface MobilePlan {
  /** Capabilities, in `MOBILE_CAPABILITIES` order, with the first reason each was chosen. */
  capabilities: CapabilitySuggestion[];
  /** `--scheme` values (deep-links, auth-session). */
  schemes: string[];
  /** `--domain` values (deep-links). */
  domains: string[];
  /** The full command. */
  command: string | null;
  /** iOS usage strings no capability writes: copy them into ios/App/App/Info.plist. */
  manualPlist: Record<string, string | null>;
  /** Android permissions no capability declares: add them to AndroidManifest.xml. */
  manualPermissions: string[];
}

/** Expo's Android permission shorthands that are not permissions of their own. */
const IGNORED_PERMISSIONS = new Set(["android.permission.INTERNET"]);

/** The capability plan for an app's packages and config. */
export function expoMobilePlan(deps: Record<string, string>, config: ExpoAppConfig): MobilePlan {
  const chosen = new Map<string, string>();
  const add = (capability: string | undefined, because: string) => {
    if (capability && Object.hasOwn(MOBILE_CAPABILITIES, capability) && !chosen.has(capability)) {
      chosen.set(capability, because);
    }
  };
  for (const pkg of Object.keys(deps).sort()) add(PACKAGE_CAPABILITIES[pkg], pkg);
  for (const plugin of config.plugins) {
    add(PACKAGE_CAPABILITIES[plugin], `config plugin ${plugin}`);
  }
  const manualPlist = plistCapabilities(config.infoPlist, add);
  const manualPermissions = permissionCapabilities(config.androidPermissions, add);
  if (config.schemes.length > 0) add("deep-links", `scheme ${config.schemes.join(", ")}`);
  if (config.linkDomains.length > 0) add("deep-links", "ios.associatedDomains applinks");
  const order = Object.keys(MOBILE_CAPABILITIES);
  const capabilities = [...chosen].map(([capability, because]) => ({ capability, because }))
    .sort((a, b) => order.indexOf(a.capability) - order.indexOf(b.capability));
  const schemes = schemeArgs(chosen, config);
  const domains = chosen.has("deep-links") ? config.linkDomains : [];
  const command = capabilities.length === 0 ? null : [
    "denext mobile add",
    ...capabilities.map((c) => c.capability),
    ...schemes.map((s) => `--scheme ${s}`),
    ...domains.map((d) => `--domain ${d}`),
  ].join(" ");
  return { capabilities, schemes, domains, command, manualPlist, manualPermissions };
}

/**
 * The capabilities the app's usage strings call for, and the strings to carry over by hand:
 * every one the app sets, since `mobile add` writes only its own capabilities' keys, and only
 * a default when the key is absent (the app's text wins).
 */
function plistCapabilities(
  infoPlist: Record<string, string | null>,
  add: (capability: string | undefined, because: string) => void,
): Record<string, string | null> {
  const manual: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(infoPlist)) {
    if (!/UsageDescription$/.test(key)) continue;
    add(PLIST_CAPABILITIES[key], `ios.infoPlist ${key}`);
    manual[key] = value;
  }
  return manual;
}

/** The capabilities the app's Android permissions call for, and the permissions left over. */
function permissionCapabilities(
  permissions: string[],
  add: (capability: string | undefined, because: string) => void,
): string[] {
  const manual: string[] = [];
  for (const permission of permissions) {
    const cap = PERMISSION_CAPABILITIES[permission];
    if (cap) add(cap, `android.permissions ${permission.replace("android.permission.", "")}`);
    else if (!IGNORED_PERMISSIONS.has(permission)) manual.push(permission);
  }
  return manual;
}

/**
 * The `--scheme` values: the config's schemes. auth-session needs a scheme, and deep-links a
 * scheme or a domain: one the config computes in code (or lacks) still has to be passed, so
 * the command then carries a placeholder.
 */
function schemeArgs(chosen: Map<string, string>, config: ExpoAppConfig): string[] {
  if (!chosen.has("deep-links") && !chosen.has("auth-session")) return [];
  if (config.schemes.length > 0) return config.schemes;
  const needsScheme = chosen.has("auth-session") || config.linkDomains.length === 0;
  return needsScheme ? ["<scheme>"] : [];
}

// --- dependencies -------------------------------------------------------------------------

/** One `expo-*` dependency's standing under denext. */
export interface ExpoPackageStatus {
  readonly name: string;
  /** `full` / `partial` / `stub`: the `denext/expo` shim; `none`: resolves to the real package. */
  readonly status: "full" | "partial" | "stub" | "none";
  /** Exports the shim does not provide. */
  readonly omitted: number;
}

/** A dependency that needs a native runtime a WebView does not have. */
export interface NativeOnlyPackage {
  readonly name: string;
  /** What makes it native-only (`Nitro module`, `TurboModule / Fabric codegen`, …). */
  readonly kind: string;
}

/** The dependency report. */
export interface ExpoDependencyReport {
  readonly expo: ExpoPackageStatus[];
  readonly nativeOnly: NativeOnlyPackage[];
  /** Dependencies not installed, so not classified. */
  readonly notInstalled: string[];
}

/** Packages denext provides or that are the app's own toolchain: never native-only here. */
const SKIP_DEPS =
  /^(react|react-dom|react-native|react-native-web|@types\/.*|typescript|expo|expo-.*)$/;

/** Packages whose web build is outside their own tree (react-native-web itself, …). */
const WEB_FIELDS = ["browser"];

/** Where `name` is installed for the app at `dir` (walking up node_modules), or null. */
async function packageDir(dir: string, name: string, spec: string): Promise<string | null> {
  const local = /^(?:file|link):(.+)$/.exec(spec);
  if (local) {
    try {
      return await Deno.realPath(join(dir, local[1]));
    } catch {
      return null;
    }
  }
  let cur = dir;
  for (;;) {
    // pnpm keeps every package it installed, the transitive ones included, in its virtual
    // store's own node_modules.
    for (
      const base of [join(cur, "node_modules"), join(cur, "node_modules", ".pnpm", "node_modules")]
    ) {
      try {
        return await Deno.realPath(join(base, name));
      } catch { /* not here */ }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Whether the package tree carries a `.web.*` module (a web build), searched a few levels deep. */
async function hasWebModule(root: string, depth = 0): Promise<boolean> {
  if (depth > 4) return false;
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isFile && /\.web\.[cm]?[jt]sx?$/.test(entry.name)) return true;
      if (entry.isDirectory && await hasWebModule(join(root, entry.name), depth + 1)) return true;
    }
  } catch { /* unreadable: no */ }
  return false;
}

/** Why the package at `root` is native-only, or null when it is not (or has a web build). */
async function nativeOnlyKind(name: string, root: string): Promise<string | null> {
  const pkg = await readJsonFile(join(root, "package.json")) ?? {};
  const exists = async (rel: string) => {
    try {
      await Deno.stat(join(root, rel));
      return true;
    } catch {
      return false;
    }
  };
  let kind: string | null = null;
  if (/nitro/.test(name) || await exists("nitro.json")) kind = "Nitro module (JSI)";
  else if (pkg.codegenConfig) kind = "TurboModule / Fabric component (codegen)";
  else if (await exists("expo-module.config.json")) {
    const module = await readJsonFile(join(root, "expo-module.config.json"));
    const platforms = Array.isArray(module?.platforms) ? module.platforms as string[] : [];
    if (!platforms.includes("web")) kind = "Expo native module";
  }
  if (!kind) {
    const file = await platformOnlyModule(root);
    return file ? `iOS / Android files only (${file} has no web or plain variant)` : null;
  }
  if (WEB_FIELDS.some((f) => f in pkg) || await hasWebModule(root)) return null;
  return kind;
}

/** Source extensions a platform variant may have. */
const VARIANT_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs"];

/**
 * The first module (package-relative, extensionless) that exists only as `.ios.*` /
 * `.android.*` variants, with no plain or `.web.*` file beside it — an import of it cannot
 * resolve on the web. Searched a few levels deep; null when there is none.
 */
async function platformOnlyModule(root: string, rel = "", depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  const listing = await listDir(join(root, rel));
  if (!listing) return null;
  const base = platformOnlyBase(listing.files);
  if (base) return rel ? `${rel}/${base}` : base;
  for (const d of listing.dirs) {
    const hit = await platformOnlyModule(root, rel ? `${rel}/${d}` : d, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** A folder's file names and its sub-folders (not `node_modules` or dot folders), or null. */
async function listDir(path: string): Promise<{ files: Set<string>; dirs: string[] } | null> {
  const files = new Set<string>();
  const dirs: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isFile) files.add(entry.name);
      else if (entry.isDirectory && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        dirs.push(entry.name);
      }
    }
  } catch {
    return null;
  }
  return { files, dirs };
}

/** The first module among `files` that exists only as `.ios.*` / `.android.*`, or null. */
function platformOnlyBase(files: Set<string>): string | null {
  for (const name of files) {
    const m = /^(.+)\.(?:ios|android)\.[cm]?[jt]sx?$/.exec(name);
    if (!m || m[1].endsWith(".d")) continue;
    const base = m[1];
    const other = VARIANT_EXTS.some((ext) =>
      files.has(base + ext) || files.has(`${base}.web${ext}`)
    );
    if (!other) return base;
  }
  return null;
}

/**
 * The `expo-*` packages' shim status and the native-only packages among the app's
 * dependencies.
 *
 * @param dir The app directory.
 * @param deps Its dependencies (name → version spec).
 */
export async function expoDependencyReport(
  dir: string,
  deps: Record<string, string>,
): Promise<ExpoDependencyReport> {
  const expo: ExpoPackageStatus[] = [];
  const nativeOnly: NativeOnlyPackage[] = [];
  const notInstalled: string[] = [];
  for (const [name, spec] of Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))) {
    if (/^expo(-|$)/.test(name)) {
      const shim = Object.hasOwn(EXPO_SHIMS, name) ? EXPO_SHIMS[name] : undefined;
      expo.push({
        name,
        status: shim?.status ?? "none",
        omitted: shim?.omitted?.length ?? 0,
      });
      continue;
    }
    if (SKIP_DEPS.test(name)) continue;
    const root = await packageDir(dir, name, spec);
    if (!root) {
      notInstalled.push(name);
      continue;
    }
    const kind = await nativeOnlyKind(name, root);
    if (kind) nativeOnly.push({ name, kind });
  }
  return { expo, nativeOnly, notInstalled };
}

// --- the Metro config ---------------------------------------------------------------------

/** What the app's Metro config does to module resolution that the denext build does not. */
export interface MetroResolution {
  /** The config file, or null when the app has none. */
  file: string | null;
  /** `resolver.extraNodeModules` names that are not installed packages (Metro-only modules). */
  extraModules: string[];
  /** The config sets a custom `resolveRequest`. */
  resolveRequest: boolean;
}

/** The Metro config files, in the order Expo's CLI looks for them. */
const METRO_CONFIG_FILES = ["metro.config.js", "metro.config.cjs", "metro.config.ts"];

/** Every property named `name` in an AST (a shallow generic walk). */
function propertiesNamed(node: Node, name: string, out: Node[] = []): Node[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) propertiesNamed(child, name, out);
    return out;
  }
  const key = node.type === "KeyValueProperty" || node.type === "MethodProperty" ? node.key : null;
  if (key && (key.type === "Identifier" || key.type === "StringLiteral") && key.value === name) {
    out.push(node);
  }
  for (const [k, child] of Object.entries(node)) {
    if (k !== "span" && child && typeof child === "object") propertiesNamed(child, name, out);
  }
  return out;
}

/**
 * The resolution the app's Metro config adds, read statically (never run): the
 * `extraNodeModules` names that no installed package provides, and whether it sets a custom
 * `resolveRequest`. Each such module needs a mapping of its own in `deno.json` `imports`.
 *
 * @param dir The app directory.
 * @param deps The app's dependencies (name → version spec).
 */
export async function readMetroResolution(
  dir: string,
  deps: Record<string, string>,
): Promise<MetroResolution> {
  for (const file of METRO_CONFIG_FILES) {
    const source = await Deno.readTextFile(join(dir, file)).catch(() => null);
    if (source === null) continue;
    const ast = await swcParse().then((parse) => parse(source)).catch(() => null);
    if (!ast) return { file, extraModules: [], resolveRequest: false };
    const extraModules: string[] = [];
    for (const name of extraNodeModuleNames(ast)) {
      if (!(await packageDir(dir, name, deps[name] ?? ""))) extraModules.push(name);
    }
    const resolveRequest = propertiesNamed(ast, "resolveRequest").length > 0;
    return { file, extraModules, resolveRequest };
  }
  return { file: null, extraModules: [], resolveRequest: false };
}

/** The literal keys of every `extraNodeModules` object in a Metro config, sorted. */
function extraNodeModuleNames(ast: Node): string[] {
  const names = new Set<string>();
  for (const prop of propertiesNamed(ast, "extraNodeModules")) {
    for (const member of unwrap(prop.value).properties ?? []) {
      const key = member.key;
      if (key?.type === "StringLiteral" || key?.type === "Identifier") names.add(key.value);
    }
  }
  return [...names].sort();
}

// --- generated files ----------------------------------------------------------------------

/** A reverse-DNS id segment from free text (`"T3 Code"` → `"t3code"`). */
function idSegment(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(s) ? s : `app${s}`;
}

/** The Capacitor app id and name for the app. */
export function capacitorIdentity(
  config: ExpoAppConfig,
  fallbackName: string,
): { appId: string; appName: string; placeholderId: boolean } {
  const appName = config.name ?? config.slug ?? fallbackName;
  const id = config.iosBundleIdentifier ?? config.androidPackage;
  if (id) return { appId: id, appName, placeholderId: false };
  return {
    appId: `com.example.${idSegment(config.slug ?? appName)}`,
    appName,
    placeholderId: true,
  };
}

/**
 * The generated `capacitor.config.ts`: the app's id and name, the static export as the web
 * directory.
 *
 * @param marker The migrate marker comment line.
 * @param identity The app id and name.
 */
export function capacitorConfigSource(
  marker: string,
  identity: { appId: string; appName: string; placeholderId: boolean },
): string {
  const todo = identity.placeholderId
    ? "  // TODO: a placeholder — the app config's bundle identifier could not be read.\n"
    : "";
  return `${marker}
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
${todo}  appId: ${JSON.stringify(identity.appId)},
  appName: ${JSON.stringify(identity.appName)},
  // denext's static export (\`deno task export\`) writes here; Capacitor bundles it.
  webDir: "out",
};

export default config;
`;
}

/** The Capacitor release the shell targets (Capacitor 8, as every `mobile add` plugin). */
const CAPACITOR_VERSION = "^8.5.2";

/** The `mobile:*` tasks, as `denext create --capacitor` writes them. */
export function capacitorTasks(cli: string): Record<string, string> {
  const cap = `deno run -A --node-modules-dir npm:@capacitor/cli@${CAPACITOR_VERSION}`;
  return {
    "mobile:sync": `deno task export && deno run -A ${cli} ota manifest out && ${cap} sync`,
    "mobile:ios": `${cap} open ios`,
    "mobile:android": `${cap} open android`,
  };
}

/**
 * A `<script>` setting `globalThis.__DENEXT_EXPO_CONFIG__` (what `expo-constants` reads) to
 * the config's static runtime subset, safe inside HTML.
 *
 * @param runtimeConfig The subset ({@linkcode ExpoAppConfig.runtimeConfig}).
 */
export function expoConfigScript(runtimeConfig: Record<string, unknown>): string {
  const json = JSON.stringify(runtimeConfig).replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script>globalThis.__DENEXT_EXPO_CONFIG__=${json}</script>`;
}

/** Folders Expo's prebuild writes that a Capacitor shell would also claim. */
export async function prebuildFolders(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ["ios", "android"]) {
    try {
      if ((await Deno.stat(join(dir, name))).isDirectory) found.push(name);
    } catch { /* absent */ }
  }
  return found;
}
