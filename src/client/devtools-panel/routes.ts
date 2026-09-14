// DevTools panel: the Routes tab — everything that renders at a path, as the dev server's
// cached route manifest already knows it (`/_denext/dev-routes`). Read once per probe
// rather than polled: the manifest only changes when a file is added or removed, which
// reloads the page anyway.
//
// It opens on the page you are looking at (`location.pathname`) and takes any other path
// in its input, so you can ask "what would render at /blog/hello?" without navigating.
// Every file it prints is a button that opens that file in your editor through
// `/_denext/open-in-editor` — the same multi-editor, containment-checked route the error
// overlay uses.
//
// Style note: every colour below is an inline string built inside a function, never a
// module-scope object literal — see ./styles.ts for why (esbuild retains top-level
// literals even when the only code using them is dead, shipping them to production).

import {
  h4,
  type PanelCtx,
  type PanelState,
  refreshDataTab,
  renderDataPlaceholder,
} from "./ctx.ts";
import { DEV_ROUTES_PATH, openInEditor } from "./dev-api.ts";
import { el } from "./styles.ts";

/** One module of the render tree, as `/_denext/dev-routes` reports it. */
interface RouteModule {
  /** The module path, relative to the app directory. */
  file: string;
  /** `"client"` when the module declares `"use client"`, else `"server"`. */
  boundary: string;
}

/**
 * The matched page's render tree — the client-side mirror of `RouteMapPage`
 * (src/mcp/inspect.ts), which documents each field.
 */
interface RoutePage {
  routePath: string;
  params: Record<string, unknown>;
  file: string;
  boundary: string;
  layouts: RouteModule[];
  templates: RouteModule[];
  boundaries: Record<string, string>;
  slots: { name: string; pages: number }[];
}

/** The endpoint payload (`RouteMapData` in src/mcp/inspect.ts), as the tab reads it. */
interface RouteMap {
  path: string;
  matched: boolean;
  page?: RoutePage;
  api?: { routePath: string; file: string };
  /** Absolute path of the app directory each `file` above is relative to. */
  appDir?: string;
}

/**
 * The tab's live DOM + probed path, kept across renders.
 *
 * The toolbar is built once and re-appended (rather than rebuilt) on every render so that
 * typing in the path box doesn't destroy the element being typed into.
 */
interface RoutesUi {
  /** The path the last read asked for. */
  path: string;
  /** The toolbar, re-appended each render. */
  toolbar: HTMLElement;
}

/**
 * Where {@link RoutesUi} is parked. `PanelState` is owned by ./ctx.ts (another job this
 * wave), so the tab hangs its own slice off the state object under a key it alone uses.
 */
interface RoutesStateSlot {
  /** This tab's toolbar + probed path, created on first render. */
  routesUi?: RoutesUi;
}

/** How far each nesting level of the render tree is indented, in pixels. */
const INDENT_PX = 11;

/**
 * Draw the Routes tab from the last read.
 *
 * @param ctx The mounted panel context.
 */
export function renderRoutesTab(ctx: PanelCtx): void {
  // The placeholder states (loading / no such endpoint) own the pane alone — there is
  // nothing to probe against a dev server that serves no route map.
  if (renderDataPlaceholder(ctx, "Routes", ctx.state.routes)) return;
  const { doc, S, detailPane } = ctx;
  const ui = routesUi(ctx);
  detailPane.append(ui.toolbar);
  const map = ctx.state.routes.data as RouteMap | null;
  if (!map || !map.matched) {
    detailPane.append(el(doc, "div", S.empty, `nothing renders at ${map?.path ?? ui.path}`));
    return;
  }
  if (map.api) {
    detailPane.append(h4(ctx, false, "API route"));
    detailPane.append(el(doc, "div", S.kv, el(doc, "span", S.comp, map.api.routePath)));
    detailPane.append(fileRow(ctx, map.api.file, map.appDir, 0, "route"));
  }
  if (map.page) renderPage(ctx, map.page, map.appDir);
}

/**
 * Read the route map into {@link PanelCtx.state}. Called when the tab is selected, and
 * again whenever the probed path changes.
 *
 * @param ctx The mounted panel context.
 */
export function refreshRoutesTab(ctx: PanelCtx): void {
  void refreshDataTab(ctx, ctx.state.routes, DEV_ROUTES_PATH, { path: routesUi(ctx).path });
}

/**
 * The path the tab opens on: the page currently being looked at, or `/` when there is no
 * document (a test, a worker).
 *
 * @returns A path beginning with `/`.
 */
function currentPath(): string {
  const loc = (globalThis as { location?: { pathname?: string } }).location;
  const path = loc?.pathname;
  return typeof path === "string" && path.startsWith("/") ? path : "/";
}

/**
 * The tab's toolbar + probed path, created on first render and reused afterwards.
 *
 * @param ctx The mounted panel context.
 * @returns The live toolbar handle.
 */
function routesUi(ctx: PanelCtx): RoutesUi {
  const slot = ctx.state as PanelState & RoutesStateSlot;
  if (slot.routesUi) return slot.routesUi;
  const { doc, S } = ctx;
  const box = doc.createElement("input") as HTMLInputElement;
  box.style.cssText = S.search;
  box.setAttribute("type", "text");
  box.setAttribute("placeholder", "/path to map");
  box.value = currentPath();
  const go = el(doc, "button", S.icon, "map");
  go.setAttribute("type", "button");
  go.setAttribute("title", "Map what renders at this path");
  const ui: RoutesUi = {
    path: currentPath(),
    toolbar: el(doc, "div", S.toolbar, box, go),
  };
  const probe = (): void => {
    const next = box.value.trim() || "/";
    ui.path = next.startsWith("/") ? next : `/${next}`;
    refreshRoutesTab(ctx);
  };
  box.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") probe();
  });
  box.addEventListener("change", probe);
  go.addEventListener("click", probe);
  slot.routesUi = ui;
  return ui;
}

