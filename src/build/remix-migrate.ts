// The Remix source path for `denext migrate` — the first adapter that physically
// TRANSFORMS an app's route tree rather than only writing config.
//
// Unlike the Next/Vite/CRA paths (which rely on the app's file conventions already
// matching denext's), Remix uses `app/routes/*` flat-file + dot-delimited nesting, a
// single `app/root.tsx`, `loader`/`action` exports, and `entry.{server,client}`. So
// this module:
//   • restructures `app/routes/*` → denext folder-per-segment `app/**/page.tsx` +
//     `layout.tsx` (`$param` → `[param]`, `$` → `[...splat]`, `_index` → the segment
//     page, pathless `_x` → a `(x)` route group, dotted nesting → nested folders);
//   • converts `app/root.tsx` → `app/layout.tsx` (strips `<Meta/>`/`<Links/>`/
//     `<Scripts/>`/`<ScrollRestoration/>`, `<Outlet/>` → `{children}`);
//   • deletes `entry.server.*`/`entry.client.*`;
//   • rewrites the imports (`@remix-run/*` / `react-router*` → `denext/remix` and
//     `denext/remix/server`) and PRESERVES the data model: each route is split into a
//     `page.data.tsx` (its `loader`/`action`, run by the `denext/remix` runtime), a
//     `page.client.tsx` (the component, `useLoaderData()` and friends intact) and a
//     `page.tsx` wrapper, plus a `route.ts` handler for a page with an `action`.
//
// Structural edge cases the transform cannot decide (a trailing-`_` layout break-out, a
// v1 `CatchBoundary`, a layout with no `<Outlet/>`) are not applied silently: they are
// emitted as review warnings and counted in the report, so it is an ASSISTED migration.

import { isAbsolute, join, relative } from "@std/path";
import { anyExists, exists, firstExisting } from "./migrate-fs.ts";
import {
  analyzeModule,
  clientModuleSource,
  dataModuleSource,
  declaredNames,
  errorWrapperSource,
  freeIdentifiers,
  GEN_HEADER,
  type HelperDecl,
  isTypeDecl,
  layoutWrapperSource,
  type ModuleParts,
  pageActionRouteSource,
  pageWrapperSource,
  parseRouteModule,
  referencedIds,
  resourceRouteSource,
  rewriteRemixImports,
  rootNeedsClient,
  selectHelperDecls,
  SERVER_EXPORTS,
  serverRootLayoutSource,
  usedImports,
} from "./remix-codegen.ts";
export { analyzeModule, rewriteRemixImports, selectHelpers } from "./remix-codegen.ts";
import { type Ctx, type Node, txt, walkAst } from "./swc-ast.ts";

/** What {@link transformRemixApp} did, for the CLI to print (assisted-migration report). */
export interface RemixMigrateInfo {
  /** `page.tsx`/`layout.tsx` files written under `app/`. */
  routesConverted: number;
  /** Routes carrying a `loader` — inverted into a Server Component + flagged for review. */
  loaders: number;
  /** Routes carrying an `action` — scaffolded as a `"use server"` skeleton + flagged. */
  actions: number;
  /** `app/root.tsx` was converted to `app/layout.tsx`. */
  rootConverted: boolean;
  /** `entry.server.*`/`entry.client.*` files removed. */
  entriesDeleted: string[];
  /** Per-route structural notes a human should review. */
  warnings: string[];
}

/** Route module extensions Remix recognizes, most-specific (tsx) first. */
const ROUTE_EXTS = ["tsx", "jsx", "ts", "js"] as const;

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * True for a Remix (or React-Router-v7 framework-mode) app. Keys on `@remix-run/*`
 * deps, a `remix.config.*`, a React-Router-v7 framework install (`react-router` +
 * `@react-router/*` + a `react-router.config.*`), or the structural signature
 * `app/root.tsx` + `app/routes/`. Must be checked BEFORE the Vite-SPA detector —
 * Remix-Vite carries a `vite.config`, which would otherwise capture it as a SPA.
 */
export async function isRemix(dir: string, deps: Record<string, string>): Promise<boolean> {
  if (Object.keys(deps).some((d) => d.startsWith("@remix-run/"))) return true;
  if (await anyExists(dir, ["remix.config.js", "remix.config.mjs", "remix.config.ts"])) {
    return true;
  }
  // React Router v7 framework mode (Remix's successor) uses the same route conventions.
  const rrFramework = "react-router" in deps ||
    Object.keys(deps).some((d) => d.startsWith("@react-router/"));
  if (
    rrFramework &&
    await anyExists(dir, ["react-router.config.ts", "react-router.config.js"])
  ) return true;
  // Structural fallback: the canonical Remix layout (a root module + a routes tree).
  const hasRoot = await anyExists(dir, [
    "app/root.tsx",
    "app/root.jsx",
    "app/root.ts",
    "app/root.js",
  ]);
  return hasRoot && await exists(join(dir, "app", "routes"));
}

// ── Route-name parsing (Remix flat/dot-nested → denext segments) ──────────────

/** A Remix route stem parsed into denext folder segments. */
export interface ParsedRemixRoute {
  /** denext path segments (`[param]`, `[...splat]`, `(group)`, or a literal). */
  segments: string[];
  /** The route is its parent segment's index (`_index`, or a trailing `._index`). */
  isIndex: boolean;
  /**
   * Segment paths (`/`-joined) this route breaks OUT of: a trailing-`_` segment
   * (`users.$username_.notes`) opts the route out of that ancestor's layout, so the
   * ancestor stays a plain page for it (Remix semantics, honored by the layout detector).
   */
  breakOuts: string[];
  /** Structural notes (pathless group) for the report. */
  warnings: string[];
}

/**
 * Parse a Remix route stem (a flat filename without extension, or a `route.tsx`
 * folder name) into denext folder segments. Handles dot-delimited nesting
 * (`concerts.$city` → `concerts/[city]`), `$param` → `[param]`, `$` splat →
 * `[...splat]`, `_index` → an index marker, a pathless `_layout` segment → a
 * `(layout)` route group, a trailing-`_` break-out (flattened + flagged), and
 * `[literal]` escapes (Remix's way to include a `.` or other special char).
 */
