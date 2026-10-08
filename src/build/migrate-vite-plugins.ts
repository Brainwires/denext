// `denext migrate` (Vite SPA): the Vite plugins whose build-time output denext can carry over.
//
// - TanStack Router's `tanstackRouter({ autoCodeSplitting: true })` (or the older
//   `TanStackRouterVite(…)`) becomes `spa.tanstackRouter: { autoCodeSplitting: true }` (with a
//   literal `routesDirectory` / `generatedRouteTree` carried along), so route components stay
//   split out of the startup chunk.
// - A Vite plugin that only emits files from `generateBundle` with `this.emitFile` — imported
//   from the app's own module and called in vite.config with arguments that need nothing else
//   from vite.config — is wired into `denext.config.ts` as `viteEmitterPlugin(<the same call>)`
//   (denext/plugin-kit), so the file still lands in the build. One that also uses other build
//   hooks, is declared inline in vite.config, or whose call reads vite.config's own variables
//   is reported for review instead.
//
// - `build.assetsDir` becomes `spa.assetsDir` (Vite's default, `"assets"`, when the config does
//   not set it), so the built files keep the paths a server written for the Vite build serves.
//
// vite.config is read as text, never executed.

import { dirname, join, relative, resolve } from "@std/path";
import type { SpaTanstackRouterConfig } from "../server/config.ts";
import { normalizeSpaAssetsDir } from "../server/config-validate.ts";
import { mfs } from "./migrate-io.ts";

/** The vite.config file names migrate reads, in precedence order. */
const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"];

/** The app's vite.config: its name and text, or null when there is none. */
export async function readViteConfig(dir: string): Promise<{ name: string; text: string } | null> {
  for (const name of VITE_CONFIGS) {
    const text = await mfs.readTextFile(join(dir, name)).catch(() => null);
    if (text !== null) return { name, text };
  }
  return null;
}

/**
 * The text of the call whose `(` is at `open`, through its matching `)`, skipping string
 * literals and comments; null when unbalanced.
 */
export function balancedCall(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/**
 * When a string literal or a comment starts at `i`, the index of its last character (the end
 * of the text when it is unterminated); otherwise `i` itself.
 */
function skipNonCode(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"' || ch === "'" || ch === "`") return skipString(text, i);
  if (ch !== "/") return i;
  const end = text[i + 1] === "/"
    ? text.indexOf("\n", i)
    : text[i + 1] === "*"
    ? text.indexOf("*/", i + 2) + 1
    : i;
  return end < i ? text.length : end;
}

/** The index of the closing quote of the string literal opening at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

/** `text` with its comments blanked out (string literals kept), offsets unchanged. */
function withoutComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const end = skipNonCode(text, i);
    if (end === i) {
      out += text[i];
      continue;
    }
    const span = text.slice(i, end + 1);
    out += span.startsWith("/") ? span.replace(/[^\n]/g, " ") : span;
    i = end;
  }
  return out;
}

/** Vite's `build.assetsDir` default. */
const VITE_ASSETS_DIR = "assets";

/**
 * `spa.assetsDir` for a Vite app: a literal `assetsDir` from its vite.config (`build.assetsDir`),
 * else Vite's default `"assets"`. A value migrate cannot read (an expression) or carry (`""`, the
 * files at the root) keeps the default.
 *
 * @param text The vite.config source.
 */
