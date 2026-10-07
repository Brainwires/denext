// The Expo app config (`app.json` / `app.config.*`), read STATICALLY: the config is parsed with
// swc and only literal data is taken (top-level `const`s, member access on them, template
// literals, `as const`/`satisfies`, spreads of literal arrays/objects, both branches of a `?:` for
// list-valued fields). Project code is never executed: a value that depends on code
// (`process.env`, a function call) is reported as not statically readable, and `app.json` is the
// fallback for it. Shared by `denext migrate --from expo` (./expo-migrate.ts) and
// `denext mobile add app-config` (./mobile-expo-app-config.ts).

import { join } from "@std/path";
import { unwrap } from "./config-edit.ts";
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
  /** `expo-build-properties`' static options, when the app lists the plugin with options. */
  buildProperties?: ExpoBuildProperties;
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
export const PLUGIN_USAGE_STRINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
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
  "expo-calendar": {
    calendarPermission: "NSCalendarsUsageDescription",
    remindersPermission: "NSRemindersUsageDescription",
  },
  "expo-local-authentication": { faceIDPermission: "NSFaceIDUsageDescription" },
  "expo-secure-store": { faceIDPermission: "NSFaceIDUsageDescription" },
  "expo-sensors": { motionPermission: "NSMotionUsageDescription" },
  "expo-tracking-transparency": { userTrackingPermission: "NSUserTrackingUsageDescription" },
  "expo-av": { microphonePermission: "NSMicrophoneUsageDescription" },
  "expo-video": { microphonePermission: "NSMicrophoneUsageDescription" },
  "expo-maps": { requestLocationPermission: "NSLocationWhenInUseUsageDescription" },
};

/**
 * The native build settings of `expo-build-properties` that `denext mobile add app-config`
 * carries into the Capacitor shell (each only ever raised), and the options it cannot.
 */
export interface ExpoBuildProperties {
  /** `ios.deploymentTarget` (`"16.0"`). */
  iosDeploymentTarget?: string;
  /** `android.minSdkVersion`. */
  androidMinSdk?: number;
  /** `android.compileSdkVersion`. */
  androidCompileSdk?: number;
  /** `android.targetSdkVersion`. */
  androidTargetSdk?: number;
  /** `android.usesCleartextTraffic`. */
  usesCleartextTraffic?: boolean;
  /** Options set that have no Capacitor counterpart here (`ios.useFrameworks`, …). */
  unmapped: string[];
}

/** The `expo-build-properties` options carried over, by platform. */
const BUILD_PROPERTY_KEYS: Readonly<Record<string, readonly string[]>> = {
  ios: ["deploymentTarget"],
  android: ["minSdkVersion", "compileSdkVersion", "targetSdkVersion", "usesCleartextTraffic"],
};

/** A whole number, or undefined. */
function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The static options of the `expo-build-properties` plugin entry in `value`, or undefined. */
function buildPropertiesOf(value: unknown): ExpoBuildProperties | undefined {
  const list = Array.isArray(value) ? value : [];
  const entry = list.find((e) => Array.isArray(e) && e[0] === "expo-build-properties");
  const options = Array.isArray(entry) ? known(entry[1]) : undefined;
  if (!options || typeof options !== "object") return undefined;
  const ios = (options as Record<string, unknown>).ios as Record<string, unknown> | undefined;
  const android = (options as Record<string, unknown>).android as
    | Record<string, unknown>
    | undefined;
  const unmapped: string[] = [];
  for (const [platform, settings] of [["ios", ios], ["android", android]] as const) {
    if (!settings || typeof settings !== "object") continue;
    for (const key of Object.keys(settings)) {
      if (!BUILD_PROPERTY_KEYS[platform].includes(key)) unmapped.push(`${platform}.${key}`);
    }
  }
  return {
    iosDeploymentTarget: str(ios?.deploymentTarget),
    androidMinSdk: int(android?.minSdkVersion),
    androidCompileSdk: int(android?.compileSdkVersion),
    androidTargetSdk: int(android?.targetSdkVersion),
    usesCleartextTraffic: typeof android?.usesCleartextTraffic === "boolean"
      ? android.usesCleartextTraffic
      : undefined,
    unmapped,
  };
}

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
export async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
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
    buildProperties: buildPropertiesOf(at(d, ["plugins"])) ??
      buildPropertiesOf(at(json, ["plugins"])),
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