export function parseRemixStem(stem: string): ParsedRemixRoute {
  const warnings: string[] = [];
  // Protect `[escaped]` groups (e.g. `sitemap[.]xml`) before splitting on `.`.
  const escapes: string[] = [];
  const protectedStem = stem.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
    escapes.push(inner);
    return `\uE000${escapes.length - 1}\uE000`;
  });
  const restore = (s: string) =>
    s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => escapes[Number(i)]);

  const rawSegs = protectedStem.split(".");
  let isIndex = false;
  const segments: string[] = [];
  const breakOuts: string[] = [];
  for (const raw of rawSegs) {
    if (raw === "_index") {
      isIndex = true;
      continue;
    }
    // A trailing `_` (`dashboard_`, `$username_`) opts the route out of this segment's
    // layout: the segment still contributes to the URL, but the ancestor route at this
    // path stays a page for it. Strip it before reading the segment itself.
    const breakOut = raw.length > 1 && raw.endsWith("_") && !raw.startsWith("_");
    const seg = breakOut ? raw.slice(0, -1) : raw;
    if (seg === "$") {
      segments.push("[...splat]");
    } else if (seg.startsWith("$")) {
      segments.push(`[${restore(seg.slice(1))}]`);
    } else if (seg.startsWith("_")) {
      // Pathless layout route → a denext route group (adds no URL segment).
      const name = restore(seg.slice(1));
      segments.push(`(${name})`);
      warnings.push(`pathless "${seg}" → route group "(${name})"`);
    } else {
      segments.push(restore(seg));
    }
    if (breakOut) breakOuts.push(segments.join("/"));
  }
  return { segments, isIndex, breakOuts, warnings };
}

// ── Route collection ─────────────────────────────────────────────────────────

interface RemixRoute {
  /** Absolute path to the route module. */
  file: string;
  /** The parsed stem (flat filename or `route.tsx` folder name). */
  parsed: ParsedRemixRoute;
  /** The `/`-joined segment path (for prefix/layout detection). */
  key: string;
  /**
   * The route's **Remix-canonical id** (`routes/<stem>`, e.g. `routes/notes.$noteId`) —
   * what `useMatches`/`useRouteLoaderData(id)` expect. Apps commonly key on these strings
   * (`useRouteLoaderData("root")`, `matches.find(m => m.id === "routes/notes")`), so the
   * generated wrapper threads THIS id (not a denext-internal one) into the route provider.
   */
  remixId: string;
  /** The module source. */
  source: string;
}

/** Module suffixes under `app/routes/` that are colocated code or tests, never routes. */
const NON_ROUTE = /\.(css|server|client|test|spec)$/;

/**
 * Collect every route module under `app/routes/`, in the conventions real apps use:
 * Remix v2 flat files (`about.tsx`, `concerts.$city.tsx`), the v2 folder form
 * (`concerts.$city/route.tsx`), and remix-flat-routes' hybrid form — `name+/` folders whose
 * files inherit the `name.` prefix (nesting recursively: `users+/$username_+/notes.tsx` →
 * `users.$username_.notes`), `_layout.tsx` for the folder's own route, `index.tsx` for its
 * index. `__x`, dotfiles, `*.server.*`, `*.client.*`, `*.test.*` and `*.css` are colocated,
 * not routes. Each route keeps its Remix id: the module path under `app/` without the
 * extension (`routes/users+/$username_+/notes`), which apps key on.
 */
async function collectRemixRoutes(routesDir: string): Promise<RemixRoute[]> {
  const out: RemixRoute[] = [];
  await walkRoutesDir(routesDir, routesDir, "", out);
  return out;
}

/** One directory of the routes tree; `prefix` is the dot-stem its `+` ancestors contribute. */
async function walkRoutesDir(
  routesDir: string,
  dir: string,
  prefix: string,
  out: RemixRoute[],
): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name.startsWith(".") || e.name.startsWith("__")) continue;
    const full = join(dir, e.name);
    if (e.isFile) {
      const stem = routeFileStem(e.name, prefix);
      if (stem) await addRemixRoute(routesDir, full, stem, out);
    } else if (e.isDirectory && e.name.endsWith("+")) {
      await walkRoutesDir(routesDir, full, `${prefix}${e.name.slice(0, -1)}.`, out);
    } else if (e.isDirectory) {
      await addFolderRoute(routesDir, full, prefix + e.name, out);
    }
  }
}

/** The route stem a file under a `+` folder contributes (null: colocated, not a route). */
function routeFileStem(name: string, prefix: string): string | null {
  const m = name.match(/^(.+)\.(tsx|jsx|ts|js)$/);
  if (!m || NON_ROUTE.test(m[1])) return null;
  const stem = m[1] === "_layout" ? prefix.replace(/\.$/, "") : prefix + indexStem(m[1]);
  return stem === "" ? null : stem;
}

/** `index`/`_index` as the last stem segment marks the index route (both spellings). */
function indexStem(stem: string): string {
  return stem.replace(/(^|\.)index$/, "$1_index");
}

/**
 * A plain (non-`+`) route folder: `route.tsx` (v2) or `_layout.tsx` (flat-routes) is the
 * folder's own route, `index.tsx` its index route; anything else is colocated.
 */
async function addFolderRoute(
  routesDir: string,
  dir: string,
  stem: string,
  out: RemixRoute[],
): Promise<void> {
  const own = await firstExisting(dir, ROUTE_EXTS.flatMap((x) => [`route.${x}`, `_layout.${x}`]));
  if (own) await addRemixRoute(routesDir, join(dir, own), stem, out);
  const index = await firstExisting(dir, ROUTE_EXTS.flatMap((x) => [`index.${x}`, `_index.${x}`]));
  if (index) await addRemixRoute(routesDir, join(dir, index), `${stem}._index`, out);
  // Nested folders continue the dot-nesting (`users/$id/route.tsx` → `users.$id`); other
  // files in a route folder are colocated, not routes.
  for await (const e of Deno.readDir(dir)) {
    if (!e.isDirectory || e.name.startsWith(".") || e.name.startsWith("__")) continue;
    const full = join(dir, e.name);
    if (e.name.endsWith("+")) {
      await walkRoutesDir(routesDir, full, `${stem}.${e.name.slice(0, -1)}.`, out);
    } else {
      await addFolderRoute(routesDir, full, `${stem}.${e.name}`, out);
    }
  }
}

