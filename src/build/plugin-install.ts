// Core for `denext plugin add <pkg>`: resolve a package specifier to the pieces an
// install needs (the `deno add` spec, the bare import specifier, the factory export
// name, and the call expression), and inject that plugin into a `denext.config.ts`
// source. Pure and string-based so it is unit-testable without touching the network
// or the filesystem; the command wrapper (src/cli/commands/plugin.ts) runs
// `deno add` and reads/writes the file around these functions.

/** The resolved names an install works with. */
export interface PluginNames {
  /** The `deno add` argument (scheme-qualified, e.g. `jsr:@denext/htmx`). */
  addSpec: string;
  /** The bare import specifier the config imports from (e.g. `@denext/htmx`). */
  importSpec: string;
  /** The factory export name (e.g. `htmx`, `pagesRouter`). */
  factory: string;
  /** The expression placed in the `plugins` array (e.g. `htmx()` or `htmx`). */
  call: string;
}

/** Options for {@linkcode resolvePluginNames}. */
export interface ResolveOptions {
  /** Override the factory export name (else derived from the package name). */
  export?: string;
  /** The plugin is exported as a ready value, not a factory — don't add `()`. */
  noCall?: boolean;
}

/** `pages-router` → `pagesRouter`, `htmx` → `htmx`. */
function camelCase(segment: string): string {
  const parts = segment.split(/[-_]/).filter(Boolean);
  if (parts.length === 0) return segment;
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

/**
 * Resolve a user-supplied package specifier into the {@linkcode PluginNames} an
 * install needs. Accepts `@denext/htmx`, `jsr:@denext/htmx`, `npm:some-plugin`, or a
 * versioned form (`@denext/htmx@2.0.10`); a bare (scheme-less) spec defaults to
 * `jsr:`. The factory name defaults to the camelCased last path segment.
 */
export function resolvePluginNames(input: string, opts: ResolveOptions = {}): PluginNames {
  const schemeMatch = input.match(/^(jsr|npm|https?):/);
  const scheme = schemeMatch ? schemeMatch[0] : "";
  const rest = scheme ? input.slice(scheme.length) : input;

  // Strip a trailing @version, taking care not to cut the leading @scope.
  let bare = rest;
  if (rest.startsWith("@")) {
    const at = rest.indexOf("@", 1);
    if (at > 0) bare = rest.slice(0, at);
  } else {
    const at = rest.indexOf("@");
    if (at > 0) bare = rest.slice(0, at);
  }

  const lastSegment = bare.split("/").pop() || bare;
  const factory = opts.export ?? camelCase(lastSegment);
  const addSpec = scheme ? input : `jsr:${input}`;
  return { addSpec, importSpec: bare, factory, call: opts.noCall ? factory : `${factory}()` };
}

/** The result of injecting a plugin into a config source. */
export interface InjectResult {
  /** The (possibly unchanged) config source. */
  source: string;
  /** An `import` line was added. */
  addedImport: boolean;
  /** The plugin call was added to a `plugins` array. */
  addedPlugin: boolean;
  /** The plugin was already wired up — nothing to do. */
  alreadyPresent: boolean;
  /**
   * The default export isn't a plain object literal, so the `plugins` entry could
   * not be injected safely; the caller should print manual instructions.
   */
  bailed: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A fresh `denext.config.ts` wiring exactly this one plugin. */
export function createConfigSource(names: PluginNames): string {
  return `import { ${names.factory} } from "${names.importSpec}";\n\n` +
    `export default {\n  plugins: [${names.call}],\n};\n`;
}

/**
 * Inject a plugin into an existing `denext.config.ts` source: add the factory
 * import (unless already imported) and add its call to the default export's
 * `plugins` array (creating the array if absent). Idempotent — re-adding a
 * plugin that's already wired reports {@linkcode InjectResult.alreadyPresent}.
 * Bails (without mangling) if the default export isn't an object literal.
 */
export function injectPlugin(source: string, names: PluginNames): InjectResult {
  const base: InjectResult = {
    source,
    addedImport: false,
    addedPlugin: false,
    alreadyPresent: false,
    bailed: false,
  };

  // Is the call already in a plugins array? (crude but effective idempotency)
  const callInPlugins = new RegExp(
    `plugins\\s*:\\s*\\[[^\\]]*\\b${escapeRe(names.factory)}\\s*\\(`,
  ).test(source);
  const importPresent = new RegExp(
    `import[^;]*\\b${escapeRe(names.factory)}\\b[^;]*from\\s*["']${escapeRe(names.importSpec)}["']`,
  ).test(source);
  if (callInPlugins && importPresent) return { ...base, alreadyPresent: true };

  // 1) Add the import after the last top-of-file import, else at the very top.
  const addedImport = !importPresent;
  const out = importPresent
    ? source
    : addImportLine(source, `import { ${names.factory} } from "${names.importSpec}";\n`);
  if (callInPlugins) {
    // Import was missing but the call is already present — just added the import.
    return { ...base, source: out, addedImport, alreadyPresent: false };
  }
  // 2) Locate `export default` → its object literal `{`; 3) add the call there.
  const objStart = defaultExportObjectStart(out);
  if (objStart === -1) return { ...base, source: out, addedImport, bailed: true };
  return {
    ...base,
    source: insertPluginCall(out, objStart, names.call),
    addedImport,
    addedPlugin: true,
  };
}

/** Insert `importLine` after the last top-of-file `import`, else at the very top. */
function addImportLine(source: string, importLine: string): string {
  const importRe = /^import\b[^\n]*\n/gm;
  let last: RegExpExecArray | null = null;
  for (let m = importRe.exec(source); m; m = importRe.exec(source)) last = m;
  if (!last) return importLine + source;
  const at = last.index + last[0].length;
  return source.slice(0, at) + importLine + source.slice(at);
}

/** The index of the `{` opening the `export default` object literal, or -1 (no/non-object default). */
function defaultExportObjectStart(source: string): number {
  const m = /export\s+default\b/.exec(source);
  if (!m) return -1;
  let i = m.index + m[0].length;
  while (i < source.length && /\s/.test(source[i])) i++;
  return source[i] === "{" ? i : -1;
}

/** Extend an existing `plugins: [` in the object at `objStart`, else insert a new `plugins` key. */
function insertPluginCall(source: string, objStart: number, call: string): string {
  const existing = /plugins\s*:\s*\[/.exec(source.slice(objStart));
  if (!existing) {
    const at = objStart + 1;
    return source.slice(0, at) + `\n  plugins: [${call}],` + source.slice(at);
  }
  const at = objStart + existing.index + existing[0].length;
  // Empty array (next non-ws is `]`) → no separator; otherwise prepend `call, `.
  let j = at;
  while (j < source.length && /\s/.test(source[j])) j++;
  const insert = source[j] === "]" ? call : `${call}, `;
  return source.slice(0, at) + insert + source.slice(at);
}

/** A plugin found wired into a config's `plugins` array. */
export interface ConfiguredPlugin {
  /** The factory/identifier used in the array (e.g. `htmx`, `pagesRouter`). */
  factory: string;
  /** Normalized call form (`htmx()`, or bare `htmx` for a non-factory value). */
  call: string;
  /** The specifier it's imported from (e.g. `@denext/htmx`), or null if not found. */
  importSpec: string | null;
}

/**
 * List the plugins wired into a `denext.config.ts` source: read the default
 * export's `plugins` array and pair each entry's factory with the specifier it's
 * imported from. Read-only; returns `[]` when there's no `plugins` array.
 */
export function listPlugins(source: string): ConfiguredPlugin[] {
  const arr = /plugins\s*:\s*\[([\s\S]*?)\]/.exec(source);
  if (!arr) return [];
  const out: ConfiguredPlugin[] = [];
  for (const entry of splitTopLevel(arr[1])) {
    const t = entry.trim();
    const m = /^([A-Za-z_$][\w$]*)/.exec(t);
    if (!m) continue;
    const factory = m[1];
    const call = t.includes("(") ? `${factory}()` : factory;
    out.push({ factory, call, importSpec: namedImportSpec(source, factory) });
  }
  return out;
}

/** Split on commas that aren't inside (), [], or {}. */
function splitTopLevel(list: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      entries.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) entries.push(cur);
  return entries;
}

/** The specifier `import { …, name, … } from "spec"` binds `name` from, or null. */
function namedImportSpec(source: string, name: string): string | null {
  const impRe = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (let im = impRe.exec(source); im; im = impRe.exec(source)) {
    if (im[1].split(",").map((s) => s.trim()).includes(name)) return im[2];
  }
  return null;
}

/** The result of removing a plugin from a config source. */
export interface EjectResult {
  /** The (possibly unchanged) config source. */
  source: string;
  /** The factory `import` was removed (or trimmed from a multi-name import). */
  removedImport: boolean;
  /** The plugin call was removed from the `plugins` array. */
  removedPlugin: boolean;
  /** The plugin wasn't wired up — nothing to remove. */
  notPresent: boolean;
}

/** Remove the factory's named binding from an `import … from "spec"` statement. */
function removeImport(source: string, factory: string, importSpec: string): string | null {
  const re = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escapeRe(importSpec)}["'];?[ \\t]*\\n?`,
  );
  const m = re.exec(source);
  if (!m) return null;
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.includes(factory)) return null;
  const remaining = names.filter((n) => n !== factory);
  if (remaining.length === 0) {
    // Drop the whole import line (the regex already consumed a trailing newline).
    return source.slice(0, m.index) + source.slice(m.index + m[0].length);
  }
  const nl = m[0].endsWith("\n") ? "\n" : "";
  const stmt = `import { ${remaining.join(", ")} } from "${importSpec}";${nl}`;
  return source.slice(0, m.index) + stmt + source.slice(m.index + m[0].length);
}

