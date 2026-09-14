// SPA-mode Fast Refresh: a per-module esbuild transform.
//
// The App Router gets Fast Refresh for free — denext *generates* its route/Flight
// entry, so it can emit `registerFamily(Component, "url#export")` for every
// route-structural component there (see `generateRouteEntry`/`generateFlightEntry`
// in `build/bundle.ts`). A SPA has no generated entry: the app's own `main.tsx`
// calls `createRoot(el).render(<App/>)`, and its components live in ordinary source
// modules denext never authored. So there is nowhere to hang the registrations.
//
// This plugin supplies them. On the esbuild `onLoad` for each app `.tsx`/`.jsx`
// source, it appends a `registerFamily(Name, "<sourceUrl>#Name")` call for every
// top-level component-shaped declaration (a PascalCase function / class, or a const
// bound to an arrow/function expression). The family id is the **source** file URL —
// stable across rebuilds (the browser cache-busts the entry import, not these baked
// strings) — so a re-imported edit's fresh function ref shares a family with the
// live one, and the reconciler (once `enableFastRefresh()` installs the family seam)
// reconciles the new code onto the existing fiber tree, preserving hook state.
//
// It is dev-only (never added to a production build) and correctness-first: a module
// it can't confidently instrument is loaded unchanged (its components simply
// remount on edit — the pre-refresh behavior), never miscompiled.

import type * as esbuild from "esbuild";
import { toFileUrl } from "@std/path";
import { collectComponentMeta, componentDecls, metaFooter } from "./devtools-meta.ts";
import type { ComponentDevMeta } from "../client/devtools-meta.ts";
import { type ParsedModule, parseModule } from "./swc-ast.ts";
import { firstPartyTsxPlugin } from "./spa-onload.ts";

/** A module's Fast Refresh registrations and the DevTools metadata that rides along. */
export interface ModuleComponents {
  /** The component-shaped binding names to register as families (components only). */
  names: string[];
  /** Dev metadata per tracked declaration — components AND `use*` custom hooks. */
  metas: Record<string, ComponentDevMeta>;
}

/**
 * The top-level component-shaped binding names of a parsed module — PascalCase
 * function/class declarations and PascalCase consts bound to an arrow/function
 * expression, whether or not they are `export`ed — plus the DevTools metadata of those
 * and of the module's `use*` custom hooks. Object/value consts are excluded (only
 * callables are components), so a `const Config = {…}` is never registered.
 *
 * Only `names` drives `registerFamily`: a custom hook has no fiber identity, it only
 * contributes hook-name metadata.
 *
 * @param parsed The module parsed by `parseModule()`.
 * @param sourceUrl The module's `file://` URL — resolves the `from` of a custom hook bound
 *   by a static relative import (omitted ⇒ such calls stay opaque).
 * @returns The family names and the per-declaration metadata.
 */
export function collectComponents(parsed: ParsedModule, sourceUrl?: string): ModuleComponents {
  return {
    names: componentDecls(parsed).filter((d) => d.component).map((d) => d.name),
    metas: collectComponentMeta(parsed, sourceUrl),
  };
}

/**
 * The `registerFamily` import + one registration per component, appended to a module —
 * with the DevTools metadata sidecar (`__dnxMeta(id, {…})`) when `metas` is given. A module
 * of custom hooks only (no component) gets the sidecar alone, so a component importing one
 * of its hooks can name that hook's cells across the module boundary.
 *
 * @param sourceUrl The module's `file://` URL (the family id prefix).
 * @param names The component names to register.
 * @param metas Optional dev metadata (omitted ⇒ no sidecar).
 * @returns The footer source, or `""` when there is nothing to register or record.
 */
export function refreshFooter(
  sourceUrl: string,
  names: string[],
  metas?: Record<string, ComponentDevMeta>,
): string {
  const sidecar = metas ? metaFooter(sourceUrl, metas) : "";
  if (names.length === 0 && !sidecar) return "";
  // Alias the import so it can never shadow (or be shadowed by) a user binding named
  // `registerFamily`. The import is idempotent — ESM allows a module to import the
  // same specifier more than once — so a hand-written `denext/client` import is fine.
  const regs = names.length === 0 ? "" : names
    .map((n) => `__dnxRegisterFamily(${n}, ${JSON.stringify(`${sourceUrl}#${n}`)});`)
    .join("\n");
  // Leading blank lines: the source may end without a newline (a registration must
  // not fuse onto a trailing `//` comment or expression).
  return `\n\n/* denext Fast Refresh (dev) */\n` +
    (regs
      ? `import { registerFamily as __dnxRegisterFamily } from "denext/client-runtime";\n` +
        regs + "\n"
      : "") +
    sidecar;
}

/**
 * A dev-only esbuild plugin that instruments each app source module with Fast
 * Refresh family registrations (see the module header). Registered as an
 * `extraPlugin` so its `onLoad` front-runs the deno-loader's own file load.
 *
 * @param projectDir Absolute app root — only files under it are instrumented (npm
 *   deps under `node_modules`, and the generated `.entries` wrappers, are skipped).
 */
export function spaRefreshPlugin(projectDir: string): esbuild.Plugin {
  return firstPartyTsxPlugin("denext-spa-fast-refresh", projectDir, async (source, path) => {
    // Parse-and-instrument is best-effort: a parse failure (caught by the shared wrapper)
    // leaves the module as written — those components simply remount on edit.
    const parsed = await parseModule(source);
    if (!parsed) return null; // unparseable/empty → leave unchanged
    const url = toFileUrl(path).href;
    const { names, metas } = collectComponents(parsed, url);
    const footer = refreshFooter(url, names, metas);
    return footer ? source + footer : null; // nothing to register or record → unchanged
  });
}