async function addRemixRoute(
  routesDir: string,
  file: string,
  stem: string,
  out: RemixRoute[],
): Promise<void> {
  const parsed = parseRemixStem(stem);
  const source = await Deno.readTextFile(file).catch(() => null);
  if (source === null) return;
  const relNoExt = relative(routesDir, file).replace(/\\/g, "/").replace(/\.[^.]+$/, "");
  out.push({ file, parsed, key: parsed.segments.join("/"), remixId: `routes/${relNoExt}`, source });
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Restructure the Remix app at `dir` in place to denext conventions backed by the
 * `denext/remix` runtime: relocate `app/routes/*` to `app/**\/page.tsx`+`layout.tsx`,
 * split each route into a client component (`page.client.tsx`) + a server data module
 * (`page.data.tsx`) wired by a generated wrapper, convert `app/root.tsx` to
 * `app/layout.tsx`, and delete `entry.{server,client}.*`. Reads every source first,
 * then writes, then removes the old tree. Returns the migration report.
 */
export async function transformRemixApp(dir: string): Promise<RemixMigrateInfo> {
  const appDir = join(dir, "app");
  const routesDir = join(appDir, "routes");
  const plan: RemixPlan = {
    appDir,
    planned: [],
    converted: new Map(),
    info: {
      routesConverted: 0,
      loaders: 0,
      actions: 0,
      rootConverted: false,
      entriesDeleted: [],
      warnings: [],
    },
  };
  const routes = (await exists(routesDir)) ? await collectRemixRoutes(routesDir) : [];
  const isLayout = layoutDetector(routes);
  const rootRel = await firstExisting(appDir, ROUTE_EXTS.map((x) => `root.${x}`));
  const rootSource = rootRel ? await Deno.readTextFile(join(appDir, rootRel)) : null;

  const converted: RemixRoute[] = [];
  for (const r of routes) {
    if (await planRoute(plan, r, isLayout(r))) converted.push(r);
  }
  if (rootSource !== null) await planRoot(plan, rootSource);

  // Colocated modules (`login.server.ts`, `__note-editor.tsx`, images…) move to the
  // private `app/_routes/` mirror; the generated modules' relative imports are re-based
  // to their new location (they moved too) before anything is written.
  const routeFiles = new Set(converted.map((r) => r.file));
  const colocatedDir = join(appDir, "_routes");
  const where: ImportRemap = {
    routesDir,
    colocatedDir,
    converted: plan.converted,
    aliases: await packageImportAliases(dir),
  };
  // The custom server's `getLoadContext` → `load-context.ts`; the server entry's startup
  // side effects (`init()`, `global.ENV = getEnv()`) outlive it as a denext
  // `instrumentation.ts` (`register()` runs them when the server boots; it also imports the
  // load context); the client entry's startup effects → `instrumentation-client.ts`.
  const loadContext = await planLoadContext(plan, dir);
  await planServerEntry(plan, dir, loadContext);
  await planClientEntry(plan, dir);
  for (const p of plan.planned) {
    if (p.srcDir) p.code = rebaseRelativeImports(p, where);
  }
  // Nothing destructive happens until every generated file is on disk: the old tree is
  // listed FIRST (a `readDir` that is being renamed under is allowed to skip entries), the
  // generated files are written, then the colocated modules move and the converted
  // originals go — so a failure part-way leaves the sources intact.
  const oldFiles = await listFiles(routesDir);
  const generated = new Set(plan.planned.map((p) => p.dest));
  for (const p of plan.planned) {
    await Deno.mkdir(dirnameOf(p.dest), { recursive: true });
    await Deno.writeTextFile(p.dest, p.code);
  }
  const moved = await relocateColocated(oldFiles, routesDir, colocatedDir, routeFiles, generated);
  if (moved > 0) {
    plan.info.warnings.push(
      `moved ${moved} colocated module(s) from app/routes/ to app/_routes/ (imports re-based)`,
    );
    await rewriteRoutesDirReferences(dir);
  }
  await removeOldTree(plan, routesDir, oldFiles, routeFiles, rootRel);
  // Every OTHER app module (colocated helpers, utils, components, the root) that imported a
  // route module — for a constant, a component, a type — is pointed at the generated module
  // that now holds it; imports of relocated colocated modules follow them to app/_routes/.
  const remapped = await remapImportsInTree(appDir, where);
  if (remapped > 0) {
    plan.info.warnings.push(`re-pointed route-module imports in ${remapped} module(s)`);
  }
  // Remap `@remix-run/*` (and react-router) imports in any REMAINING app source — the
  // shared modules a real app keeps outside `routes/` (sessions, utils, components). The
  // route transform only touches routes, and the alias map covers only the entry
  // specifiers, so an un-rewritten `import … from "@remix-run/node"` in app/sessions.ts
  // would otherwise fail to resolve at build.
  const rewritten = await rewriteRemixImportsInTree(appDir);
  if (rewritten > 0) {
    plan.info.warnings.push(
      `rewrote @remix-run/* imports in ${rewritten} shared module(s) outside routes/`,
    );
  }
  return plan.info;
}

/** The files to write, plus the report being assembled. */
interface RemixPlan {
  readonly appDir: string;
  /** Each generated file; `srcDir` is the ORIGINAL route module's directory (for relative imports). */
  readonly planned: Array<{ dest: string; code: string; srcDir?: string }>;
  /** Original route module path (no extension) → its generated client/data modules. */
  readonly converted: Map<string, ConvertedRoute>;
  readonly info: RemixMigrateInfo;
}

/** Where a converted route's exports now live (see {@link remapImportTarget}). */
interface ConvertedRoute {
  /** The `"use client"` module: the component, hooks, constants and exported types. */
  client?: string;
  /** The server data module: `loader`/`action`/`meta`/… */
  data?: string;
}

/**
 * A non-index route is a LAYOUT when a COMPONENT route nests under it — a resource route
 * (no default export) needs no `<Outlet/>`, and a child that breaks out of this segment
 * (trailing `_`) is a sibling page in denext terms, not nested content.
 */
function layoutDetector(routes: RemixRoute[]): (r: RemixRoute) => boolean {
  const pages = routes.filter((c) =>
    /export\s+default\b|export\s*\{[^}]*\bdefault\b/.test(c.source)
  );
  return (r) => {
    if (r.parsed.isIndex || r.key === "") return false;
    const prefix = r.key + "/";
    return pages.some((c) =>
      c.key !== r.key && c.key.startsWith(prefix) && !c.parsed.breakOuts.includes(r.key)
    );
  };
}

function countRoute(info: RemixMigrateInfo, parts: ModuleParts): void {
  info.routesConverted++;
  if (parts.hasLoader) info.loaders++;
  if (parts.hasAction) info.actions++;
}

/** A resource route (loader/action, no component) → a denext API route. */
function planResourceRoute(
  plan: RemixPlan,
  id: string,
  parts: ModuleParts,
  destDir: string,
  role: "page" | "layout",
  label: string,
) {
  const dataFile = `${role}.data.tsx`;
  plan.planned.push({ dest: join(destDir, dataFile), code: dataModuleSource(parts) });
  if (parts.clientStatements.length > 0 || parts.helpers.some((h) => h.exported)) {
    plan.planned.push({
      dest: join(destDir, `${role}.client.tsx`),
      code: clientModuleSource(parts, dataFile, role),
    });
  }
  plan.planned.push({
    dest: join(destDir, "route.ts"),
    code: resourceRouteSource(id, dataFile, parts),
  });
  plan.info.warnings.push(`${label}: resource route (no component) → generated a route.ts handler`);
  countRoute(plan.info, parts);
}

/** The v1 `CatchBoundary` guidance for a route that defines one. */
function catchBoundaryWarning(parts: ModuleParts, label: string): string {
  return parts.hasErrorBoundary
    ? `${label}: v1 CatchBoundary alongside ErrorBoundary — only ErrorBoundary is wired to ` +
      `error.tsx; fold the CatchBoundary into it using isRouteErrorResponse (Remix v2)`
    : `${label}: v1 CatchBoundary → error.tsx (via useCatch); consider migrating it to ` +
      `ErrorBoundary + isRouteErrorResponse (Remix v2)`;
}

/**
 * A component route: the client module, the server data module (when it has server
 * exports), the page/layout wrapper, a `route.ts` POST handler for a page with an `action`
 * (so a plain POST to its URL — cross-route `fetcher.submit`/`<Form action>`, the no-JS
 * post — runs the action; the page's GET is unaffected), and `error.tsx` for a boundary.
 */
function planComponentRoute(
  plan: RemixPlan,
  r: RemixRoute,
  parts: ModuleParts,
  layout: boolean,
  destDir: string,
  label: string,
): void {
  const role = layout ? "layout" : "page";
  const clientFile = `${role}.client.tsx`;
  const dataFile = `${role}.data.tsx`;
  const { planned, info } = plan;
  planned.push({
    dest: join(destDir, clientFile),
    code: clientModuleSource(parts, dataFile, role),
  });
  if (parts.serverStatements.length > 0) {
    planned.push({ dest: join(destDir, dataFile), code: dataModuleSource(parts) });
  }
  planned.push({
    dest: join(destDir, `${role}.tsx`),
    code: layout
      ? layoutWrapperSource(r.remixId, parts, clientFile, dataFile)
      : pageWrapperSource(r.remixId, parts, clientFile, dataFile),
  });
  if (!layout && parts.hasAction) {
    planned.push({ dest: join(destDir, "route.ts"), code: pageActionRouteSource(dataFile) });
  }
  if (parts.hasErrorBoundary || parts.hasCatchBoundary) {
    planned.push({ dest: join(destDir, "error.tsx"), code: errorWrapperSource(clientFile) });
  }
  if (parts.hasCatchBoundary) info.warnings.push(catchBoundaryWarning(parts, label));
  countRoute(info, parts);
  if (layout && !/<Outlet|children/.test(r.source)) {
    info.warnings.push(`${label}: layout renders no <Outlet/> — nested routes won't show`);
  }
}

/**
 * `base/…segments`, or null when a segment would escape `base` (`..`, a separator, an empty
 * segment — a hostile or malformed route filename must never write outside `app/`).
 */
function containedDir(base: string, segments: string[]): string | null {
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[\\/]/.test(s))) return null;
  const target = join(base, ...segments);
  const rel = relative(base, target);
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") ? null : target;
}

