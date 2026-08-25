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

  let out = source;
  let addedImport = false;

  // 1) Add the import after the last top-of-file import, else at the very top.
  if (!importPresent) {
    const importLine = `import { ${names.factory} } from "${names.importSpec}";\n`;
    const importRe = /^import\b[^\n]*\n/gm;
    let last: RegExpExecArray | null = null;
    for (let m = importRe.exec(out); m; m = importRe.exec(out)) last = m;
    if (last) {
      const at = last.index + last[0].length;
      out = out.slice(0, at) + importLine + out.slice(at);
    } else {
      out = importLine + out;
    }
    addedImport = true;
  }

  if (callInPlugins) {
    // Import was missing but the call is already present — just added the import.
    return { ...base, source: out, addedImport, alreadyPresent: false };
  }

  // 2) Locate `export default` → its object literal `{`.
  const expDefault = out.search(/export\s+default\b/);
  if (expDefault === -1) return { ...base, source: out, addedImport, bailed: true };
  let i = expDefault + out.slice(expDefault).match(/export\s+default\b/)![0].length;
  while (i < out.length && /\s/.test(out[i])) i++;
  if (out[i] !== "{") return { ...base, source: out, addedImport, bailed: true };
  const objStart = i;

  // 3) Extend an existing `plugins: [` in that object, else insert a new key.
  const existing = /plugins\s*:\s*\[/.exec(out.slice(objStart));
  if (existing) {
    const at = objStart + existing.index + existing[0].length;
    // Empty array (next non-ws is `]`) → no separator; otherwise prepend `call, `.
    let j = at;
    while (j < out.length && /\s/.test(out[j])) j++;
    const insert = out[j] === "]" ? names.call : `${names.call}, `;
    out = out.slice(0, at) + insert + out.slice(at);
  } else {
    const at = objStart + 1;
    out = out.slice(0, at) + `\n  plugins: [${names.call}],` + out.slice(at);
  }
  return { ...base, source: out, addedImport, addedPlugin: true };
}
