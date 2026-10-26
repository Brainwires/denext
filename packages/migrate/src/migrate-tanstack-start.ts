// `denext migrate` for a TanStack Start app: detection, and the Start options carried from the
// app's vite.config (or a Vinxi-era app.config) into `tanstackStart({ … })` in the generated
// `denext.config.ts`, where the `@denext/tanstack-start` plugin runs the app.
//
// The config is read as text, never executed. An option is carried when it is one the plugin
// takes (its catalog `configKeys`) and its value reads nothing else from the config file (an
// import or a top-level declaration); every other option is reported with the reason.

import { join } from "@std/path";
import { mfs, PLUGIN_CATALOG as CATALOG } from "@denext/denext/internal/migrate-host";
import { anyExists } from "./migrate-fs.ts";
import {
  balancedCall,
  readViteConfig,
  skipNonCode,
  withoutComments,
} from "./migrate-vite-plugins.ts";

/** The Vinxi-era Start config file names (`defineConfig` from `@tanstack/react-start/config`). */
const LEGACY_CONFIGS = ["app.config.ts", "app.config.js", "app.config.mts", "app.config.mjs"];

/** The npm package that makes an app a TanStack Start app. */
const START_PACKAGE = "@tanstack/react-start";

/** One Start option carried into `tanstackStart({ … })`: its key and its source as written. */
export interface CarriedStartOption {
  key: string;
  /** The property as written in the config (`srcDirectory: 'src'`). */
  source: string;
}

/** A Start option that was not carried, with the reason. */
export interface DroppedStartOption {
  key: string;
  note: string;
}

/** What migrate read from a Start app's config. */
export interface TanstackStartMigrateInfo {
  /** The config the options came from (`vite.config.ts`, `app.config.ts`), or null. */
  file: string | null;
  /** A Vinxi-era app (`app.config.*`), whose layout predates the plugin's. */
  legacy: boolean;
  /** Options carried into `tanstackStart({ … })`. */
  carried: CarriedStartOption[];
  /** Options left behind, each with why. */
  dropped: DroppedStartOption[];
  /** Notes for a human (a legacy layout, options built in code). */
  notes: string[];
}

/** The option keys `tanstackStart()` takes, from the first-party plugin catalog. */
function pluginOptionKeys(): Set<string> {
  const entry = CATALOG.plugins.find((p) => p.name === "@denext/tanstack-start");
  return new Set((entry as { configKeys?: string[] } | undefined)?.configKeys ?? []);
}

/** Why a Start option the plugin does not take stays behind. */
const DROP_NOTES: Record<string, string> = {
  tsr: "the route generator reads tsr.config.json; move these options there",
  server: "denext builds and serves the server itself (src/server.ts still applies)",
  client: "denext builds the client bundle itself (src/client.tsx still applies)",
  vite: "there is no Vite build under denext",
};

/**
 * Whether `dir` holds a TanStack Start app: `@tanstack/react-start` in its dependencies, and a
 * vite.config that runs Start's plugin (`tanstackStart(`) or a Vinxi-era `app.config.*`.
 *
 * @param dir The app directory.
 * @param deps Its dependencies (name → version spec).
 */