/** Give a head-only route module a component: `null` for a page, `<Outlet />` for a layout. */
function addPassthroughComponent(parts: ModuleParts, layout: boolean): void {
  if (layout) {
    parts.imports.push(`import { Outlet } from "@remix-run/react";`);
    parts.clientFree.add("Outlet");
  }
  parts.clientStatements.push(
    `export default function __RemixHeadOnly() {\n  return ${layout ? "<Outlet />" : "null"};\n}`,
  );
  parts.clientOrder.push(parts.cursor + 1);
  parts.hasDefault = true;
}

/** Plan one `app/routes/*` module's destination files. */
async function planRoute(plan: RemixPlan, r: RemixRoute, layout: boolean): Promise<boolean> {
  const parts = await analyzeModule(r.source);
  const label = r.parsed.segments.join("/") || "(index)";
  if (!parts.hasDefault && !parts.hasLoader && !parts.hasAction) {
    if (!parts.hasMeta && !parts.hasLinks && !parts.hasHandle) {
      // Nothing a router could serve (the Epic Stack's `_marketing+/tailwind-preset.ts`):
      // a colocated module that merely lives under routes/ — relocate it, don't route it.
      plan.info.warnings.push(
        `${label}: no loader/action/component — kept as a colocated module`,
      );
      return false;
    }
    // A head-only route (`meta`/`links`/`handle`, no component): Remix renders nothing for
    // it but its head contributions apply — give it a passthrough component.
    addPassthroughComponent(parts, layout);
    plan.info.warnings.push(`${label}: meta/links/handle-only route → passthrough component`);
  }
  for (const w of r.parsed.warnings) plan.info.warnings.push(`${label}: ${w}`);
  const destDir = containedDir(plan.appDir, r.parsed.segments);
  if (destDir === null) {
    plan.info.warnings.push(`${label}: skipped — its segments would write outside app/`);
    return false;
  }
  const first = plan.planned.length;
  if (!parts.hasDefault) {
    planResourceRoute(plan, r.remixId, parts, destDir, layout ? "layout" : "page", label);
  } else {
    planComponentRoute(plan, r, parts, layout, destDir, label);
  }
  // Every file generated for this route keeps the original module's directory, so its
  // relative imports can be re-based to where the file now lives.
  const generated = plan.planned.slice(first);
  for (const p of generated) p.srcDir = dirnameOf(r.file);
  plan.converted.set(r.file.replace(/\.[^./]+$/, ""), {
    client: generated.find((p) => p.dest.endsWith(".client.tsx"))?.dest,
    data: generated.find((p) => p.dest.endsWith(".data.tsx"))?.dest,
  });
  return true;
}

/**
 * Root → app/layout.tsx. A pure document-shell root becomes denext's SERVER document root
 * (single <html>); a root that needs client features goes through the boundary split.
 * Remix's root route id is `root` — apps key on it (`useRouteLoaderData("root")`).
 */