/**
 * Remove the factory's call from the `plugins` array (scoped to it, so an unrelated call
 * to a same-named binding elsewhere isn't touched), deleting the whole `plugins: [],`
 * property (and its line) if the array empties. Null when nothing was removed.
 */
function removePluginCall(source: string, factory: string): string | null {
  const open = source.search(/plugins\s*:\s*\[/);
  if (open === -1) return null;
  const bracket = source.indexOf("[", open);
  const end = source.indexOf("]", bracket);
  if (end === -1) return null;
  const inner = source.slice(bracket + 1, end);
  const f = escapeRe(factory);
  // The call, with args (`htmx()`, `htmx({...})`) or bare (`--no-call`).
  const callPat = `(?:${f}\\s*\\([^)]*\\)|${f})`;
  let next = inner.replace(new RegExp(`${callPat}\\s*,\\s*`), ""); // `call, `
  if (next === inner) next = inner.replace(new RegExp(`\\s*,\\s*${callPat}`), ""); // `, call`
  if (next === inner) next = inner.replace(new RegExp(callPat), ""); // lone
  if (next === inner) return null;
  const out = source.slice(0, bracket + 1) + next + source.slice(end);
  if (next.trim() !== "") return out;
  return out.replace(/[ \t]*plugins\s*:\s*\[\s*\]\s*,?[ \t]*\n?/, "");
}

/**
 * Remove a plugin from an existing `denext.config.ts` source — the inverse of
 * {@linkcode injectPlugin}: drop the factory import (or trim it from a shared
 * import) and remove its call from the `plugins` array, deleting the whole
 * `plugins: []` property if it empties. Idempotent — removing a plugin that isn't
 * wired reports {@linkcode EjectResult.notPresent} and changes nothing.
 */
export function ejectPlugin(source: string, names: PluginNames): EjectResult {
  let out = source;
  const removedImport = removeImport(out, names.factory, names.importSpec) !== null;
  if (removedImport) out = removeImport(out, names.factory, names.importSpec)!;

  const afterCall = removePluginCall(out, names.factory);
  const removedPlugin = afterCall !== null;
  if (afterCall !== null) out = afterCall;

  // Removing a top-of-file import can leave a leading blank line.
  if (removedImport) out = out.replace(/^\n+/, "");

  return {
    source: out,
    removedImport,
    removedPlugin,
    notPresent: !removedImport && !removedPlugin,
  };
}
