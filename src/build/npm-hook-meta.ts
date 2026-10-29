// DevTools hook names for npm packages' custom hooks (dev only).
//
// The dev metadata pass (`devtools-meta.ts`) names a custom hook's cells by expanding the hook
// through the `__dnxMeta` records its declaring module registered. The app's own modules carry
// those records; a package's did not, so a hook imported by a bare specifier
// (`import { useQuery } from "@tanstack/react-query"`) stayed opaque: its cells were labelled
// with the call, and cells two such hooks in a row could share stayed unnamed.
//
// This module closes the gap on the paths that bundle packages with esbuild in development
// (the unbundled dev loop's npm dependency bundle, SPA mode's dev bundle):
//
// - the app side records a bare specifier's hooks as coming from `npm:<specifier>`
//   ({@linkcode npmMetaKey}), so a call's `from` + its imported name is a registry key;
// - {@linkcode npmHookMetaPlugin} appends a `__dnxMeta` footer to each ES module of a package
//   that declares or re-exports a `use*` hook (its own file URL is the key prefix, as for app
//   source), and registers `npm:<specifier>#*` → the module the specifier resolves to, for
//   every package specifier a footer names and every entry point of the build.
//
// It is best-effort and never changes what a package does: a CommonJS module, a minified one
// whose hooks lost their names, one too large to parse cheaply, or one that fails to parse is
// loaded as written (its hooks stay opaque, as before). Production builds never add it.

import type * as esbuild from "./esbuild/mod.ts";
import { dirname, toFileUrl } from "@std/path";
import { collectComponentMeta, META_IMPORT, metaCalls } from "./devtools-meta.ts";
import type { ComponentDevMeta } from "../client/devtools-meta.ts";
import { parseModule } from "./swc-ast.ts";

/** The registry key prefix of a package specifier (`npm:@tanstack/react-query`). */
const NPM_META_PREFIX = "npm:";