async function planRoot(plan: RemixPlan, rootSource: string): Promise<void> {
  const { appDir, planned, info } = plan;
  const parts = await analyzeModule(stripRootDoc(rootSource));
  if (!parts.hasDefault) return;
  if (rootNeedsClient(parts)) {
    planned.push({
      dest: join(appDir, "layout.client.tsx"),
      code: clientModuleSource(parts, "layout.data.tsx", "layout", true),
    });
    if (parts.serverStatements.length > 0) {
      planned.push({ dest: join(appDir, "layout.data.tsx"), code: dataModuleSource(parts) });
    }
    planned.push({
      dest: join(appDir, "layout.tsx"),
      code: layoutWrapperSource("root", parts, "layout.client.tsx", "layout.data.tsx"),
    });
  } else {
    planned.push({ dest: join(appDir, "layout.tsx"), code: serverRootLayoutSource(parts) });
  }
  info.rootConverted = true;
}

/** Statement kinds that DO something at module evaluation (not declarations/types/exports). */
const EFFECT_STATEMENTS = new Set([
  "ExpressionStatement",
  "IfStatement",
  "TryStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "SwitchStatement",
]);

/** What an entry file runs at startup: its imports, helper declarations and effect statements. */
interface EntryStartup {
  imports: string[];
  helpers: HelperDecl[];
  effects: Array<{ code: string; free: Set<string> }>;
}

/**
 * The startup pieces of `app/<base>.*` (`entry.server`/`entry.client`), or null when the
 * file is absent. Effect statements whose free identifiers hit `drop` are left out — the
 * Remix rendering/hydration calls denext replaces.
 */
async function entryStartup(
  plan: RemixPlan,
  base: string,
  drop: Set<string>,
): Promise<EntryStartup | null> {
  const rel = await firstExisting(plan.appDir, ROUTE_EXTS.map((x) => `${base}.${x}`));
  if (!rel) return null;
  const source = await Deno.readTextFile(join(plan.appDir, rel)).catch(() => null);
  const parsed = source === null ? null : await parseRouteModule(source);
  if (!parsed) return null;
  const out: EntryStartup = { imports: [], helpers: [], effects: [] };
  parsed.items.forEach((item, index) => {
    const code = txt(parsed.ctx, item);
    if (item.type === "ImportDeclaration") out.imports.push(code);
    else if (EFFECT_STATEMENTS.has(item.type as string)) {
      const free = freeIdentifiers(item);
      if (![...free].some((id) => drop.has(id))) out.effects.push({ code, free });
    } else if (!String(item.type).startsWith("Export") && !isTypeDecl(item)) {
      out.helpers.push({
        code,
        names: declaredNames(item),
        free: freeIdentifiers(item),
        typeOnly: new Set(),
        index,
      });
    }
  });
  return out;
}

/** The effects + the helpers they need, in order, and the imports that survive. */
function startupBody(entry: EntryStartup): { body: string; imports: string[] } {
  const seed = new Set(entry.effects.flatMap((e) => [...e.free]));
  const needed = selectHelperDecls(entry.helpers, seed);
  const referenced = referencedIds(seed, needed);
  const statements = [...needed.map((h) => h.code), ...entry.effects.map((e) => e.code)]
    .map((s) => s.trim());
  const body = statements.join("\n");
  const imports = usedImports(entry.imports, body, referenced)
    .map((s) => rewriteRemixImports(s).trim());
  return { body, imports };
}

/**
 * `app/entry.server.tsx` → `instrumentation.ts`. Remix's server entry mixes two things: the
 * rendering hooks (`handleRequest`/`handleError`, which denext replaces) and whatever the
 * app runs at startup (`init()`, `global.ENV = getEnv()`, a monitoring import). The latter
 * would silently vanish with the file, so they become denext's `register()` — top-level
 * effect statements in order, with the declarations and imports they reference. The
 * generated `load-context.ts` (when any) is imported here too, so the server registers the
 * app's load context at boot.
 */
async function planServerEntry(plan: RemixPlan, dir: string, loadContext: boolean): Promise<void> {
  const entry = await entryStartup(plan, "entry.server", new Set());
  const effects = entry?.effects.length ?? 0;
  if (effects === 0 && !loadContext) return;
  const dest = join(dir, "instrumentation.ts");
  if (await exists(dest)) {
    plan.info.warnings.push(
      "entry.server: startup side effects NOT moved — instrumentation.ts already exists; merge by hand" +
        (loadContext ? ' (and add `import "./load-context.ts"` to it)' : ""),
    );
    return;
  }
  const { body, imports } = entry ? startupBody(entry) : { body: "", imports: [] };
  const lines = [
    ...(loadContext ? [`import "./load-context.ts";`] : []),
    ...imports,
  ];
  const why = effects > 0
    ? "// The startup side effects of app/entry.server.tsx (its `handleRequest`/`handleError`\n" +
      "// were Remix's rendering hooks — denext renders). `register()` runs once when the server boots."
    : "// Registers the app's load context (`load-context.ts`) when the server boots.";
  const signature = /\bawait\b/.test(body)
    ? "export async function register(): Promise<void>"
    : "export function register(): void";
  const code = `${GEN_HEADER}${why}\n${lines.join("\n")}\n\n${signature} {\n${
    indent(body, "  ")
  }}\n`;
  plan.planned.push({ dest, code, srcDir: plan.appDir });
  if (effects > 0) {
    plan.info.warnings.push(
      `entry.server: ${effects} startup statement(s) moved to instrumentation.ts (register())`,
    );
  }
}

function indent(body: string, by: string): string {
  return body === "" ? "" : body.split("\n").map((l) => (l === "" ? l : by + l)).join("\n") + "\n";
}

/** The identifiers of Remix's own hydration — statements that reference them are dropped. */
const HYDRATION_IDS = new Set(["hydrateRoot", "hydrate", "RemixBrowser", "HydratedRouter"]);

/**
 * `app/entry.client.tsx` → `instrumentation-client.ts`. The entry's `hydrateRoot(document,
 * <RemixBrowser />)` is Remix's hydration (denext hydrates), but a startup effect it also
 * ran in the browser (the Epic Stack's conditional Sentry `import("./utils/monitoring.client")`)
 * would vanish with the file — it becomes denext's `instrumentation-client.ts`, which runs
 * before the app's client code like Next's.
 */
