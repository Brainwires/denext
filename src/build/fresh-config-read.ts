// `denext migrate --from fresh`: reading a Fresh app's build configuration without running it —
// the `fresh({ … })` options of a Fresh 2 `vite.config.*` (`@fresh/plugin-vite`), a Fresh 1.x
// `fresh.config.ts` (`defineConfig({ staticDir, router, plugins })`) and the plugin calls of a
// `plugins: [ … ]` array. Only literal values are read (strings, arrays of strings, regular
// expression literals, booleans); anything computed is reported by name, so the migration can say
// which option it could not carry.

/** A top-level value of an object literal: its source text and, when literal, its value. */
interface LiteralValue {
  /** The source text. */
  text: string;
  /** The value, when the text is a literal this reader understands; else undefined. */
  value?: unknown;
}

/**
 * The index of the last character of the string, comment or regular expression literal starting
 * at `i`, or `i` itself for any other character.
 */
export function skipToken(source: string, i: number): number {
  const ch = source[i];
  if (ch === '"' || ch === "'" || ch === "`") return skipString(source, i);
  if (ch !== "/") return i;
  if (source[i + 1] === "/" || source[i + 1] === "*") return skipComment(source, i);
  return regexAllowed(source, i) ? skipRegex(source, i) : i;
}

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/** The text of the balanced bracket group opening at `start` (`{…}`, `[…]` or `(…)`), or null. */
export function balancedGroup(source: string, start: number): string | null {
  const stack: string[] = [];
  for (let i = start; i < source.length; i++) {
    const skipped = skipToken(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (ch in CLOSERS) stack.push(CLOSERS[ch]);
    else if (ch === stack[stack.length - 1] && (stack.pop(), stack.length === 0)) {
      return source.slice(start, i + 1);
    }
  }
  return null;
}

/** The index of a string literal's closing quote. */
function skipString(source: string, i: number): number {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") j++;
    else if (source[j] === quote) return j;
  }
  return source.length;
}

/** The index of a comment's last character. */
function skipComment(source: string, i: number): number {
  if (source[i + 1] === "/") {
    const end = source.indexOf("\n", i);
    return end < 0 ? source.length : end;
  }
  const end = source.indexOf("*/", i + 2);
  return end < 0 ? source.length : end + 1;
}

/** Whether a `/` at `i` starts a regular expression (it follows an operator or opener). */
function regexAllowed(source: string, i: number): boolean {
  const before = source.slice(0, i).trimEnd();
  return before === "" || /[(,=:[!&|?{};]$/.test(before);
}

/** The index of a regular expression literal's last flag character. */
function skipRegex(source: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === "\\") j++;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      let k = j + 1;
      while (/[a-z]/.test(source[k] ?? "")) k++;
      return k - 1;
    }
  }
  return source.length;
}

/** Split the inside of a bracket group at its top-level commas (comments dropped). */
export function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const skipped = skipToken(inner, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = inner[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(inner.slice(from));
  return parts.map((p) => stripComments(p).trim()).filter((p) => p !== "");
}

/** `text` without line and block comments (outside strings). */
function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(text, i);
      out += text.slice(i, end + 1);
      i = end;
    } else if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipComment(text, i);
    } else out += ch;
  }
  return out;
}

/** A string literal's body with its escapes resolved (`\n`, `\t`, `\\`, a quote). */
function unquote(body: string): string {
  const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };
  return body.replace(/\\(.)/gs, (_m, c: string) => escapes[c] ?? c);
}

