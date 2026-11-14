// Fresh 1.x plugins (`fresh.config.ts`'s `plugins: [ … ]`) run on denext, as Fresh's server runs
// them: a plugin's `routes` answer like file routes, its `middlewares` wrap the routes under their
// path like `_middleware` files, and its `render` / `renderAsync` hook runs for each page render:
// `ctx.render()` / `ctx.renderAsync()` resolve with the page's rendered HTML once it has
// rendered, and the result's `styles`, `links` and `scripts` go into the page (the scripts'
// entrypoints are bundled by the `freshPlugins()` denext plugin, `denext/fresh/plugins`).
// Island folders a plugin names are made `"use client"` by `denext migrate`.

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { onRenderSettled } from "../../runtime/server-inserted-html.ts";

/** What a page render hands a plugin's hook (`ctx.render()` / `ctx.renderAsync()`). */
export interface PluginRenderFunctionResult {
  /** The page's rendered HTML. */
  htmlText: string;
  /** Whether the page has islands to hydrate. */
  requiresHydration: boolean;
}

/** What a plugin's render hook returns. */
export interface PluginRenderResult {
  /** `<style>` elements for the page's head. */
  styles?: { cssText: string; media?: string; id?: string }[];
  /** Client entrypoints to run with a state each (`entrypoint` names one of `entrypoints`). */
  scripts?: { entrypoint: string; state: unknown }[];
  /** `<link>` elements for the page's head. */
  links?: Record<string, string | undefined>[];
  /** Replacement body HTML (denext keeps its own render's: the page is not a string). */
  htmlText?: string;
}

/** A Fresh 1.x plugin (`Plugin` from `$fresh/server.ts`). */
export interface FreshPlugin {
  /** The plugin's name. */
  name: string;
  /** Client entrypoints by name (module specifiers). */
  entrypoints?: Record<string, string>;
  /** The synchronous render hook. */
  render?(ctx: { render(): PluginRenderFunctionResult }): PluginRenderResult;
  /** The asynchronous render hook. */
  renderAsync?(
    ctx: { renderAsync(): Promise<PluginRenderFunctionResult> },
  ): Promise<PluginRenderResult>;
  /** Routes, by a routes-relative path (`/oauth/signin`, `blog/[slug]`). */
  routes?: { path: string; component?: unknown; handler?: unknown }[];
  /** Middleware, by the directory path it covers (`/`, `admin`). */
  middlewares?: { path: string; middleware: { handler: unknown } }[];
  /** Island modules, relative to `baseLocation`. */
  islands?: { baseLocation: string; paths: string[] };
  /** Build hooks (Fresh's own build): not called on denext. */
  buildStart?(config: unknown): unknown;
  /** Build hooks (Fresh's own build): not called on denext. */
  buildEnd?(): unknown;
  /** Config hook: not called on denext. */
  configResolved?(config: unknown): unknown;
}

/** Where the `freshPlugins()` build plugin publishes each bundled entrypoint. */
export const PLUGIN_SCRIPT_DIR = "_fresh-plugins";