/** A bare package specifier: `pkg`, `pkg/sub`, `@scope/pkg`, `@scope/pkg/sub`. */
const BARE_PACKAGE = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:\/[^?#]*)?$/i;

/** The React-family / framework specifiers whose hooks are primitives, never expanded. */
const RUNTIME_SPEC = /^(?:react|react-dom|denext|next|preact)(?:\/|$)/;

/**
 * The registry key a bare package specifier's hooks are looked up under (`npm:<specifier>`),
 * or `undefined` for anything else (a relative or absolute path, a URL, `node:`, `jsr:`, an
 * `npm:` specifier with a version, React and the framework themselves).
 *
 * @param spec The import specifier as written.
 * @returns The key, or `undefined`.
 */
export function npmMetaKey(spec: string): string | undefined {
  if (!BARE_PACKAGE.test(spec) || RUNTIME_SPEC.test(spec)) return undefined;
  return NPM_META_PREFIX + spec;
}

/** A package module larger than this is loaded as written (parsing it would slow the build). */
const MAX_PACKAGE_MODULE_BYTES = 512 * 1024;

/** A package file this plugin looks at: JavaScript under `node_modules` or Deno's npm cache. */
const PACKAGE_FILE = /[\\/](?:node_modules|registry\.npmjs\.org)[\\/].*\.(?:m?js|jsx)$/;

/** A hook-shaped name (`useX`, `use2`), or `use` itself never: React's `use` is a primitive. */
const HOOK_NAME = /^use[A-Z0-9]/;

/** Whether the parsed module is an ES module (a CommonJS one must not gain an `import`). */
function isEsModule(body: readonly { type?: string }[]): boolean {
  return body.some((item) =>
    item.type === "ImportDeclaration" || (item.type?.startsWith("Export") ?? false)
  );
}

/** The records worth shipping for a package module: its hooks, hook re-exports and `export *`. */
function hookRecords(metas: Record<string, ComponentDevMeta>): Record<string, ComponentDevMeta> {
  const out: Record<string, ComponentDevMeta> = {};
  for (const [key, meta] of Object.entries(metas)) {
    if (key === "*" || key === "default" || HOOK_NAME.test(key)) out[key] = meta;
  }
  return out;
}

/** Every `npm:` key a module's records point at (a call's `from`, an alias, an `export *`). */
function npmKeysOf(metas: Record<string, ComponentDevMeta>): Set<string> {
  const keys = new Set<string>();
  const note = (url: string | undefined) => {
    if (url?.startsWith(NPM_META_PREFIX)) keys.add(url.replace(/#[^#]*$/, ""));
  };
  for (const meta of Object.values(metas)) {
    for (const hook of meta.hooks) note(hook.from);
    note(meta.aliasOf);
    for (const url of meta.reExportsAll ?? []) note(url);
  }
  return keys;
}

/** The `__dnxMeta("npm:<spec>#*", …)` line pointing a package specifier at its module. */
function packageRecord(key: string, moduleUrl: string): string {
  const meta: ComponentDevMeta = {
    name: "*",
    line: 0,
    column: 0,
    hooks: [],
    reExportsAll: [moduleUrl],
  };
  return `__dnxMeta(${JSON.stringify(`${key}#*`)}, ${JSON.stringify(meta)});\n`;
}

/**
 * The hook-metadata footer of one package module, or `""` when it has nothing to record.
 * Exported for testing.
 *
 * @param source The module's source.
 * @param moduleUrl Its `file://` URL (the registry key prefix).
 * @param resolve The module a package specifier it names resolves to (a path), or undefined.
 * @param entryKeys `npm:` keys of the build's entry points that resolve to this module.
 */
export async function packageMetaFooter(
  source: string,
  moduleUrl: string,
  resolve: (spec: string) => Promise<string | undefined>,
  entryKeys: readonly string[] = [],
): Promise<string> {
  if (source.length > MAX_PACKAGE_MODULE_BYTES) return "";
  const hasHooks = /\buse[A-Z0-9]/.test(source);
  if (!hasHooks && entryKeys.length === 0) return "";
  const parsed = await parseModule(source);
  // A CommonJS module must not gain an `import`; an unparsable one is loaded as written.
  if (!parsed || !isEsModule(parsed.body)) return "";
  let body = entryKeys.map((key) => packageRecord(key, moduleUrl)).join("");
  if (hasHooks) {
    const metas = hookRecords(collectComponentMeta(parsed, moduleUrl, npmMetaKey));
    body += metaCalls(moduleUrl, metas);
    for (const key of npmKeysOf(metas)) {
      const path = await resolve(key.slice(NPM_META_PREFIX.length));
      if (path) body += packageRecord(key, toFileUrl(path).href);
    }
  }
  return body ? `\n\n/* denext DevTools hook names (dev) */\n${META_IMPORT}${body}` : "";
}

/**
 * A dev-only esbuild plugin that gives npm packages' custom hooks DevTools names (see the module
 * header). Add it LAST: its `onLoad` answers only a package's ES module that has something to
 * record, so a plugin before it that loads a package file (a patch, a stub) still wins.
 *
 * @param entrySpecs The build's entry specifiers that are packages (the npm dependency bundle's
 *   entry points), each registered as `npm:<specifier>#*` from the module it resolves to.
 * @param resolveDir Where the entry specifiers resolve from (the project root).
 * @returns The plugin.
 */
export function npmHookMetaPlugin(
  entrySpecs: readonly string[] = [],
  resolveDir?: string,
): esbuild.Plugin {
  return {
    name: "denext-npm-hook-meta",
    setup(build) {
      // Entry path → the `npm:` keys of the entry specifiers that resolve to it.
      let entries = new Map<string, string[]>();
      build.onStart(async () => {
        entries = new Map();
        for (const spec of entrySpecs) {
          const key = npmMetaKey(spec);
          if (!key) continue;
          const hit = await build.resolve(spec, { kind: "entry-point", resolveDir });
          if (hit.errors.length > 0 || hit.external || !hit.path) continue;
          const list = entries.get(hit.path) ?? [];
          list.push(key);
          entries.set(hit.path, list);
        }
      });
      build.onLoad({ filter: PACKAGE_FILE, namespace: "file" }, async (args) => {
        let source: string;
        try {
          source = await Deno.readTextFile(args.path);
        } catch {
          return undefined; // esbuild's own load reports it
        }
        const resolve = async (spec: string) => {
          const hit = await build.resolve(spec, {
            kind: "import-statement",
            importer: args.path,
            resolveDir: dirname(args.path),
          });
          return hit.errors.length > 0 || hit.external || hit.namespace !== "file"
            ? undefined
            : hit.path;
        };
        let footer = "";
        try {
          footer = await packageMetaFooter(
            source,
            toFileUrl(args.path).href,
            resolve,
            entries.get(args.path),
          );
        } catch {
          return undefined; // best-effort: load it as written
        }
        if (!footer) return undefined;
        const loader = args.path.endsWith(".jsx") ? "jsx" : "js";
        return { contents: source + footer, loader, resolveDir: dirname(args.path) };
      });
    },
  };
}