export function viteAssetsDir(text: string): string {
  const m = withoutComments(text).match(/\bassetsDir\s*:\s*(["'`])([^"'`\n]*)\1/);
  return (m && normalizeSpaAssetsDir(m[2])) ?? VITE_ASSETS_DIR;
}

/** A string-literal property `key: "value"` inside `args`, or undefined. */
function literalProp(args: string, key: string): string | undefined {
  const m = args.match(new RegExp(`\\b${key}\\s*:\\s*(["'\`])([^"'\`]+)\\1`));
  return m?.[2];
}

/**
 * `spa.tanstackRouter` for an app whose vite.config runs TanStack Router's plugin with
 * `autoCodeSplitting: true`, or undefined.
 *
 * @param text The vite.config source.
 */
export function tanstackRouterFacts(text: string): SpaTanstackRouterConfig | undefined {
  for (const m of text.matchAll(/\b(?:tanstackRouter|TanStackRouterVite)\s*\(/g)) {
    const args = balancedCall(text, m.index! + m[0].length - 1);
    if (!args || !/\bautoCodeSplitting\s*:\s*true\b/.test(args)) continue;
    const out: SpaTanstackRouterConfig = { autoCodeSplitting: true };
    const routesDirectory = literalProp(args, "routesDirectory");
    const generatedRouteTree = literalProp(args, "generatedRouteTree");
    if (routesDirectory) out.routesDirectory = routesDirectory;
    if (generatedRouteTree) out.generatedRouteTree = generatedRouteTree;
    return out;
  }
  return undefined;
}

/** A Vite emitter carried into `denext.config.ts`. */
export interface MappedViteEmitter {
  /** The import to add (`import { x } from "./scripts/x.ts";`), resolved from denext.config.ts. */
  importLine: string;
  /** The plugin call, verbatim from vite.config (`x({ … })`). */
  call: string;
  /** The plugin factory's name, for the summary. */
  name: string;
}

/** A Vite plugin migrate could not carry over, with why. */
export interface ViteEmitterFinding {
  /** What it concerns. */
  item: string;
  /** Why, and what to do about it. */
  reason: string;
}

/** What {@linkcode viteEmitterFacts} found. */
export interface ViteEmitterFacts {
  /** Emitters wired into the generated config. */
  mapped: MappedViteEmitter[];
  /** Emitters left for the user. */
  review: ViteEmitterFinding[];
}

/** Vite/Rollup build hooks besides `generateBundle` that `viteEmitterPlugin` does not run. */
const OTHER_BUILD_HOOKS =
  /(?<![.\w$])(transform|resolveId|load|renderChunk|transformIndexHtml|writeBundle|closeBundle|buildStart|buildEnd|moduleParsed|renderStart|augmentChunkHash|resolveDynamicImport)\s*(?:\(|:\s*(?:async\s*)?(?:\(|function\b))/;

/** Identifiers a carried-over call may use without anything from vite.config. */
const CALL_GLOBALS = new Set(["new", "URL", "import", "true", "false", "null", "undefined"]);

/** A left-to-right scan of source text, building its string-blanked copy. */
interface StringScan {
  readonly src: string;
  i: number;
  out: string;
}

/**
 * `src` with each string's text blanked to `""`. A template literal's text is blanked too, but
 * its `${…}` expressions are code and are kept, as `"" + (expr)` (nested templates included).
 */
function blankStrings(src: string): string {
  const s: StringScan = { src, i: 0, out: "" };
  scanCode(s, false);
  return s.out;
}

/** Copy code to the end, or (`nested`, inside `${…}`) up to the `}` that closes it. */
function scanCode(s: StringScan, nested: boolean): void {
  let depth = 0;
  while (s.i < s.src.length) {
    const c = s.src[s.i];
    if (c === "}" && nested && depth === 0) return;
    if (c === "{") depth++;
    else if (c === "}") depth--;
    scanToken(s, c);
  }
}

/** One code character: a quoted string or a template is consumed whole. */
function scanToken(s: StringScan, c: string): void {
  if (c === '"' || c === "'") return skipQuoted(s, c);
  if (c === "`") return scanTemplate(s);
  s.out += c;
  s.i++;
}

/** Skip a `quote`-delimited string (escapes included), leaving `""` in its place. */
function skipQuoted(s: StringScan, quote: string): void {
  for (s.i++; s.i < s.src.length && s.src[s.i] !== quote;) s.i += s.src[s.i] === "\\" ? 2 : 1;
  s.i++;
  s.out += '""';
}

/** A template literal: its text blanked, each `${…}` kept as ` + (expr)`. */
function scanTemplate(s: StringScan): void {
  s.out += '""';
  for (s.i++; s.i < s.src.length && s.src[s.i] !== "`";) templateStep(s);
  s.i++;
}

/** One step through a template's text: an escape, a `${…}` expression, or a character. */
function templateStep(s: StringScan): void {
  if (s.src[s.i] === "\\") {
    s.i += 2;
  } else if (s.src.startsWith("${", s.i)) {
    s.i += 2;
    s.out += " + (";
    scanCode(s, true);
    s.out += ")";
    s.i++; // the closing `}`
  } else {
    s.i++;
  }
}

/**
 * The identifiers `call`'s arguments read that are not globals: string contents, property
 * names after `.` and object keys before `:` are not reads; a template literal's `${…}` is.
 */
function freeIdentifiers(call: string): string[] {
  const args = call.slice(call.indexOf("("));
  const noStrings = blankStrings(args);
  const out = new Set<string>();
  for (const m of noStrings.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?!\s*:)(?![\w$])/g)) {
    if (!CALL_GLOBALS.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** Resolve an extensionless relative import the way a Vite (bundler) resolver would. */
async function resolveModule(dir: string, spec: string): Promise<string | null> {
  const base = resolve(dir, spec);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".js", ".mjs"].map((e) => base + e),
    ...["index.ts", "index.js"].map((f) => join(base, f)),
  ];
  for (const c of candidates) {
    const stat = await mfs.stat(c).catch(() => null);
    if (stat?.isFile) return c;
  }
  return null;
}

/** `{ a, b as c }` → [[imported, local], …] (type-only specifiers dropped). */
function namedSpecifiers(list: string): Array<[string, string]> {
  return list.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "))
    .map((s) => {
      const [imported, local] = s.split(/\s+as\s+/);
      return [imported.trim(), (local ?? imported).trim()];
    });
}

/** Every value import from a relative module: local name → its import shape. */
function relativeImports(
  text: string,
): Map<string, { spec: string; imported: string | "default" }> {
  const out = new Map<string, { spec: string; imported: string | "default" }>();
  const re =
    /import\s+(?!type\b)(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*(["'])(\.{1,2}\/[^"']+)\3/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) out.set(m[1], { spec: m[4], imported: "default" });
    for (const [imported, local] of namedSpecifiers(m[2] ?? "")) {
      out.set(local, { spec: m[4], imported });
    }
  }
  return out;
}

/** The import line for `local` from `file`, written relative to the project root. */
function importLineFor(
  projectDir: string,
  file: string,
  local: string,
  imported: string,
): string {
  let spec = relative(projectDir, file).split("\\").join("/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  const binding = imported === "default"
    ? local
    : `{ ${imported === local ? local : `${imported} as ${local}`} }`;
  return `import ${binding} from ${JSON.stringify(spec)};`;
}

/** Whether `source` emits files from `generateBundle`. */
function emitsFiles(source: string): boolean {
  return /\bgenerateBundle\b/.test(source) && /\bemitFile\s*\(/.test(source);
}

/**
 * The module an imported plugin factory comes from, with its source, when vite.config calls the
 * factory and the module emits files; null otherwise (not a file emitter).
 */
async function emitterModule(
  dir: string,
  text: string,
  local: string,
  spec: string,
): Promise<{ file: string; source: string; callAt: number } | null> {
  const call = text.matchAll(new RegExp(`(?<![.\\w$])${local}\\s*\\(`, "g")).next().value;
  const file = call ? await resolveModule(dir, spec) : null;
  if (!call || !file) return null;
  const source = await mfs.readTextFile(file).catch(() => "");
  return emitsFiles(source) ? { file, source, callAt: call.index! + call[0].length - 1 } : null;
}

/** Classify one imported plugin factory called in vite.config. */
async function classifyEmitter(
  dir: string,
  configName: string,
  text: string,
  local: string,
  imp: { spec: string; imported: string },
): Promise<MappedViteEmitter | ViteEmitterFinding | null> {
  const found = await emitterModule(dir, text, local, imp.spec);
  if (!found) return null;
  const { file, source, callAt } = found;
  const item = `${configName}: ${local}()`;
  const hook = source.match(OTHER_BUILD_HOOKS);
  if (hook) {
    return {
      item,
      reason: `a Vite plugin that emits files but also uses the \`${hook[1]}\` hook; ` +
        "port it to a denext plugin (`ctx.addBuildStep` + `emitFile`, denext/plugin-kit)",
    };
  }
  const callText = balancedCall(text, callAt);
  const free = callText ? freeIdentifiers(local + callText) : [local];
  if (!callText || free.length > 0) {
    return {
      item,
      reason: "a Vite plugin that emits files, called with values from vite.config (" +
        `${free.join(", ") || "unparsed"}); add \`viteEmitterPlugin(${local}(…))\` from ` +
        "denext/plugin-kit to `plugins` in denext.config.ts",
    };
  }
  return {
    importLine: importLineFor(dir, file, local, imp.imported),
    call: local + callText,
    name: local,
  };
}

/**
 * The file-emitting Vite plugins in the app's vite.config: the ones carried into
 * `denext.config.ts` and the ones left for review.
 *
 * @param dir The app's root (where vite.config and the new denext.config.ts live).
 */
export async function viteEmitterFacts(dir: string): Promise<ViteEmitterFacts> {
  const facts: ViteEmitterFacts = { mapped: [], review: [] };
  const config = await readViteConfig(dir);
  if (!config) return facts;
  const configDir = dirname(join(dir, config.name));
  for (const [local, imp] of relativeImports(config.text)) {
    const found = await classifyEmitter(configDir, config.name, config.text, local, imp);
    if (!found) continue;
    if ("call" in found) facts.mapped.push(found);
    else facts.review.push(found);
  }
  if (emitsFiles(config.text)) {
    facts.review.push({
      item: `${config.name}: an inline plugin's generateBundle`,
      reason: "emits files from a plugin declared in vite.config; move it into its own module " +
        "and add `viteEmitterPlugin(plugin)` from denext/plugin-kit to `plugins` in " +
        "denext.config.ts, or port it to a denext build step (`emitFile`)",
    });
  }
  return facts;
}