/** A scalar literal's value (a string, a boolean, a number, a regex), or undefined. */
function scalarValue(t: string): unknown {
  if (/^(["'])(?:\\.|(?!\1).)*\1$/s.test(t)) return unquote(t.slice(1, -1));
  if (/^`[^`$]*`$/.test(t)) return t.slice(1, -1);
  if (t === "true" || t === "false") return t === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const re = /^\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\[])+)\/([a-z]*)$/s.exec(t);
  if (!re) return undefined;
  try {
    return new RegExp(re[1], re[2]);
  } catch {
    return undefined;
  }
}

/** An object literal's value, when every entry is a literal; else undefined. */
function objectValue(t: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(objectEntries(t))) {
    if (v.value === undefined) return undefined;
    out[k] = v.value;
  }
  return out;
}

/** The value of a literal (a scalar, or an array / object of literals), or undefined. */
export function literalValue(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const items = splitTopLevel(t.slice(1, -1)).map(literalValue);
    return items.some((v) => v === undefined) ? undefined : items;
  }
  if (t.startsWith("{") && t.endsWith("}")) return objectValue(t);
  return scalarValue(t);
}

/**
 * The top-level `key: value` entries of an object literal's text (`{ a: "x", b }`): a shorthand
 * entry or a spread has no literal value.
 *
 * @param objectText The literal, braces included.
 * @returns The entries by key.
 */
function objectEntries(objectText: string): Record<string, LiteralValue> {
  const out: Record<string, LiteralValue> = {};
  for (const part of splitTopLevel(objectText.trim().slice(1, -1))) {
    const m = /^(?:(["'])([^"']+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(part);
    if (m) {
      const text = m[4].trim();
      out[m[2] ?? m[3]] = { text, value: literalValue(text) };
    } else if (/^[A-Za-z_$][\w$]*$/.test(part)) out[part] = { text: part };
    else if (part.startsWith("...")) out[part] = { text: part };
  }
  return out;
}

/** The first object literal passed to a call of `callee` (`fresh({ … })`), or null. */
function callObjectArgument(source: string, callee: string): string | null {
  const re = new RegExp(`\\b${callee.replace(/[.$]/g, "\\$&")}\\s*\\(\\s*\\{`, "g");
  const m = re.exec(source);
  if (!m) return null;
  return balancedGroup(source, m.index + m[0].length - 1);
}

/** What `fresh({ … })` in a Fresh 2 Vite config sets (`@fresh/plugin-vite`'s `FreshViteConfig`). */
export interface FreshViteOptions {
  /** The server entry (`main.ts`). */
  serverEntry?: string;
  /** The client entry (`client.ts`). */
  clientEntry?: string;
  /** The islands directory (`islands`). */
  islandsDir?: string;
  /** The routes directory (`routes`). */
  routeDir?: string;
  /** The static directories, searched in order (`static`). */
  staticDir?: string[];
  /** Paths the route and island crawl skips (default: Fresh's test-file pattern). */
  ignore?: RegExp[];
  /** Modules (local paths or package specifiers) whose exports are islands. */
  islandSpecifiers?: string[];
  /** Options set to something this reader could not evaluate. */
  unread: string[];
}

/** A path option: a string. */
const STRING_OPTIONS = ["serverEntry", "clientEntry", "islandsDir", "routeDir"] as const;

/** Apply one `fresh({ … })` option; false when its value is not one this reader can carry. */
function applyViteOption(out: FreshViteOptions, key: string, v: unknown): boolean {
  if ((STRING_OPTIONS as readonly string[]).includes(key)) {
    if (typeof v !== "string") return false;
    out[key as typeof STRING_OPTIONS[number]] = v;
    return true;
  }
  if (key === "staticDir" && (typeof v === "string" || isStrings(v))) {
    out.staticDir = typeof v === "string" ? [v] : v;
    return true;
  }
  if (key === "ignore" && Array.isArray(v) && v.every((r) => r instanceof RegExp)) {
    out.ignore = v as RegExp[];
    return true;
  }
  if (key !== "islandSpecifiers" || !isStrings(v)) return false;
  out.islandSpecifiers = v;
  return true;
}

/**
 * The `fresh({ … })` options of a Vite config's source (none when it calls `fresh()` bare).
 *
 * @param source The `vite.config.*` source.
 * @returns The options it sets, and the ones it computes (`unread`).
 */
export function readFreshViteOptions(source: string): FreshViteOptions {
  const out: FreshViteOptions = { unread: [] };
  const obj = callObjectArgument(source, "fresh");
  if (!obj) return out;
  for (const [key, entry] of Object.entries(objectEntries(obj))) {
    if (!applyViteOption(out, key, entry.value)) out.unread.push(key);
  }
  return out;
}

/** Whether a value is an array of strings. */
function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** One call in a `plugins: [ … ]` array: the function called and its argument text. */
export interface PluginCall {
  /** The callee (`tailwind`, `kvOAuthPlugin`, `twind`). */
  name: string;
  /** Its arguments' source text (between the parentheses). */
  args: string;
}

/**
 * The plugin calls of the first `plugins: [ … ]` array in `source` (`name(args)` items; an
 * identifier item is a call with no arguments text).
 *
 * @param source A config's source.
 * @returns The calls, in order.
 */
export function pluginCalls(source: string): PluginCall[] {
  const m = /\bplugins\s*:\s*\[/.exec(source);
  if (!m) return [];
  const group = balancedGroup(source, m.index + m[0].length - 1);
  if (!group) return [];
  const calls: PluginCall[] = [];
  for (const item of splitTopLevel(group.slice(1, -1))) {
    const call = /^([A-Za-z_$][\w$.]*)\s*\(([\s\S]*)\)$/.exec(item);
    if (call) calls.push({ name: call[1], args: call[2].trim() });
    else if (/^[A-Za-z_$][\w$.]*$/.test(item)) calls.push({ name: item, args: "" });
  }
  return calls;
}

/** What a Fresh 1.x `fresh.config.ts` sets that carries over. */
export interface Fresh1Config {
  /** `staticDir`. */
  staticDir?: string;
  /** `router.basePath`. */
  basePath?: string;
  /** `router.trailingSlash`. */
  trailingSlash?: boolean;
  /** Options set to something this reader could not evaluate (or that do not carry over). */
  unread: string[];
}

/** The keys of a 1.x config that are settled elsewhere (plugins) or need no carrying (build). */
const FRESH1_HANDLED = new Set(["plugins", "build", "server", "port", "hostname", "onListen"]);

/**
 * The options of a Fresh 1.x `fresh.config.ts` (`defineConfig({ … })` or a default-exported
 * object) that carry over to denext.
 *
 * @param source The `fresh.config.ts` source.
 * @returns The options it sets.
 */
export function readFresh1Config(source: string): Fresh1Config {
  const out: Fresh1Config = { unread: [] };
  const obj = callObjectArgument(source, "defineConfig") ?? defaultExportObject(source);
  if (!obj) return out;
  const entries = objectEntries(obj);
  for (const [key, entry] of Object.entries(entries)) {
    if (key === "staticDir" && typeof entry.value === "string") out.staticDir = entry.value;
    else if (key === "router") readRouter(entry, out);
    else if (!FRESH1_HANDLED.has(key)) out.unread.push(key);
  }
  return out;
}

/** The object literal a module default-exports (`export default { … }`), or null. */
function defaultExportObject(source: string): string | null {
  const m = /export\s+default\s*\{/.exec(source);
  return m ? balancedGroup(source, m.index + m[0].length - 1) : null;
}

/** `router: { basePath, trailingSlash }` of a 1.x config. */
function readRouter(entry: LiteralValue, out: Fresh1Config): void {
  const r = entry.text.startsWith("{") ? objectEntries(entry.text) : {};
  if (!entry.text.startsWith("{")) out.unread.push("router");
  for (const [key, v] of Object.entries(r)) {
    if (key === "basePath" && typeof v.value === "string") out.basePath = v.value;
    else if (key === "trailingSlash" && typeof v.value === "boolean") out.trailingSlash = v.value;
    else out.unread.push(`router.${key}`);
  }
}