export async function isTanstackStartApp(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  if (!(START_PACKAGE in deps)) return false;
  const vite = await readViteConfig(dir);
  if (vite && /\btanstackStart\s*\(/.test(withoutComments(vite.text))) return true;
  return await anyExists(dir, LEGACY_CONFIGS);
}

/**
 * Read the Start options of the app at `dir`: the first argument of `tanstackStart(…)` in its
 * vite.config, else the `defineConfig({ … })` of a Vinxi-era `app.config.*`.
 *
 * @param dir The app directory.
 */
export async function readTanstackStartOptions(dir: string): Promise<TanstackStartMigrateInfo> {
  const vite = await readViteConfig(dir);
  const call = vite ? callArgument(vite.text, /\btanstackStart\s*\(/) : undefined;
  if (vite && call !== undefined) return carryOptions(vite.name, vite.text, call, false);
  for (const name of LEGACY_CONFIGS) {
    const text = await mfs.readTextFile(join(dir, name)).catch(() => null);
    if (text === null) continue;
    return carryOptions(name, text, callArgument(text, /\bdefineConfig\s*\(/) ?? "", true);
  }
  return { file: null, legacy: false, carried: [], dropped: [], notes: [] };
}

/** The text of the first argument of the first call `re` matches, or undefined (no call). */
function callArgument(text: string, re: RegExp): string | undefined {
  const code = withoutComments(text);
  const m = re.exec(code);
  if (!m) return undefined;
  const call = balancedCall(code, m.index + m[0].length - 1);
  if (call === null) return undefined;
  return splitTopLevel(call.slice(1, -1))[0] ?? "";
}

/** Split `text` at its top-level commas (outside brackets, strings and comments), trimmed. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts.filter((p) => p.length > 0);
}

/** The names a config module binds at its top level (imports and declarations). */
function topLevelBindings(text: string): string[] {
  const code = withoutComments(text);
  const names = new Set<string>();
  for (const m of code.matchAll(/^\s*import\s+([^;]*?)\s+from\s/gm)) {
    for (const name of m[1].replace(/[{}*]/g, " ").split(/[\s,]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "as" && name !== "type") names.add(name);
    }
  }
  const decl = /^\s*(?:export\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of code.matchAll(decl)) names.add(m[1]);
  return [...names];
}

/** The value text with its string literals blanked, so identifiers are not read inside them. */
function codeOnly(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const end = skipNonCode(value, i);
    if (end === i) out += value[i];
    else {
      out += " ";
      i = end;
    }
  }
  return out;
}

/** One property of an object literal: its key (null for a spread / computed one) and value. */
function propertyOf(prop: string): { key: string | null; value: string | null } {
  if (prop.startsWith("...")) return { key: null, value: null };
  const m = /^(?:([A-Za-z_$][\w$]*)|(["'])([^"']+)\2)\s*:/.exec(prop);
  if (m) return { key: m[1] ?? m[3], value: prop.slice(m[0].length).trim() };
  // A shorthand property reads a binding of the same name; a method is carried as written.
  const short = /^([A-Za-z_$][\w$]*)\s*(\(?)/.exec(prop);
  if (!short) return { key: null, value: null };
  return { key: short[1], value: short[2] ? prop.slice(short[1].length) : null };
}

/** The note on a Vinxi-era config, whose app layout predates the plugin's. */
function legacyNote(file: string): string {
  return `${file} is a Vinxi-era Start config: the plugin runs Start's current layout ` +
    "(src/router.tsx exporting getRouter(), src/routes/), so upgrade Start first " +
    "(TanStack's Vinxi-to-Vite migration guide)";
}

/** What reading one options property needs: the config's facts, and where results go. */
interface PropContext {
  file: string;
  legacy: boolean;
  supported: Set<string>;
  bindings: string[];
  info: TanstackStartMigrateInfo;
}

/** The config's top-level bindings `value` reads (a shorthand property reads its own name). */
function bindingsRead(key: string, value: string | null, bindings: string[]): string[] {
  if (value === null) return [key];
  const code = codeOnly(value);
  return bindings.filter((b) =>
    new RegExp(`(?<![\\w$.])${b.replace("$", "\\$")}(?![\\w$])`).test(code)
  );
}

/** A Vinxi-era `tsr: { appDirectory }`, carried as `srcDirectory`. */
function carryLegacyTsr(value: string | null, info: TanstackStartMigrateInfo): void {
  const appDirectory = /\bappDirectory\s*:\s*(["'])([^"']+)\1/.exec(value ?? "")?.[2];
  if (appDirectory) {
    info.carried.push({ key: "srcDirectory", source: `srcDirectory: "${appDirectory}"` });
  }
}

/** Carry one options property, or record why it stays behind. */
function classifyProp(prop: string, ctx: PropContext): void {
  const { info, file } = ctx;
  const { key, value } = propertyOf(prop);
  if (key === null) {
    info.notes.push(`${file}: \`${prop.slice(0, 60)}\` is not a plain option; port it by hand`);
  } else if (ctx.legacy && key === "tsr") {
    carryLegacyTsr(value, info);
  } else if (!ctx.supported.has(key)) {
    info.dropped.push({
      key,
      note: DROP_NOTES[key] ?? "not a @denext/tanstack-start option; denext has no equivalent",
    });
  } else {
    const reads = bindingsRead(key, value, ctx.bindings);
    if (reads.length) {
      info.dropped.push({
        key,
        note: `reads ${reads.join(", ")} from ${file}; carry it into tanstackStart() by hand`,
      });
    } else info.carried.push({ key, source: prop });
  }
}

/** Classify every property of the options object `arg` (from `file`, whose text is `text`). */
function carryOptions(
  file: string,
  text: string,
  arg: string,
  legacy: boolean,
): TanstackStartMigrateInfo {
  const info: TanstackStartMigrateInfo = { file, legacy, carried: [], dropped: [], notes: [] };
  if (legacy) info.notes.push(legacyNote(file));
  if (!arg) return info;
  if (!arg.startsWith("{")) {
    info.notes.push(`${file}: the Start options are built in code (${arg}); port them by hand`);
    return info;
  }
  const ctx = {
    file,
    legacy,
    supported: pluginOptionKeys(),
    bindings: topLevelBindings(text),
    info,
  };
  for (const prop of splitTopLevel(arg.slice(1, -1))) classifyProp(prop, ctx);
  return info;
}

/**
 * The generated `denext.config.ts` for a Start app: `compatibilityMode` (the app's npm
 * packages import `react`) and the `tanstackStart()` plugin with the carried options.
 *
 * @param marker The migrate-generated marker line.
 * @param info What {@link readTanstackStartOptions} read.
 */
export function tanstackStartConfigSource(marker: string, info: TanstackStartMigrateInfo): string {
  const options = info.carried.length
    ? `{\n${info.carried.map((o) => `      ${reindent(o.source)},\n`).join("")}    }`
    : "";
  const from = info.file && info.carried.length ? ` Options carried from ${info.file}.` : "";
  return `${marker}
import type { DenextConfig } from "denext/server";
import { tanstackStart } from "@denext/tanstack-start";

// TanStack Start, run by the @denext/tanstack-start plugin: it generates the route tree and
// answers every request with Start's own handler.${from}
export default {
  compatibilityMode: true,
  plugins: [
    tanstackStart(${options}),
  ],
} satisfies DenextConfig;
`;
}

/**
 * A multi-line option re-indented to sit inside the generated options object: its last line
 * (the value's closing bracket) lines up with the key, the lines between keep their nesting.
 */
function reindent(source: string): string {
  const lines = source.split("\n");
  if (lines.length === 1) return source;
  const indentOf = (line: string) => /^ */.exec(line)![0].length;
  const base = indentOf(lines[lines.length - 1]);
  return [
    lines[0],
    ...lines.slice(1).map((l) => (l.trim() ? "      " + l.slice(Math.min(base, indentOf(l))) : "")),
  ].join("\n");
}
