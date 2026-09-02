// The "execute + inspect" half of the denext MCP tools: render a route or component
// server-side (no browser) and map everything that renders at a path.
//
// `renderRoute` is the flagship "try it" — an agent can render a page in-process and see the
// real HTML or the real error, closing the edit→render→fix loop without a browser or a live
// server. It reuses `denext/testing`'s browser-free app client (the JS-disabled surface).
// `renderComponent` renders a single component with props via the testing renderer.
// `routeMap` reports the full render tree at a path (layouts, boundaries, client/server
// split) from the route manifest — cheap context an agent would otherwise open many files for.
//
// These run in-process, so they resolve against the project's own `deno.json` — which is the
// config the MCP server picks up when launched from the project directory (the normal case).

import { relative, resolve, toFileUrl } from "@std/path";
import { resolveProject } from "../build/paths.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import type { Directive } from "../build/directives.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { createTestApp, createTestClient } from "../testing/mod.ts";
import { render } from "../testing/render.ts";
import { h } from "../jsx/jsx-runtime.ts";

/** Truncate rendered HTML so a tool result stays a reasonable size. */
function clampHtml(html: string, max = 8000): string {
  return html.length > max
    ? `${html.slice(0, max)}\n… [truncated, ${html.length} bytes total]`
    : html;
}

/**
 * Render a route server-side (no browser) and return its status + HTML.
 *
 * @param dir The project directory.
 * @param path The route path to render (e.g. `/blog/hello`).
 * @returns A text report: status line, any redirect, and the rendered HTML (truncated).
 */
export async function renderRoute(dir: string, path: string): Promise<string> {
  const client = createTestClient(await createTestApp(dir));
  const res = await client.get(path);
  const redirect = res.location ? `\n→ redirect: ${res.location}` : "";
  const note = res.status >= 500
    ? "\n(500 — the route threw while rendering. Run `denext dev` and use denext_dev_logs for " +
      "the error message + codeframe.)"
    : res.status === 404
    ? "\n(404 — no route matched this path. Try denext_list_routes.)"
    : "";
  return `${path} → ${res.status}${redirect}${note}\n\n${clampHtml(res.text)}`;
}

/**
 * Render a single component with props via the browser-free test renderer.
 *
 * @param dir The project directory (props/imports resolve relative to it).
 * @param componentPath The component module path (relative to `dir`).
 * @param props Props passed to the component.
 * @returns The component's rendered inner HTML.
 */
export async function renderComponent(
  dir: string,
  componentPath: string,
  props: Record<string, unknown>,
): Promise<string> {
  const abs = resolve(dir, componentPath);
  const mod = await import(toFileUrl(abs).href);
  const Component = mod.default ?? Object.values(mod).find((v) => typeof v === "function");
  if (typeof Component !== "function") {
    throw new Error(`no component export found in ${componentPath}`);
  }
  // deno-lint-ignore no-explicit-any
  const screen = await render(h(Component as any, props ?? {}));
  return clampHtml(screen.html());
}

/** "client" if a module declares `"use client"`, else "server" (the default). */
function boundaryOf(filePath: string, directives?: Map<string, Directive>): string {
  return directives?.get(filePath) === "client" ? "client" : "server";
}

/** The boundary special-file lines for a page (loading/error/not-found/…). */
function boundaryLines(route: PageRoute, rel: (p: string) => string): string[] {
  const out: string[] = [];
  const add = (name: string, p: string | null) => {
    if (p) out.push(`  ${name}: ${rel(p)}`);
  };
  add("loading", route.loading);
  add("error", route.error);
  add("not-found", route.notFound);
  add("forbidden", route.forbidden);
  add("unauthorized", route.unauthorized);
  return out;
}

/**
 * Map the full render tree at a path: the matched page (+ params), its layout and template
 * chains with each module's client/server boundary, its loading/error/… boundaries and
 * parallel slots, and any API route at the same path — all from the route manifest.
 *
 * @param dir The project directory.
 * @param path The route path to map.
 * @returns A compact text map, or a "no match" hint.
 */
export async function routeMap(dir: string, path: string): Promise<string> {
  const paths = await resolveProject(dir);
  const manifest = await scanRoutes(paths.appDir);
  const rel = (p: string) => relative(paths.appDir, p);
  const dir2 = manifest.directives;

  const api = matchApi(manifest, path);
  const page = matchPage(manifest, path);
  if (!page && !api) return `No route matches "${path}". Try denext_list_routes.`;

  const lines: string[] = [];
  if (api) lines.push(`API route: ${api.route.routePath} → ${rel(api.route.filePath)}`);
  if (page) {
    const r = page.route;
    lines.push(`Page: ${r.routePath}   params: ${JSON.stringify(page.params)}`);
    lines.push(`  page: ${rel(r.filePath)} [${boundaryOf(r.filePath, dir2)}]`);
    for (const l of r.layoutChain) lines.push(`  layout: ${rel(l)} [${boundaryOf(l, dir2)}]`);
    for (const t of r.templateChain) lines.push(`  template: ${rel(t)} [${boundaryOf(t, dir2)}]`);
    lines.push(...boundaryLines(r, rel));
    for (const [name, slot] of Object.entries(r.slots ?? {})) {
      lines.push(`  @${name} slot: ${slot.pages.length} page(s)`);
    }
  }
  return lines.join("\n");
}