/** A plugin entrypoint's published file name (`<plugin>-<entrypoint>.js`). */
export function pluginScriptFile(plugin: string, entrypoint: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${safe(plugin)}-${safe(entrypoint)}.js`;
}

/** The selector the bundled entrypoint reads its states from. */
export function pluginStateAttr(plugin: string, entrypoint: string): string {
  return `${plugin}:${entrypoint}`;
}

/** A plugin route's URL pattern, as Fresh maps `./routes<path>.ts` (`[id]` → `:id`). */
export function pluginRoutePattern(path: string): string {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts[parts.length - 1] === "index") parts.pop();
  const pieces = parts.filter((p) => !/^\(.+\)$/.test(p)).map((p) =>
    p.startsWith("[...") && p.endsWith("]")
      ? `:${p.slice(4, -1)}*`
      : p.replace(/\[([^\]]+)\]/g, ":$1")
  );
  return `/${pieces.join("/")}`;
}

/** Whether a plugin route path is one of Fresh's special files (`_app`, `_404`, …). */
export function isSpecialPluginRoute(path: string): boolean {
  return /(?:^|\/)_[a-z0-9]+$/i.test(path.replace(/\.[jt]sx?$/, ""));
}

/** A plugin middleware's URL prefix (Fresh's `formatMiddlewarePath`, without the slash). */
export function pluginMiddlewarePrefix(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}

/** The plugin middlewares: each one's prefix and functions, in the plugins' order. */
export function pluginMiddlewareEntries(
  plugins: readonly FreshPlugin[],
): { prefix: string; fns: unknown[] }[] {
  return plugins.flatMap((p) => p.middlewares ?? []).map((m) => {
    const handler = m.middleware?.handler;
    return {
      prefix: pluginMiddlewarePrefix(m.path),
      fns: (Array.isArray(handler) ? handler : [handler]).filter((f) => typeof f === "function"),
    };
  });
}

/** The page markup a render hook's result adds: styles and links in the head, scripts. */
function renderResultHead(plugin: FreshPlugin, res: PluginRenderResult): VNode[] {
  const out: VNode[] = [];
  for (const [i, s] of (res.styles ?? []).entries()) {
    const props = {
      key: `s${i}`,
      id: s.id,
      media: s.media,
      dangerouslySetInnerHTML: { __html: s.cssText },
    };
    out.push(h("style", props));
  }
  for (const [i, l] of (res.links ?? []).entries()) out.push(h("link", { key: `l${i}`, ...l }));
  const entries = new Set<string>();
  for (const [i, s] of (res.scripts ?? []).entries()) {
    const state = JSON.stringify(s.state ?? null).replace(/</g, "\\u003c");
    out.push(h("script", {
      key: `d${i}`,
      type: "application/json",
      "data-fresh-plugin-state": pluginStateAttr(plugin.name, s.entrypoint),
      dangerouslySetInnerHTML: { __html: state },
    }));
    entries.add(s.entrypoint);
  }
  for (const entry of entries) {
    const src = `/${PLUGIN_SCRIPT_DIR}/${pluginScriptFile(plugin.name, entry)}`;
    out.push(h("script", { key: `m${entry}`, type: "module", src }));
  }
  return out;
}

/** The hook result's check Fresh makes: a hook must return a result object. */
function checked(plugin: FreshPlugin, res: PluginRenderResult | undefined, kind: string) {
  if (res === undefined || res === null) {
    throw new Error(`${plugin.name}'s ${kind} hook did not return a PluginRenderResult object.`);
  }
  return res;
}

/**
 * Run the plugins' render hooks for this page render. An async hook starts now (its code before
 * `await ctx.renderAsync()` runs before the page renders) and resumes once the page has rendered;
 * a sync hook runs then. Each result's head markup is written into the page's head.
 *
 * @param plugins The app's plugins.
 */
export function runPluginRenderHooks(plugins: readonly FreshPlugin[]): void {
  for (const plugin of plugins) {
    if (plugin.renderAsync) startAsyncHook(plugin);
    else if (plugin.render) {
      const hook = plugin.render.bind(plugin);
      onRenderSettled((html) => {
        const res = hook({ render: () => ({ htmlText: html, requiresHydration: true }) });
        return renderResultHead(plugin, checked(plugin, res, "render"));
      });
    }
  }
}

/** Start an async render hook: it resumes with the page's HTML once the page has rendered. */
function startAsyncHook(plugin: FreshPlugin): void {
  const rendered = Promise.withResolvers<PluginRenderFunctionResult>();
  const result = plugin.renderAsync!({ renderAsync: () => rendered.promise });
  // An early failure is reported once the page has rendered, where the head is written.
  result.catch(() => {});
  onRenderSettled(async (html) => {
    rendered.resolve({ htmlText: html, requiresHydration: true });
    return renderResultHead(plugin, checked(plugin, await result, "async render"));
  });
}