async function planClientEntry(plan: RemixPlan, dir: string): Promise<void> {
  const entry = await entryStartup(plan, "entry.client", HYDRATION_IDS);
  if (!entry || entry.effects.length === 0) return;
  const { body, imports } = startupBody(entry);
  const ext = /<[A-Za-z]/.test(body) ? "tsx" : "ts";
  const dest = join(dir, `instrumentation-client.${ext}`);
  if (await exists(dest)) {
    plan.info.warnings.push(
      "entry.client: startup side effects NOT moved — instrumentation-client already exists; merge by hand",
    );
    return;
  }
  const code =
    `${GEN_HEADER}// The startup side effects of app/entry.client.tsx (its Remix hydration call is dropped —
// denext hydrates). Runs in the browser before the app's client code, like Next's
// \`instrumentation-client.ts\`.
${imports.length > 0 ? imports.join("\n") + "\n\n" : ""}${body}
`;
  plan.planned.push({ dest, code, srcDir: plan.appDir });
  plan.info.warnings.push(
    `entry.client: ${entry.effects.length} startup statement(s) moved to instrumentation-client.${ext}`,
  );
}

// ── The custom server's `getLoadContext` → `load-context.ts` ─────────────────

/** Where a Remix app's custom server (Express/Hono) lives, most common first. */
const SERVER_ENTRIES = [
  "server/index.ts",
  "server/index.js",
  "server/index.mjs",
  "server.ts",
  "server.js",
  "server.mjs",
  "server/app.ts",
  "server/app.js",
];

/** A `getLoadContext` key with a denext-side equivalent: the expression + why. */
const LOAD_CONTEXT_KEYS: Record<string, { expr: string; note: string; lazy?: true }> = {
  // A getter: the O(routes) synthesize runs only when a loader reads it, and a rejection
  // surfaces where it is awaited instead of as an unhandled promise per request.
  serverBuild: {
    expr: "remixServerBuild()",
    note: "the Remix-shaped route manifest (`.routes`) — what remix-seo's sitemap reads",
    lazy: true,
  },
  build: {
    expr: "remixServerBuild()",
    note: "the Remix-shaped route manifest (`.routes`) — what remix-seo's sitemap reads",
    lazy: true,
  },
  cspNonce: {
    expr: "undefined",
    note: "denext's CSP is hash-based — there is no per-request nonce",
  },
  nonce: {
    expr: "undefined",
    note: "denext's CSP is hash-based — there is no per-request nonce",
  },
};

/** One key of the object `getLoadContext` returns, with the source text of its value. */
interface LoadContextKey {
  name: string;
  source: string;
  spread?: boolean;
}

/** The name of a property key node (identifier or string), or null when computed. */
function propertyKeyName(key: Node): string | null {
  if (!key) return null;
  if (key.type === "Identifier" || key.type === "StringLiteral") return key.value as string;
  return null;
}

/** The function node bound to `getLoadContext` (an object property, a const, a declaration). */
function findLoadContextFn(items: Node[]): Node | null {
  let found: Node | null = null;
  for (const item of items) {
    walkAst(item, (n) => {
      if (found) return;
      if (n.type === "KeyValueProperty" && propertyKeyName(n.key) === "getLoadContext") {
        found = n.value;
      } else if (n.type === "MethodProperty" && propertyKeyName(n.key) === "getLoadContext") {
        found = n;
      } else if (n.type === "VariableDeclarator" && n.id?.value === "getLoadContext" && n.init) {
        found = n.init;
      } else if (n.type === "FunctionDeclaration" && n.identifier?.value === "getLoadContext") {
        found = n;
      }
    });
    if (found) break;
  }
  return found;
}

/** The object literal a function returns (an arrow's expression body or a `return {…}`). */
function returnedObject(fn: Node): Node | null {
  const body = fn.type === "MethodProperty" ? fn.function?.body : fn.body;
  if (!body) return null;
  const unwrap = (
    n: Node,
  ): Node => (n?.type === "ParenthesisExpression" ? unwrap(n.expression) : n);
  const direct = unwrap(body);
  if (direct?.type === "ObjectExpression") return direct;
  let ret: Node | null = null;
  walkAst(body, (n) => {
    if (!ret && n.type === "ReturnStatement" && unwrap(n.argument)?.type === "ObjectExpression") {
      ret = unwrap(n.argument);
    }
  });
  return ret;
}

/** The keys of an object literal, with each value's source text. */
function objectKeys(ctx: Ctx, obj: Node): LoadContextKey[] {
  const keys: LoadContextKey[] = [];
  for (const p of obj.properties ?? []) {
    if (p.type === "Identifier") keys.push({ name: p.value, source: p.value });
    else if (p.type === "SpreadElement") {
      keys.push({ name: "...", source: txt(ctx, p.arguments), spread: true });
    } else {
      const name = propertyKeyName(p.key);
      if (name) keys.push({ name, source: p.value ? txt(ctx, p.value) : "<method>" });
    }
  }
  return keys;
}

/** One generated property of `load-context.ts` for a `getLoadContext` key. */
function loadContextProperty(key: LoadContextKey): string {
  if (key.spread) {
    return `  // TODO: was \`...${key.source}\` — spread its fields here\n`;
  }
  const known = LOAD_CONTEXT_KEYS[key.name];
  const name = /^[A-Za-z_$][\w$]*$/.test(key.name) ? key.name : JSON.stringify(key.name);
  if (known?.lazy) {
    return `  // was: ${key.source} — ${known.note}\n  get ${name}() {\n    return ${known.expr};\n  },\n`;
  }
  if (known) return `  // was: ${key.source} — ${known.note}\n  ${name}: ${known.expr},\n`;
  return `  // TODO: was \`${key.source}\` — provide it here\n  ${name}: undefined,\n`;
}

/**
 * The custom server's `getLoadContext` → `load-context.ts`. A Remix server hands every
 * loader/action a `context` (the Epic Stack: `{ cspNonce, serverBuild }`); denext replaces
 * that server, so the returned object's keys are re-created in a `defineLoadContext` module:
 * keys with a denext equivalent are wired (`serverBuild` → `remixServerBuild()`), the rest
 * are stubs to fill in. Returns whether the module was planned.
 */
