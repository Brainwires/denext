// The Expo SDK shims that call a pinned Capacitor plugin directly (`denext/expo/contacts`, …)
// declare the plugin's JS surface themselves, and their tests run against hand-written fakes of
// that declaration. This module checks the declaration against the plugin's own published types,
// offline: the pinned version's `.d.ts` files are vendored under
// `baselines/expo-plugins/<package>/`, and tests/expo-plugin-definitions.test.ts type-checks every
// method each shim declares (its name, the arguments it passes, the result fields it reads)
// against them, plus the name the shim looks the plugin up by.
//
//   deno task parity:native:plugins     # re-vendor the pinned versions' types (needs the network)
//
// Run it after changing a pin in src/build/mobile-capabilities-expo.ts, review the diff, then run
// the test. Re-vendoring takes the newest version the pin's caret range admits.

import { dirname, fromFileUrl, join, relative } from "@std/path";
import { EXPO_SDK_CAPABILITIES } from "../../../src/build/mobile-capabilities-expo.ts";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));

/** Where the vendored types and their index live. */
export const PLUGIN_BASELINE_DIR = join(ROOT, "scripts/parity/native/baselines/expo-plugins");
/** The index: one entry per capability. */
export const PLUGIN_BASELINE_INDEX = join(PLUGIN_BASELINE_DIR, "index.json");

/** A shim that declares a plugin's surface, and the capability that pins the plugin. */
export interface ExpoPluginShim {
  /** The `denext mobile add` capability (a key of `EXPO_SDK_CAPABILITIES`). */
  readonly capability: string;
  /** The shim's source, relative to the repository root. */
  readonly shim: string;
  /** The interface the shim declares for the plugin (passed to `nativePlugin<…>`). */
  readonly shimInterface: string;
}

/** Every Expo shim over a plugin pinned in `EXPO_SDK_CAPABILITIES`. */
export const EXPO_PLUGIN_SHIMS: readonly ExpoPluginShim[] = [
  {
    capability: "brightness",
    shim: "src/expo/brightness.ts",
    shimInterface: "ScreenBrightnessPlugin",
  },
  { capability: "print", shim: "src/expo/print.ts", shimInterface: "PrinterPlugin" },
  {
    capability: "intent-launcher",
    shim: "src/expo/intent-launcher.ts",
    shimInterface: "IntentLauncherPlugin",
  },
  { capability: "contacts", shim: "src/expo/contacts.ts", shimInterface: "ContactsPlugin" },
  { capability: "calendar", shim: "src/expo/calendar.ts", shimInterface: "CalendarPlugin" },
  { capability: "text-to-speech", shim: "src/expo/speech.ts", shimInterface: "TextToSpeechPlugin" },
];

/** One vendored plugin. */
export interface VendoredPlugin {
  /** The npm package. */
  npm: string;
  /** The version vendored (within the pin's range). */
  version: string;
  /** The name the plugin registers under (`registerPlugin("…")`), which the shim looks up. */
  pluginName: string;
  /** The plugin's interface in `definitions.d.ts`. */
  pluginInterface: string;
  /** `definitions.d.ts`, relative to `PLUGIN_BASELINE_DIR`. */
  definitions: string;
}

/** The index file: capability → vendored plugin. */
export type VendoredIndex = Record<string, VendoredPlugin>;

/**
 * The `@capacitor/core` types the plugins' declarations import, as @capacitor/core 8 defines them.
 * The vendored files import this stub instead of the package; re-vendoring fails on a name it lacks.
 */
const CAPACITOR_CORE_STUB =
  `// The @capacitor/core 8 types the vendored plugin declarations import (as the package defines them).
export type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";
export interface PluginListenerHandle {
  remove: () => Promise<void>;
}
`;
const CAPACITOR_CORE_NAMES = new Set(["PermissionState", "PluginListenerHandle"]);

/** Whether `version` is within the caret range `range` (`^x.y.z`, as every pin here is). */
export function caretAdmits(range: string, version: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || !v) return false;
  const [a, b] = [m.slice(1).map(Number), v.slice(1).map(Number)];
  if (b[0] !== a[0]) return false;
  for (let i = 1; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i];
  return true;
}