/**
 * The matched page: its pattern + params, then the render tree from the outermost layout
 * down to the page itself, then the boundary files and parallel slots.
 *
 * @param ctx The mounted panel context.
 * @param page The matched page from the endpoint.
 * @param appDir The app directory the file paths are relative to.
 */
function renderPage(ctx: PanelCtx, page: RoutePage, appDir?: string): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, false, "Page"));
  detailPane.append(el(doc, "div", S.kv, el(doc, "span", S.comp, page.routePath)));
  renderParams(ctx, page.params);
  detailPane.append(h4(ctx, false, "Render tree"));
  let depth = 0;
  for (const layout of page.layouts) {
    detailPane.append(moduleRow(ctx, "layout", layout, appDir, depth++));
  }
  for (const template of page.templates) {
    detailPane.append(moduleRow(ctx, "template", template, appDir, depth++));
  }
  detailPane.append(
    moduleRow(ctx, "page", { file: page.file, boundary: page.boundary }, appDir, depth),
  );
  renderBoundaries(ctx, page, appDir);
  renderSlots(ctx, page);
}

/**
 * The matched dynamic parameters as key/value rows (nothing at all for a static route).
 *
 * @param ctx The mounted panel context.
 * @param params The endpoint's `params` object.
 */
function renderParams(ctx: PanelCtx, params: Record<string, unknown>): void {
  const { doc, S, detailPane } = ctx;
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return;
  detailPane.append(h4(ctx, false, "Params"));
  for (const [key, value] of entries) {
    detailPane.append(
      el(doc, "div", S.kv, el(doc, "span", S.k, key), el(doc, "span", S.v, String(value))),
    );
  }
}

/**
 * The page's loading/error/not-found/forbidden/unauthorized files, in that order.
 *
 * @param ctx The mounted panel context.
 * @param page The matched page from the endpoint.
 * @param appDir The app directory the file paths are relative to.
 */
function renderBoundaries(ctx: PanelCtx, page: RoutePage, appDir?: string): void {
  const order = ["loading", "error", "notFound", "forbidden", "unauthorized"];
  const rows = order
    .map((key) => [key, page.boundaries?.[key]] as const)
    .filter((pair): pair is readonly [string, string] => typeof pair[1] === "string");
  if (rows.length === 0) return;
  ctx.detailPane.append(h4(ctx, false, "Boundaries"));
  for (const [key, file] of rows) ctx.detailPane.append(fileRow(ctx, file, appDir, 0, key));
}

/**
 * The page's parallel-route slots and how many pages each holds.
 *
 * @param ctx The mounted panel context.
 * @param page The matched page from the endpoint.
 */
function renderSlots(ctx: PanelCtx, page: RoutePage): void {
  const { doc, S, detailPane } = ctx;
  const slots = page.slots ?? [];
  if (slots.length === 0) return;
  detailPane.append(h4(ctx, false, "Slots"));
  for (const slot of slots) {
    detailPane.append(
      el(
        doc,
        "div",
        S.kv,
        el(doc, "span", S.key, `@${slot.name}`),
        el(doc, "span", S.dim, `${slot.pages} page(s)`),
      ),
    );
  }
}

/**
 * One module of the render tree: its role, its file (clickable), and a server/client badge.
 *
 * @param ctx The mounted panel context.
 * @param role `"layout"`, `"template"` or `"page"`.
 * @param mod The module the endpoint reported.
 * @param appDir The app directory the file path is relative to.
 * @param depth How many levels in the tree to indent it.
 * @returns The row element.
 */
function moduleRow(
  ctx: PanelCtx,
  role: string,
  mod: RouteModule,
  appDir: string | undefined,
  depth: number,
): HTMLElement {
  const row = fileRow(ctx, mod.file, appDir, depth, role);
  row.append(boundaryBadge(ctx, mod.boundary));
  return row;
}

/**
 * A labelled, indented row whose file name opens that file in the editor.
 *
 * @param ctx The mounted panel context.
 * @param file The module path, relative to the app directory.
 * @param appDir The app directory, used to rebuild the absolute path the editor needs.
 * @param depth How many levels in the tree to indent it.
 * @param label The role shown before the file.
 * @returns The row element.
 */
function fileRow(
  ctx: PanelCtx,
  file: string,
  appDir: string | undefined,
  depth: number,
  label: string,
): HTMLElement {
  const { doc, S } = ctx;
  const row = el(doc, "div", `${S.kv};padding-left:${depth * INDENT_PX}px`);
  row.append(el(doc, "span", S.dim, `${label}:`));
  const link = el(doc, "button", `${S.act};color:#e6e9ef;text-align:left`, file);
  link.setAttribute("type", "button");
  link.setAttribute("title", "Open in your editor");
  link.addEventListener("click", () => openInEditor(appDir ? `${appDir}/${file}` : file));
  row.append(link);
  return row;
}

/**
 * The `server` / `client` badge a module carries.
 *
 * @param ctx The mounted panel context.
 * @param boundary The module's boundary.
 * @returns The badge element.
 */
function boundaryBadge(ctx: PanelCtx, boundary: string): HTMLElement {
  const color = boundary === "client" ? "#f0b45b" : "#5fd48a";
  const style = `${ctx.S.pill};background:${color};color:#0c0e14;margin-left:4px`;
  return el(ctx.doc, "span", style, boundary);
}