async function planLoadContext(plan: RemixPlan, dir: string): Promise<boolean> {
  const rel = await firstExisting(dir, SERVER_ENTRIES);
  if (!rel) return false;
  const source = await Deno.readTextFile(join(dir, rel)).catch(() => null);
  if (source === null || !source.includes("getLoadContext")) return false;
  const parsed = await parseRouteModule(source);
  const fn = parsed ? findLoadContextFn(parsed.items) : null;
  if (!fn) return false;
  const dest = join(dir, "load-context.ts");
  if (await exists(dest)) {
    plan.info.warnings.push(`${rel}: getLoadContext NOT ported — load-context.ts already exists`);
    return false;
  }
  const obj = returnedObject(fn);
  const keys = obj ? objectKeys(parsed!.ctx, obj) : null;
  const props = keys?.map(loadContextProperty).join("") ??
    `  // TODO: could not read the object getLoadContext returns — port it from ${rel} by hand\n`;
  const usesBuild = props.includes("remixServerBuild()");
  const runtime = usesBuild ? "defineLoadContext, remixServerBuild" : "defineLoadContext";
  const code =
    `${GEN_HEADER}// What ${rel}'s \`getLoadContext\` gave every loader/action as \`context\`. denext replaced
// that server, so each value is re-derived here: keys with a denext equivalent are wired,
// the rest are stubs — fill them in from what the server computed.
import { ${runtime} } from "denext/remix/server";

export default defineLoadContext(() => ({
${props}}));
`;
  plan.planned.push({ dest, code });
  const summary = keys
    ? keys.map((k) => {
      const known = LOAD_CONTEXT_KEYS[k.name];
      return `${k.spread ? "..." + k.source : k.name} → ${known ? known.expr : "TODO"}`;
    }).join(", ")
    : "TODO";
  plan.info.warnings.push(`${rel}: getLoadContext → load-context.ts (${summary})`);
  return true;
}

/**
 * Delete the converted route modules (from the pre-collected listing — never a blind
 * recursive remove, which would also take a generated file that happens to live under
 * `app/routes/`), prune the directories they leave empty, and drop the root module and the
 * `entry.{server,client}.*` files.
 */
async function removeOldTree(
  plan: RemixPlan,
  routesDir: string,
  oldFiles: string[],
  routeFiles: Set<string>,
  rootRel: string | null,
): Promise<void> {
  const { appDir, info } = plan;
  for (const file of oldFiles) {
    if (routeFiles.has(file)) await Deno.remove(file).catch(() => {});
  }
  await pruneEmptyDirs(routesDir);
  if (rootRel) await Deno.remove(join(appDir, rootRel)).catch(() => {});
  for (const ext of ROUTE_EXTS) {
    for (const base of ["entry.server", "entry.client"]) {
      const p = join(appDir, `${base}.${ext}`);
      if (!(await exists(p))) continue;
      await Deno.remove(p).catch(() => {});
      info.entriesDeleted.push(`app/${base}.${ext}`);
    }
  }
}

/**
 * Move every non-route file under `app/routes/` (colocated server helpers, components,
 * assets) to the same relative path under `app/_routes/` — a private folder the denext
 * scanner ignores — so the route modules that moved can keep importing them. Returns the
 * number of files moved.
 */
async function relocateColocated(
  oldFiles: string[],
  routesDir: string,
  colocatedDir: string,
  routeFiles: Set<string>,
  generated: Set<string>,
): Promise<number> {
  let moved = 0;
  for (const file of oldFiles) {
    // Converted routes are removed later; a generated file that landed under `app/routes/`
    // (a route literally named `routes`) is not colocated.
    if (routeFiles.has(file) || generated.has(file)) continue;
    const dest = join(colocatedDir, relative(routesDir, file));
    await Deno.mkdir(dirnameOf(dest), { recursive: true });
    await Deno.rename(file, dest);
    moved++;
  }
  return moved;
}

/** Every file under `dir` (recursive), fully listed before the caller mutates the tree. */
async function listFiles(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const out: string[] = [];
  for await (const f of walkFiles(dir)) out.push(f);
  return out.sort();
}

/** Remove `dir` and its now-empty subdirectories (bottom-up); non-empty ones are kept. */
async function pruneEmptyDirs(dir: string): Promise<boolean> {
  let empty = true;
  try {
    for await (const e of Deno.readDir(dir)) {
      const full = join(dir, e.name);
      if (!(e.isDirectory && await pruneEmptyDirs(full))) empty = false;
    }
  } catch {
    return true; // already gone
  }
  if (empty) await Deno.remove(dir).catch(() => {});
  return empty;
}

/** What the import remapper needs to know about the converted tree. */
interface ImportRemap {
  routesDir: string;
  colocatedDir: string;
  converted: Map<string, ConvertedRoute>;
  /** Node subpath-import aliases from package.json (`#app/` → absolute dir). */
  aliases: Array<[prefix: string, dir: string]>;
}

/** Node subpath imports (`"imports": { "#app/*": "./app/*" }`) as prefix → absolute dir pairs. */
async function packageImportAliases(dir: string): Promise<Array<[string, string]>> {
  const pkg = await Deno.readTextFile(join(dir, "package.json")).catch(() => null);
  if (!pkg) return [];
  let imports: Record<string, unknown> = {};
  try {
    imports = (JSON.parse(pkg) as { imports?: Record<string, unknown> }).imports ?? {};
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(imports)) {
    if (typeof value !== "string" || !key.endsWith("/*") || !value.endsWith("/*")) continue;
    out.push([key.slice(0, -1), join(dir, value.slice(0, -1))]);
  }
  return out;
}

/** Where a path under `app/routes/` now lives (its `app/_routes/` mirror), else itself. */
function relocatedPath(target: string, where: ImportRemap): string {
  const rel = relative(where.routesDir, target);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return inside ? join(where.colocatedDir, rel) : target;
}

/**
 * The module an import of `target` (an absolute path, extension optional) should point at
 * now: a converted ROUTE module's generated data module when every imported name is a server
 * export (`loader`/`action`/…), else its client module (components, hooks, constants, types
 * — a type-only import of a `"use client"` module is erased at build); a relocated
 * colocated module's `app/_routes/` mirror; or `target` itself.
 */
function remapImportTarget(target: string, names: string[], where: ImportRemap): string {
  // A relocated colocated module still imports its former siblings by the OLD relative
  // path, so a target under app/_routes/ is looked up as the app/routes/ module it named.
  const relMirror = relative(where.colocatedDir, target);
  const original = relMirror !== "" && !relMirror.startsWith("..") && !isAbsolute(relMirror)
    ? join(where.routesDir, relMirror)
    : target;
  const route = where.converted.get(original.replace(/\.(?:tsx?|jsx?)$/, ""));
  if (route) {
    const serverOnly = names.length > 0 && names.every((n) => SERVER_EXPORTS.has(n));
    return (serverOnly && route.data) ? route.data : (route.client ?? route.data ?? target);
  }
  return relocatedPath(target, where);
}