/** The highest published (non-prerelease) version the range admits. */
function newestAdmitted(range: string, versions: string[]): string {
  const ok = versions.filter((v) => caretAdmits(range, v));
  if (ok.length === 0) throw new Error(`no published version satisfies ${range}`);
  const key = (v: string) => v.split(".").map(Number);
  return ok.sort((x, y) => {
    const [a, b] = [key(x), key(y)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  }).at(-1)!;
}

/** Rewrite a declaration file's imports: `@capacitor/core` → the stub, relative ones → `.d.ts`. */
function rewriteImports(text: string, file: string, coreStub: string): string {
  return text.replace(
    /(from\s+|import\s+)(['"])([^'"]+)\2/g,
    (all, kw: string, q: string, spec: string) => {
      if (spec === "@capacitor/core") return `${kw}${q}${coreStub}${q}`;
      if (spec.startsWith(".")) return spec.endsWith(".d.ts") ? all : `${kw}${q}${spec}.d.ts${q}`;
      throw new Error(`${file}: an import of ${spec} (only @capacitor/core is stubbed)`);
    },
  );
}

/** Download `npm@version` and unpack it into `dir` (its files under `dir/package/`). */
async function unpack(tarball: string, dir: string): Promise<void> {
  const tgz = new Uint8Array(await (await fetch(tarball)).arrayBuffer());
  const tar = new Deno.Command("tar", { args: ["-xz", "-C", dir], stdin: "piped" }).spawn();
  const w = tar.stdin.getWriter();
  await w.write(tgz);
  await w.close();
  if (!(await tar.status).success) throw new Error(`${tarball}: untar failed`);
}

/** Fail on a `@capacitor/core` import of a name the stub lacks. */
function checkCoreImports(npm: string, text: string): void {
  const imports = text.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@capacitor\/core['"]/g,
  );
  const names = [...imports].flatMap((m) => m[1].split(",").map((s) => s.trim()));
  const missing = names.filter((name) => name && !CAPACITOR_CORE_NAMES.has(name));
  if (missing.length) throw new Error(`${npm}: @capacitor/core's ${missing} not in the stub`);
}

/** Copy `definitions.d.ts` from `esm` and every declaration file it reaches into `outDir`. */
async function copyDeclarations(npm: string, esm: string, outDir: string): Promise<void> {
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  const seen = new Set<string>();
  const queue = ["definitions.d.ts"];
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = await Deno.readTextFile(join(esm, rel));
    checkCoreImports(npm, text);
    for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      queue.push(join(dirname(rel), m[1].endsWith(".d.ts") ? m[1] : `${m[1]}.d.ts`));
    }
    const out = join(outDir, rel);
    const stub = relative(dirname(out), join(PLUGIN_BASELINE_DIR, "capacitor-core.d.ts"));
    await Deno.mkdir(dirname(out), { recursive: true });
    await Deno.writeTextFile(
      out,
      rewriteImports(text, rel, stub.startsWith(".") ? stub : `./${stub}`),
    );
  }
}

/** Vendor one package's declarations: `definitions.d.ts` and every file it reaches. */
async function vendor(npm: string, range: string): Promise<VendoredPlugin> {
  const meta = await (await fetch(`https://registry.npmjs.org/${npm.replace("/", "%2f")}`)).json();
  const stable = Object.keys(meta.versions).filter((v) => !v.includes("-"));
  const version = newestAdmitted(range, stable);
  const tmp = await Deno.makeTempDir({ prefix: "denext_expo_plugin_" });
  try {
    await unpack(meta.versions[version].dist.tarball, tmp);
    const esm = join(tmp, "package/dist/esm");
    const decl = /declare const \w+: (\w+);/.exec(await Deno.readTextFile(join(esm, "index.d.ts")));
    const reg = /registerPlugin\(\s*['"]([^'"]+)['"]/.exec(
      await Deno.readTextFile(join(esm, "index.js")),
    );
    if (!decl || !reg) throw new Error(`${npm}@${version}: no plugin declaration / registration`);
    await copyDeclarations(npm, esm, join(PLUGIN_BASELINE_DIR, npm));
    return {
      npm,
      version,
      pluginName: reg[1],
      pluginInterface: decl[1],
      definitions: `${npm}/definitions.d.ts`,
    };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Re-vendor every shim's plugin at its pin. */
export async function refreshExpoPlugins(): Promise<VendoredIndex> {
  await Deno.mkdir(PLUGIN_BASELINE_DIR, { recursive: true });
  await Deno.writeTextFile(join(PLUGIN_BASELINE_DIR, "capacitor-core.d.ts"), CAPACITOR_CORE_STUB);
  const index: VendoredIndex = {};
  for (const { capability } of EXPO_PLUGIN_SHIMS) {
    const cap = EXPO_SDK_CAPABILITIES[capability];
    if (!cap?.npm || !cap.version) throw new Error(`${capability}: no pinned plugin`);
    index[capability] = await vendor(cap.npm, cap.version);
    console.log(`${capability}: ${cap.npm}@${index[capability].version}`);
  }
  await Deno.writeTextFile(PLUGIN_BASELINE_INDEX, JSON.stringify(index, null, 2) + "\n");
  return index;
}

/** The vendored index. */
export async function readVendoredIndex(): Promise<VendoredIndex> {
  return JSON.parse(await Deno.readTextFile(PLUGIN_BASELINE_INDEX));
}

/**
 * The type-level comparison appended to a copy of a shim's source, per method the shim declares:
 * the plugin has it; the shim passes no more arguments than it takes; every key of the argument
 * object (at any depth) is one the plugin declares, and every key the plugin requires is one the
 * shim declares; and every result field the shim reads (at any depth) is one the plugin returns.
 * It compares names, not value types: the shims declare values loosely (`string` where the plugin
 * has a literal union, `| null` where it omits the key). A mismatch is a type error naming the
 * method and the problem.
 */
export function checkSource(
  source: string,
  shimInterface: string,
  definitionsUrl: string,
  plugin: string,
): string {
  const methods = declaredMethods(source, shimInterface);
  const perMethod = methods.map((m) =>
    `export type __Check_${m} = __NoProblems<__Problem<"${m}">>;`
  );
  return `
// ---- appended by scripts/parity/native/expo-plugins.ts ----
import type { ${plugin} as __Real } from ${JSON.stringify(definitionsUrl)};
type __Shim = ${shimInterface};
type __Fn = (...args: never[]) => unknown;
type __KeysOf<T> = T extends unknown ? keyof T : never;
type __Get<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
type __Depth = [never, 0, 1, 2, 3, 4, 5, 6];
/** The keys of S (deep) that R does not declare, as dotted paths. */
type __Extra<S, R, D extends number = 6> = [D] extends [never] ? never
  : 0 extends (1 & S) ? never
  : 0 extends (1 & R) ? never
  : [S] extends [__Fn] ? never
  : [S] extends [readonly (infer SE)[]]
    ? ([R] extends [readonly (infer RE)[]] ? __Extra<NonNullable<SE>, NonNullable<RE>, __Depth[D]> : never)
  : [S] extends [object] ? (string extends keyof S ? never : [R] extends [object] ? {
      [K in keyof S & string]-?: K extends __KeysOf<R>
        ? (__Extra<NonNullable<S[K]>, NonNullable<__Get<R, K>>, __Depth[D]> extends infer E extends string
          ? ([E] extends [never] ? never : \`\${K}.\${E}\`)
          : never)
        : K;
    }[keyof S & string] : never)
  : never;
type __Arg<F> = F extends __Fn ? NonNullable<Parameters<F>[0]> : never;
type __Result<F> = F extends __Fn ? Awaited<ReturnType<F>> : never;
type __Required<T> = T extends object ? { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]
  : never;
type __Problem<M extends keyof __Shim> = M extends keyof __Real
  ? __Shim[M] extends __Fn ? __Real[M] extends __Fn
      ? (Parameters<__Shim[M]>["length"] extends 0 | 1 ? never
        : Parameters<__Real[M]>["length"] extends 0 | 1
          ? { method: M; problem: "the shim passes more arguments than the plugin takes" }
        : never)
      | ([__Extra<__Arg<__Shim[M]>, __Arg<__Real[M]>>] extends [never] ? never
        : { method: M; problem: "argument keys the plugin does not declare"; keys: __Extra<__Arg<__Shim[M]>, __Arg<__Real[M]>> })
      | ([Exclude<__Required<__Arg<__Real[M]>>, __KeysOf<__Arg<__Shim[M]>>>] extends [never] ? never
        : { method: M; problem: "required argument keys the shim does not declare"; keys: Exclude<__Required<__Arg<__Real[M]>>, __KeysOf<__Arg<__Shim[M]>>> })
      | ([__Extra<__Result<__Shim[M]>, __Result<__Real[M]>>] extends [never] ? never
        : { method: M; problem: "result keys the plugin does not return"; keys: __Extra<__Result<__Shim[M]>, __Result<__Real[M]>> })
    : { method: M; problem: "not a method on the plugin" }
    : never
  : { method: M; problem: "no such method on the plugin" };
/** A problem is printed by the constraint error ("… does not satisfy the constraint 'never'"). */
type __NoProblems<T extends never> = T;
type __Listed = ${methods.map((m) => JSON.stringify(m)).join(" | ")};
/** Every method the interface declares is checked below (one error per method). */
export type __AllListed = __NoProblems<Exclude<keyof __Shim, __Listed>>;
${perMethod.join("\n")}
`;
}

/** The method names `interface <name> { … }` in `source` declares (one per line, as written here). */
export function declaredMethods(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} {`);
  if (start < 0) throw new Error(`no interface ${name}`);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const methods = [...body.matchAll(/^ {2}(\w+)\??\s*[(<]/gm)].map((m) => m[1]);
  if (methods.length === 0) throw new Error(`interface ${name} declares no methods`);
  return methods;
}

if (import.meta.main) {
  const index = await refreshExpoPlugins();
  console.log(`vendored ${Object.keys(index).length} plugins → ${PLUGIN_BASELINE_DIR}`);
}