/** A relative specifier from `fromDir` to `target` (`./`-prefixed, forward slashes). */
function relativeSpecifier(fromDir: string, target: string): string {
  const next = relative(fromDir, target).replace(/\\/g, "/");
  return next.startsWith(".") ? next : `./${next}`;
}

/** The binding names an import/export-from clause asks for (`default`, `*`, or the named ones). */
function importedNames(clause: string): string[] {
  const names: string[] = [];
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const m = part.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)/);
      if (m) names.push(m[1]);
    }
  }
  const head = clause.replace(/\{[^}]*\}/, "").replace(/\bfrom\s*$/, "")
    .replace(/^\s*(?:import|export)\s+(?:type\s+)?/, "");
  if (/\*\s*as\s+/.test(head)) names.push("*");
  else if (/^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(head.trim())) names.push("default");
  return names;
}

/**
 * Rewrite every import/export specifier in `code` through `map(spec, names)` (a `null`
 * result leaves it alone). Covers `import … from`, `export … from`, side-effect imports and
 * dynamic `import()`.
 */
function rewriteSpecifiers(
  code: string,
  map: (spec: string, names: string[]) => string | null,
): string {
  return code.replace(
    /(\b(?:import|export)\b[^;'"]*?\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\2/g,
    (whole, lead: string, quote: string, spec: string) => {
      const next = map(spec, lead.includes("from") ? importedNames(lead) : []);
      return next === null ? whole : `${lead}${quote}${next}${quote}`;
    },
  );
}

/** Resolve a relative or subpath-aliased specifier against `fromDir`; null for bare specifiers. */
function resolveSpecifier(spec: string, fromDir: string, where: ImportRemap): string | null {
  if (spec.startsWith("./") || spec.startsWith("../")) return join(fromDir, spec);
  for (const [prefix, dir] of where.aliases) {
    if (spec.startsWith(prefix)) return join(dir, spec.slice(prefix.length));
  }
  return null;
}

/**
 * Re-base a generated module's relative import specifiers: the route module moved from
 * `srcDir` to the generated file's directory, anything it imported from under `app/routes/`
 * moved to `app/_routes/`, and a sibling ROUTE module it imported now lives in that route's
 * generated client/data module (see {@link remapImportTarget}).
 */
function rebaseRelativeImports(
  planned: { dest: string; code: string; srcDir?: string },
  where: ImportRemap,
): string {
  const srcDir = planned.srcDir!;
  const destDir = dirnameOf(planned.dest);
  return rewriteSpecifiers(planned.code, (spec, names) => {
    // The wrapper's own generated siblings (`./page.data.tsx`, `./layout.client.tsx`) are
    // relative to the DESTINATION already; bare specifiers are not paths.
    if (GENERATED_SIBLING.test(spec) || !spec.startsWith(".")) return null;
    return relativeSpecifier(destDir, remapImportTarget(join(srcDir, spec), names, where));
  });
}

/**
 * Point every app module's imports of route modules (a constant, a component, a type
 * imported from `#app/routes/x.tsx`) at the generated module that holds them, and follow
 * relocated colocated modules to `app/_routes/`. Returns the number of files changed.
 */
async function remapImportsInTree(appDir: string, where: ImportRemap): Promise<number> {
  let count = 0;
  for await (const file of walkFiles(appDir)) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const src = await Deno.readTextFile(file).catch(() => null);
    if (src === null) continue;
    const fromDir = dirnameOf(file);
    const out = rewriteSpecifiers(src, (spec, names) => {
      const target = resolveSpecifier(spec, fromDir, where);
      if (target === null) return null;
      const mapped = remapImportTarget(target, names, where);
      return mapped === target ? null : relativeSpecifier(fromDir, mapped);
    });
    if (out !== src) {
      await Deno.writeTextFile(file, out);
      count++;
    }
  }
  return count;
}

/** The generated per-route files a wrapper imports by relative name. */
const GENERATED_SIBLING = /^\.\/(?:(?:page|layout)\.(?:data\.tsx|client\.tsx)|load-context\.ts)$/;

/** Root config files that name `app/routes/` literally (the Epic Stack's Tailwind preset). */
async function rewriteRoutesDirReferences(dir: string): Promise<void> {
  for (
    const name of [
      "tailwind.config.ts",
      "tailwind.config.js",
      "tailwind.config.mjs",
      "tailwind.config.cjs",
    ]
  ) {
    const file = join(dir, name);
    if (!(await exists(file))) continue;
    const src = await Deno.readTextFile(file);
    const next = src.replaceAll("app/routes/", "app/_routes/");
    if (next !== src) await Deno.writeTextFile(file, next);
  }
}

/** Recursively yield every file path under `dir`. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) yield* walkFiles(full);
    else if (entry.isFile) yield full;
  }
}

/**
 * Rewrite `@remix-run/*` / react-router import specifiers to the denext runtime across
 * every `.ts`/`.tsx`/`.js`/`.jsx` module under `appDir` (the generated route files
 * already use denext specifiers, so they pass through unchanged). Returns how many
 * files were modified.
 */
async function rewriteRemixImportsInTree(appDir: string): Promise<number> {
  let count = 0;
  for await (const file of walkFiles(appDir)) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const src = await Deno.readTextFile(file).catch(() => null);
    if (src === null || (!src.includes("@remix-run/") && !src.includes("react-router"))) continue;
    const out = rewriteRemixImports(src);
    if (out !== src) {
      await Deno.writeTextFile(file, out);
      count++;
    }
  }
  return count;
}

/**
 * Strip Remix's document components from a root module (denext owns the document). The
 * root's `<Outlet/>` is kept — it maps to the runtime `<Outlet>` and the generated layout
 * boundary threads the nested-route subtree to it via `OutletProvider`, exactly like any
 * other layout.
 */
function stripRootDoc(src: string): string {
  return src.replace(/<(Meta|Links|Scripts|ScrollRestoration|LiveReload)\b[^>]*\/>\s*/g, "");
}

// ── Small path/fs helpers (kept local to avoid widening migrate.ts's surface) ──

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? "." : p.slice(0, i);
}
