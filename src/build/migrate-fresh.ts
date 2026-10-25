// `denext migrate` for a Fresh app (Fresh 2 — `jsr:@fresh/core`, on Vite or Fresh's own builder —
// and Fresh 1.x — `$fresh/`, `fresh.gen.ts`).
//
// The route modules keep their Fresh shape and stay where they are (`routes/`, `islands/`,
// `components/`): code reading files relative to `import.meta.url` keeps working, and nothing in
// them is rewritten but Vite's `import.meta.env` (and an island's inlined `FRESH_PUBLIC_*` read),
// which point at `denext/fresh/env`. The migration generates the denext side around them —
//   • `app/`: a `page.tsx` per page route, a `route.ts` per handler-only route, a `layout.tsx`
//     per `_layout` (and the root one for `_app` and `main.ts`'s app wrapper and layouts),
//     `not-found.tsx` for `_404` / `_error` / `app.notFound()`, the page `main.ts`'s code-
//     registered pages render at, and `app/_fresh/` (the app's `fresh/runtime`, whose `<Partial>`
//     is a client component) when the app uses Partials;
//   • `middleware.ts`: `main.ts`'s middleware, handlers, code routes and error handlers, the
//     `_middleware` files and each page route's handler, run as Fresh runs them
//     (`denext/fresh/server`);
// — marks each island `"use client"`, moves `static/` to `public/`, carries the stylesheets
// `client.ts` imported (and Tailwind) into the root layout, removes Fresh's own entry files
// (`fresh.gen.ts`, `dev.ts`, a 1.x `main.ts`, `vite.config.ts`, `client.ts`), and maps `fresh`,
// `$fresh/*`, `preact`, `preact/*` and `@preact/signals*` to denext in `deno.json`.
//
// What has no denext equivalent is reported, not silently dropped (`migrate --check`).

import { basename, dirname, extname, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { DENEXT_EXCLUDE } from "./dep-age.ts";
import { exists } from "./migrate-fs.ts";
import { isPreactPackage, PREACT_SOURCE_RULES, preactAliasImports } from "./preact-layer.ts";
import { mfs } from "./migrate-io.ts";
import {
  APP_ROUTE_FOLDER,
  appFolder,
  appRoutePageSource,
  bareRootLayoutSource,
  fileKind,
  folderUrl,
  FRESH_GEN_HEADER,
  FRESH_PARTIAL_SHIM,
  FRESH_RUNTIME_SHIM,
  type FreshFile,
  freshPattern,
  importPath,
  internalFolder,
  isUnder,
  layoutSource,
  type MiddlewareRouteSpec,
  middlewareSource,
  notFoundSource,
  pageSource,
  routeHandlerSource,
} from "./fresh-codegen.ts";

/** Something the migration leaves to the user. */
export interface FreshFinding {
  /** What it concerns: a file, an API. */
  item: string;
  /** Why, and what to do. */
  reason: string;
}

/** What `denext migrate` did to a Fresh app. */
export interface FreshMigrateInfo {
  /** The Fresh major version. */
  version: 1 | 2;
  /** Page routes (a `page.tsx` under `app/` each). */
  pages: number;
  /** Handler-only routes (a `route.ts` under `app/` each, or answered by the middleware). */
  handlers: number;
  /** `_layout` files (and `_app`). */
  layouts: number;
  /** `_middleware` files. */
  middlewares: number;
  /** Islands marked `"use client"`. */
  islands: number;
  /** The Tailwind input / output the generated `denext.config.ts` carries, when the app uses it. */
  tailwind: { input: string; output: string } | null;
  /** What does not migrate, and why. */
  wontMigrate: FreshFinding[];
  /** What migrates but needs a look. */
  review: FreshFinding[];
  /**
   * Import-map entries that replace the default Fresh aliases: `fresh/runtime` (and its other
   * spellings) pointed at the app's `app/_fresh/runtime.ts` when the app uses Partials.
   */
  importOverrides: Record<string, string>;
}

/** The Fresh app `dir` holds, or null. */
export interface FreshDetection {
  /** The Fresh major version. */
  version: 1 | 2;
  /** The project's `deno.json` / `deno.jsonc` (absolute), when it has one. */
  configPath: string | null;
  /** Its parsed contents. */
  config: Record<string, unknown>;
}

const CONFIG_NAMES = ["deno.json", "deno.jsonc"];
const ROUTE_EXTS = new Set([".tsx", ".jsx", ".ts", ".js"]);
/** Fresh's default ignore pattern: test files next to the routes. */
const TEST_FILE = /[._]test\.[tj]sx?$/;

/** The app's Deno config: the first of `deno.json` / `deno.jsonc`, parsed. */
async function readDenoConfig(
  dir: string,
): Promise<{ path: string | null; config: Record<string, unknown> }> {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name);
    const text = await mfs.readTextFile(path).catch(() => null);
    if (text === null) continue;
    try {
      return { path, config: (parseJsonc(text) ?? {}) as Record<string, unknown> };
    } catch {
      return { path, config: {} };
    }
  }
  return { path: null, config: {} };
}

/** The import map of a Deno config (`imports`). */
function importsOf(config: Record<string, unknown>): Record<string, string> {
  const imports = config.imports;
  return imports && typeof imports === "object" ? imports as Record<string, string> : {};
}

/** The Fresh major version an import map / tree points at, or null for no Fresh. */
function versionFrom(imports: Record<string, string>, hasGen: boolean): 1 | 2 | null {
  if ("$fresh/" in imports || hasGen) return 1;
  const fresh = imports["fresh"] ?? imports["@fresh/core"];
  if (fresh === undefined) return null;
  return /deno\.land\/x\/fresh@1|fresh@1\./.test(fresh) ? 1 : 2;
}

/**
 * Whether `dir` holds a Fresh app, and which version: a `deno.json` mapping `fresh` /
 * `@fresh/core` (Fresh 2) or `$fresh/` (1.x), or a `fresh.gen.ts` manifest — with a `routes/`
 * directory.
 *
 * @param dir The app directory.
 * @returns The detection, or null for anything else.
 */
export async function detectFresh(dir: string): Promise<FreshDetection | null> {
  if (!(await exists(join(dir, "routes")))) return null;
  const { path, config } = await readDenoConfig(dir);
  const version = versionFrom(importsOf(config), await exists(join(dir, "fresh.gen.ts")));
  return version === null ? null : { version, configPath: path, config };
}

// ── Scanning ─────────────────────────────────────────────────────────────────

/** Every file under `abs` (relative, `/`-separated), skipping `node_modules`. */
async function walk(abs: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of mfs.readDir(abs)) entries.push(e);
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory && e.name !== "node_modules") out.push(...await walk(join(abs, e.name), r));
    else if (e.isFile) out.push(r);
  }
  return out;
}

/** The routes tree: its files by kind, and the islands kept in `(_islands)` folders. */
interface RoutesScan {
  files: FreshFile[];
  localIslands: string[];
}

/** Scan `routes/` as Fresh does: `(_x)` folders are not routes (`(_islands)` holds islands). */
async function scanRoutes(dir: string): Promise<RoutesScan> {
  const files: FreshFile[] = [];
  const localIslands: string[] = [];
  for (const rel of await walk(join(dir, "routes"))) {
    const ext = extname(rel);
    if (!ROUTE_EXTS.has(ext) || TEST_FILE.test(rel)) continue;
    const segments = rel.split("/");
    const hidden = segments.slice(0, -1).find((s) => /^\(_.+\)$/.test(s));
    if (hidden) {
      if (hidden === "(_islands)") localIslands.push(`routes/${rel}`);
      continue;
    }
    const id = rel.slice(0, -ext.length);
    const base = basename(id);
    const dirPart = segments.slice(0, -1).join("/");
    const source = await mfs.readTextFile(join(dir, "routes", rel));
    files.push({ id, path: `routes/${rel}`, kind: fileKind(base), dir: dirPart, source });
  }
  return { files, localIslands };
}

// ── Source facts ─────────────────────────────────────────────────────────────

/** Whether a module has a default export. */
function hasDefault(source: string): boolean {
  return /\bexport\s+default\b/.test(source) || /\bexport\s*\{[^}]*\bas\s+default\b/.test(source);
}

/** A literal `routeOverride` in a route's `config`, or null. */
function routeOverride(source: string): string | null {
  return /\brouteOverride\s*:\s*(["'`])([^"'`]+)\1/.exec(source)?.[2] ?? null;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * The methods a handler-only route answers: the keys its handler object names, or every method
 * for a single handler function (or when they cannot be read).
 */
function handlerMethods(source: string): string[] {
  const named = METHODS.filter((m) =>
    new RegExp(`(?:^|[\\s,{])(?:async\\s+)?${m}\\s*(?:\\(|:)`).test(source)
  );
  return named.length > 0 ? named : METHODS.filter((m) => m !== "HEAD");
}

/**
 * A specificity key per path segment, for Fresh's match order: a static segment before a
 * partial one before a parameter; a segment that may be empty (a catch-all, an optional
 * parameter) after the path ending there (`/docs` before `/docs/:slug*`).
 */
function segmentScore(segment: string): number {
  if (segment.startsWith(":") && segment.endsWith("*")) return -3;
  if (segment.startsWith("{")) return -2;
  if (segment.startsWith(":")) return 2;
  if (segment.includes(":")) return 3;
  return 4;
}

/** Order routes as Fresh matches them: more specific segments first. */
function byMatchOrder(a: { pattern: string }, b: { pattern: string }): number {
  const sa = a.pattern.split("/").filter(Boolean).map(segmentScore);
  const sb = b.pattern.split("/").filter(Boolean).map(segmentScore);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    // A path that ends here sorts between a real segment and one that may be empty.
    const x = sa[i] ?? -1;
    const y = sb[i] ?? -1;
    if (x !== y) return y - x;
  }
  return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
}

export { byMatchOrder as freshMatchOrder, handlerMethods as freshHandlerMethods };

// ── The plan ─────────────────────────────────────────────────────────────────

/** The routes tree, sorted into Fresh's roles. */
interface Roles {
  app: FreshFile | null;
  rootLayout: FreshFile | null;
  layouts: FreshFile[];
  middlewares: FreshFile[];
  notFound: FreshFile | null;
  errors: FreshFile[];
  routes: FreshFile[];
}

/** Sort the routes tree's files into their roles (`_app` / `_404` count at the root only). */
function rolesOf(files: FreshFile[], findings: FreshFinding[]): Roles {
  const roles: Roles = {
    app: null,
    rootLayout: null,
    layouts: [],
    middlewares: [],
    notFound: null,
    errors: [],
    routes: [],
  };
  for (const f of files) {
    if (f.kind === "route") roles.routes.push(f);
    else if (f.kind === "middleware") roles.middlewares.push(f);
    else if (f.kind === "error") roles.errors.push(f);
    else if (f.kind === "layout") {
      roles.layouts.push(f);
      if (f.dir === "") roles.rootLayout = f;
    } else if (f.dir !== "") {
      findings.push({
        item: f.path,
        reason: `Fresh reads ${basename(f.id)} at the routes root only`,
      });
    } else if (f.kind === "app") roles.app = f;
    else roles.notFound = f;
  }
  const depth = (f: FreshFile) => f.dir === "" ? 0 : f.dir.split("/").length;
  roles.middlewares.sort((a, b) => depth(a) - depth(b));
  roles.layouts.sort((a, b) => depth(a) - depth(b));
  return roles;
}

/** The nearest `_error` / `_500` file above (or beside) `dir`. */
function nearestError(errors: FreshFile[], dir: string): FreshFile | null {
  let best: FreshFile | null = null;
  for (const e of errors) {
    if (isUnder(dir, e.dir) && (!best || e.dir.length > best.dir.length)) best = e;
  }
  return best;
}

/** One file the migration generates under `app/` (or the root). */
interface GenFile {
  path: string;
  source: string;
}

/** The working state of one migration run. */
interface Plan {
  dir: string;
  v1: boolean;
  /** The Fresh 2 `main.ts` (absolute), once known. */
  main: string | null;
  roles: Roles;
  gen: GenFile[];
  mwRoutes: MiddlewareRouteSpec[];
  wont: FreshFinding[];
  review: FreshFinding[];
  pages: number;
  handlers: number;
}

const abs = (plan: Plan, rel: string) => join(plan.dir, rel);

/** Add a generated file, unless another route already claimed its path. */
function claim(plan: Plan, path: string, source: string, owner: string): boolean {
  if (plan.gen.some((g) => g.path === path)) {
    plan.wont.push({
      item: owner,
      reason:
        `another route already maps to ${path}; Fresh would refuse the clash too — rename one`,
    });
    return false;
  }
  plan.gen.push({ path, source });
  return true;
}

/** Plan one page or handler route: its `app/` file and its middleware entry. */
function planRoute(plan: Plan, route: FreshFile): void {
  const { roles } = plan;
  const page = hasDefault(route.source);
  const override = routeOverride(route.source);
  const pattern = override ?? freshPattern(route.id);
  const folder = override ? null : appFolder(route.id, true);
  const routeAbs = abs(plan, route.path);
  const entry: MiddlewareRouteSpec = {
    file: route,
    abs: routeAbs,
    pattern,
    page,
    middlewares: roles.middlewares.flatMap((m, i) => isUnder(route.dir, m.dir) ? [i] : []),
    layouts: roles.layouts.filter((l) => isUnder(route.dir, l.dir)).map((l) => l.dir),
  };
  if (page) planPage(plan, entry, folder);
  else planHandler(plan, entry, folder);
  plan.mwRoutes.push(entry);
}

/** A page route: its `page.tsx` (at an internal path when the folder tree cannot hold it). */
function planPage(plan: Plan, entry: MiddlewareRouteSpec, folder: string[] | null): void {
  const route = entry.file;
  const target = folder ?? internalFolder(route.id);
  if (!folder) entry.internal = folderUrl(target);
  const file = join("app", ...target, "page.tsx");
  const error = nearestError(plan.roles.errors, route.dir);
  const errorAbs = error ? abs(plan, error.path) : null;
  const source = pageSource(abs(plan, file), route, entry.abs, errorAbs, plan.v1, !folder);
  if (claim(plan, file, source, route.path)) plan.pages++;
  if (!folder) unexpressible(plan, route, entry.pattern, true);
}

/** A handler-only route: its `route.ts`, or the middleware answers it. */
function planHandler(plan: Plan, entry: MiddlewareRouteSpec, folder: string[] | null): void {
  const route = entry.file;
  if (!folder) {
    entry.inMiddleware = true;
    plan.handlers++;
    unexpressible(plan, route, entry.pattern, false);
    return;
  }
  const file = join("app", ...folder, "route.ts");
  const methods = handlerMethods(route.source);
  const source = routeHandlerSource(abs(plan, file), route, entry.abs, plan.v1, methods);
  if (claim(plan, file, source, route.path)) plan.handlers++;
}

/** Report a route whose URL pattern the `app/` folder tree cannot express. */
function unexpressible(plan: Plan, route: FreshFile, pattern: string, page: boolean): void {
  plan.review.push({
    item: route.path,
    reason: `its URL pattern ${pattern} has no app/ folder equivalent: ` +
      (page
        ? "middleware.ts rewrites matching requests to the page generated for it"
        : "middleware.ts answers it with the route's handler"),
  });
}

/** Plan the `_layout` files below the root: an `app/<dir>/layout.tsx` each. */
function planLayouts(plan: Plan): void {
  for (const layout of plan.roles.layouts) {
    if (layout.dir === "") continue; // the root layout composes it (rootLayout)
    const folder = appFolder(layout.dir, false);
    if (!folder) {
      plan.wont.push({
        item: layout.path,
        reason: "its directory has no app/ folder equivalent (an optional or partial parameter); " +
          "wrap the pages below it in the layout by hand",
      });
      continue;
    }
    const file = join("app", ...folder, "layout.tsx");
    claim(
      plan,
      file,
      layoutSource(abs(plan, file), layout, abs(plan, layout.path), plan.v1, false, []),
      layout.path,
    );
  }
}

/** The root `layout.tsx`: the `_app` wrapper (and a root `_layout` inside it), with the CSS. */
function rootLayout(plan: Plan, css: string[]): GenFile {
  const file = join("app", "layout.tsx");
  const target = abs(plan, file);
  const { app, rootLayout: layout } = plan.roles;
  if (!app && !layout) {
    return { path: file, source: bareRootLayoutSource(target, css, plan.main) };
  }
  if (app && !layout) {
    return {
      path: file,
      source: layoutSource(target, app, abs(plan, app.path), plan.v1, true, css, plan.main),
    };
  }
  return { path: file, source: composedRootSource(plan, target, css) };
}

/** The root layout's `App` wrapper line (the `_app` file and / or `main.ts`), if any. */
function appWrapperLine(plan: Plan): string[] {
  const { app } = plan.roles;
  if (!app && !plan.main) return [];
  const opts = ['id: "_app"', "app: true", ...(plan.v1 ? ["v1: true"] : [])];
  if (plan.main) opts.push("main");
  return [`const App = freshLayout(${app ? "app" : "{}"}, { ${opts.join(", ")} });`];
}

/** A root layout running the `_app` wrapper (and `main.ts`'s) around the root `_layout`. */
function composedRootSource(plan: Plan, target: string, css: string[]): string {
  const { app, rootLayout: layout } = plan.roles;
  const rel = (p: string) => importPath(target, abs(plan, p));
  const v1 = plan.v1 ? ", v1: true" : "";
  const wrapper = appWrapperLine(plan);
  const lines = [
    FRESH_GEN_HEADER +
    `// The Fresh ${app ? "app wrapper and the " : ""}root layout routes/_layout.`,
    ...css.map((c) => `import "${importPath(target, c)}";`),
    `import { freshLayout } from "denext/fresh/server";`,
    `import * as layout from "${rel(layout!.path)}";`,
    ...(app ? [`import * as app from "${rel(app.path)}";`] : []),
    ...(plan.main ? [`import * as main from "${importPath(target, plan.main)}";`] : []),
    "",
    `const Layout = freshLayout(layout, { id: ""${v1} });`,
    ...wrapper,
    "",
    "export default async function RootLayout({ children }: { children?: unknown }) {",
    wrapper.length
      ? "  return await App({ children: await Layout({ children }) });"
      : "  return await Layout({ children });",
    "}",
    "",
  ];
  return lines.join("\n");
}

/**
 * Plan `not-found.tsx`: the root `_404`, else the root `_error` / `_500` (for a 404), else
 * `main.ts`'s `app.notFound()`.
 */
function planNotFound(plan: Plan, mainSource: string | null): void {
  const mod = plan.roles.notFound ?? plan.roles.errors.find((e) => e.dir === "") ?? null;
  const codeNotFound = mainSource !== null && /\.notFound\s*\(/.test(mainSource);
  if (!mod && !codeNotFound) return;
  const file = join("app", "not-found.tsx");
  const source = notFoundSource(
    abs(plan, file),
    mod,
    mod ? abs(plan, mod.path) : null,
    plan.v1,
    codeNotFound ? plan.main : null,
  );
  claim(plan, file, source, mod?.path ?? "main.ts");
}

/** Plan the page `main.ts`'s code-registered pages render at (see `freshAppPage`). */
function planAppRoutePage(plan: Plan): string {
  claim(plan, join("app", APP_ROUTE_FOLDER, "page.tsx"), appRoutePageSource(plan.v1), "main.ts");
  return `/${APP_ROUTE_FOLDER}`;
}

/** The import-map keys a migrated app's `fresh/runtime` goes by. */
const RUNTIME_SPECIFIERS = ["fresh/runtime", "@fresh/core/runtime", "$fresh/runtime.ts"];

/**
 * When a source renders `<Partial>`: plan the app's own `fresh/runtime` (`app/_fresh/`), whose
 * `Partial` is a client component, and point the runtime's import-map keys at it.
 */
async function planPartials(plan: Plan, files: string[]): Promise<Record<string, string>> {
  for (const rel of files) {
    const source = await mfs.readTextFile(join(plan.dir, rel)).catch(() => "");
    if (!/<Partial\b/.test(source)) continue;
    claim(plan, join("app", "_fresh", "runtime.ts"), FRESH_RUNTIME_SHIM, rel);
    claim(plan, join("app", "_fresh", "partial.ts"), FRESH_PARTIAL_SHIM, rel);
    return Object.fromEntries(RUNTIME_SPECIFIERS.map((k) => [k, "./app/_fresh/runtime.ts"]));
  }
  return {};
}

// ── Islands, static files, entry files ───────────────────────────────────────

/** `"use client"` at the top of a module (after leading comments / a shebang), unless present. */
function withUseClient(source: string): string | null {
  if (/^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source)) return null;
  // A signal prop arrives as a live signal only when the signals runtime has loaded; an island
  // that imports `@preact/signals` for its types alone would not load it.
  const signalsTypesOnly = /from\s+["']@preact\/signals(?:-core)?["']/.test(source) &&
    !/import\s+(?!type\b)[^;]*from\s+["']@preact\/signals(?:-core)?["']/.test(source);
  const signals = signalsTypesOnly ? `import "@preact/signals";\n` : "";
  return `"use client";\n${signals}${source}`;
}

/** Mark every island `"use client"` (`islands/` and the routes' `(_islands)` folders). */
async function markIslands(dir: string, localIslands: string[]): Promise<string[]> {
  const files = [
    ...(await walk(join(dir, "islands"))).map((rel) => `islands/${rel}`),
    ...localIslands,
  ].filter((rel) => ROUTE_EXTS.has(extname(rel)) && !TEST_FILE.test(rel));
  for (const rel of files) {
    const path = join(dir, rel);
    const next = withUseClient(await mfs.readTextFile(path));
    if (next !== null) await mfs.writeTextFile(path, next);
  }
  return files;
}

// ── import.meta.env ─────────────────────────────────────────────────────────

/** Vite's `import.meta.env` (also cast: `(import.meta as any).env`). */
const META_ENV = /\(\s*import\.meta(?:\s+as\s+[\w$.<>[\], ]+)?\s*\)\.env\b|\bimport\.meta\.env\b/g;

/** Fresh's inlined public reads: `Deno.env.get("FRESH_PUBLIC_X")`, `process.env.FRESH_PUBLIC_X`. */
const PUBLIC_ENV_READ =
  /\bDeno\.env\.get\(\s*(["'])(FRESH_PUBLIC_\w+)\1\s*\)|\bprocess\.env\.(FRESH_PUBLIC_\w+)\b/g;

/** The identifier the rewritten reads use, and its import. */
const ENV_ID = "importMetaEnv";
const ENV_IMPORT = `import { env as ${ENV_ID} } from "denext/fresh/env";\n`;

/** `line` inserted after a module's leading comments, shebang and directives. */
function withLeadingImport(source: string, line: string): string {
  const head =
    /^(?:#![^\n]*\n)?(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|["']use (?:client|server)["'];?[^\n]*\n))*/
      .exec(source)?.[0] ?? "";
  return source.slice(0, head.length) + line + source.slice(head.length);
}

/**
 * Point a module's `import.meta.env` and Fresh's inlined `FRESH_PUBLIC_*` reads (which an island
 * runs in the browser; on the server they read the same variable) at `denext/fresh/env`. Null
 * when there is nothing to rewrite.
 */
export function rewriteEnvReads(source: string): string | null {
  const next = source.replace(META_ENV, ENV_ID)
    .replace(PUBLIC_ENV_READ, (_m, _q, a, b) => `${ENV_ID}.${a ?? b}`);
  if (next === source) return null;
  return new RegExp(`\\b${ENV_ID}\\b`).test(source) ? next : withLeadingImport(next, ENV_IMPORT);
}

/** Rewrite the env reads of the app's sources (not Vite's config); the files changed. */
async function rewriteEnv(dir: string, files: string[]): Promise<string[]> {
  const changed: string[] = [];
  for (const rel of files.filter((f) => !/^vite\.config\./.test(f))) {
    const path = join(dir, rel);
    const source = await mfs.readTextFile(path).catch(() => null);
    const next = source === null ? null : rewriteEnvReads(source);
    if (next === null) continue;
    await mfs.writeTextFile(path, next);
    changed.push(rel);
  }
  return changed;
}

/** The Tailwind directive (v4's `@import "tailwindcss"` or a v3 `@tailwind` line). */
const TAILWIND_DIRECTIVE = /@import\s+["']tailwindcss["']|@tailwind\s+(base|utilities|components)/;

/**
 * Move `static/` to `public/`. A stylesheet holding the Tailwind directive moves to `assets/`
 * instead (it is Tailwind's input; its compiled output takes its place under `public/`).
 *
 * @returns The Tailwind input / output, when `static/` held the input.
 */
async function moveStatic(
  plan: Plan,
): Promise<{ input: string; output: string } | null> {
  const { dir } = plan;
  let tailwind: { input: string; output: string } | null = null;
  const files = await walk(join(dir, "static"));
  for (const rel of files) {
    const from = join(dir, "static", rel);
    let to = join(dir, "public", rel);
    if (!tailwind && rel.endsWith(".css")) {
      const css = await mfs.readTextFile(from).catch(() => "");
      if (TAILWIND_DIRECTIVE.test(css)) {
        tailwind = { input: `./assets/${rel}`, output: `./public/${rel}` };
        to = join(dir, "assets", rel);
      }
    }
    if (await exists(to)) {
      plan.wont.push({
        item: `static/${rel}`,
        reason: `public/${rel} already exists; merge them by hand`,
      });
      continue;
    }
    await mfs.mkdir(dirname(to), { recursive: true });
    await mfs.rename(from, to);
  }
  await removeEmptyDirs(join(dir, "static"));
  return tailwind;
}

/** Remove `abs` and its subdirectories when they hold no files. */
async function removeEmptyDirs(abs: string): Promise<void> {
  let entries: Deno.DirEntry[] = [];
  try {
    for await (const e of mfs.readDir(abs)) entries.push(e);
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory) await removeEmptyDirs(join(abs, e.name));
  entries = [];
  for await (const e of mfs.readDir(abs)) entries.push(e);
  if (entries.length === 0) await mfs.remove(abs);
}

/** What the Vite client entry (`client.ts`) held: stylesheets, and any other code. */
interface ClientEntry {
  css: string[];
  rest: string;
}

/** Split `client.ts` into its stylesheet imports and the rest of its code. */
function splitClientEntry(dir: string, source: string): ClientEntry {
  const css: string[] = [];
  const rest = source.replace(
    /^\s*import\s+["'](\.{1,2}\/[^"']+\.(?:css|scss|sass))["'];?[^\S\n]*\n?/gm,
    (_m, spec: string) => {
      css.push(join(dir, spec));
      return "";
    },
  );
  const code = rest.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").trim();
  return { css, rest: code ? rest.replace(/^\s+/, "") : "" };
}

/**
 * Carry the Vite client entry over: its stylesheets go to the root layout, any other code to
 * `instrumentation-client.ts` (which denext runs in the browser before the page hydrates).
 *
 * @returns The stylesheets (absolute paths).
 */
async function carryClientEntry(plan: Plan): Promise<string[]> {
  for (const name of ["client.ts", "client.tsx", "client.js"]) {
    const path = join(plan.dir, name);
    const source = await mfs.readTextFile(path).catch(() => null);
    if (source === null) continue;
    const { css, rest } = splitClientEntry(plan.dir, source);
    if (rest) {
      const target = join(plan.dir, "instrumentation-client.ts");
      if (await exists(target)) {
        plan.wont.push({
          item: name,
          reason: "instrumentation-client.ts exists; merge client.ts's code into it by hand",
        });
        return css;
      }
      await mfs.writeTextFile(target, rest);
    }
    await mfs.remove(path);
    return css;
  }
  return [];
}

/** The Vite plugins a `vite.config.*` registers (`name(`), minus Fresh's and Tailwind's. */
function otherVitePlugins(source: string): string[] {
  const block = /plugins\s*:\s*\[([\s\S]*?)\]\s*,?\s*\}?/.exec(source)?.[1] ?? "";
  const names = [...block.matchAll(/([A-Za-z_$][\w$.]*)\s*\(/g)].map((m) => m[1]);
  return names.filter((n) => n !== "fresh" && n !== "tailwindcss" && n !== "tailwind");
}

/** Remove `vite.config.*` (denext builds the app), reporting the plugins it ran. */
async function dropViteConfig(plan: Plan): Promise<void> {
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"]) {
    const path = join(plan.dir, name);
    const source = await mfs.readTextFile(path).catch(() => null);
    if (source === null) continue;
    for (const plugin of otherVitePlugins(source)) {
      plan.wont.push({
        item: `${name}: ${plugin}()`,
        reason: "a Vite plugin; denext builds the app without Vite. Port what it does (a build " +
          "step, an emitted file) to denext.config.ts (`plugins`, `viteEmitterPlugin`)",
      });
    }
    if (/\bfresh\s*\(\s*\{/.test(source)) {
      plan.review.push({
        item: `${name}: fresh({ … })`,
        reason: "Fresh plugin options are not carried; the migration reads routes/, islands/ " +
          "and client.ts at their default places",
      });
    }
    await mfs.remove(path);
  }
}

/** Report a Fresh 1.x `fresh.config.ts`'s plugins, then remove it (denext.config.ts replaces it). */
async function dropFreshConfig(plan: Plan): Promise<void> {
  const path = join(plan.dir, "fresh.config.ts");
  const source = await mfs.readTextFile(path).catch(() => null);
  if (source === null) return;
  const block = /plugins\s*:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
  for (const m of block.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (m[1] === "tailwind") continue;
    plan.wont.push({
      item: `fresh.config.ts: ${m[1]}()`,
      reason: "a Fresh plugin; denext does not run Fresh plugins. Port what it adds (routes, " +
        "middleware, islands, styles) to the app or to a denext plugin",
    });
  }
  await mfs.remove(path);
}

/** Remove Fresh's own entry and generated files; Fresh 2's `main.ts` stays (middleware.ts runs it). */
async function dropFreshEntries(plan: Plan): Promise<string | null> {
  const { dir } = plan;
  for (const name of ["fresh.gen.ts", "dev.ts"]) {
    const path = join(dir, name);
    const source = await mfs.readTextFile(path).catch(() => null);
    if (source === null) continue;
    if (name === "fresh.gen.ts" || /fresh\/dev|\$fresh\/dev\.ts|Builder\b/.test(source)) {
      await mfs.remove(path);
    }
  }
  const mainPath = join(dir, "main.ts");
  const main = await mfs.readTextFile(mainPath).catch(() => null);
  if (main === null) return null;
  if (/\bstart\s*\(\s*manifest/.test(main) || plan.v1) {
    await mfs.remove(mainPath);
    return null;
  }
  return /\bnew\s+App\b/.test(main) ? mainPath : null;
}

// ── Findings ─────────────────────────────────────────────────────────────────

/** A source pattern that does not migrate (or needs a look), with the reason. */
interface SourceRule {
  re: RegExp;
  item: string;
  reason: string;
  wont?: boolean;
  /** Only for these files (`island` / `main`), else any. */
  only?: "island" | "main";
}

const SOURCE_RULES: SourceRule[] = [
  ...PREACT_SOURCE_RULES,
  {
    re: /\bf-view-transition\b/,
    item: "f-view-transition",
    reason: "partial navigation runs on denext without the View Transitions wrapper; the swapped " +
      "regions update in place",
  },
  {
    re: /<script\b[^>]*dangerouslySetInnerHTML/,
    item: "inline <script>",
    reason: "denext's default Content-Security-Policy runs no inline script (script-src " +
      "'self'); move the code to a file under public/ (`<script src>`) or into " +
      "instrumentation-client.ts, or allow it in `csp.scriptSrc` in denext.config.ts",
  },
  {
    re: /\.upgrade\s*\(|Deno\.upgradeWebSocket\s*\(/,
    item: "WebSocket upgrade",
    reason: "ctx.upgrade() needs the raw request: it works under `denext start` / `dev`, not on " +
      "every deploy target; denext's Live channels (denext/live) are the portable alternative",
  },
  {
    re: /\bDeno\.env\b/,
    only: "island",
    item: "Deno.env in an island",
    reason: "an island runs in the browser, where Deno.env is undefined (a literal " +
      "FRESH_PUBLIC_* read was rewritten to denext/fresh/env); pass the value as a prop, or use " +
      "publicEnv() from denext",
  },
  {
    re: /\.islands\s*\(/,
    only: "main",
    item: "main.ts",
    wont: true,
    reason: 'app.islands() is not run on denext: islands are the "use client" files ' +
      "(islands/ and (_islands) folders); move the components there",
  },
  {
    re: /new\s+App\s*\(\s*\{[^}]*basePath/,
    only: "main",
    item: "main.ts: basePath",
    reason: "set `basePath` in denext.config.ts; the App option is not applied",
  },
];

/** The project's source files the findings scan reads (generated and vendored trees skipped). */
async function sourceFiles(dir: string): Promise<string[]> {
  const skip = /^(?:node_modules|_fresh|\.denext|app|public|static|vendor|\.git)\//;
  return (await walk(dir)).filter((rel) =>
    ROUTE_EXTS.has(extname(rel)) && !skip.test(rel) && !TEST_FILE.test(rel)
  );
}

/** Whether a rule reads `rel` (an island-only or a `main.ts`-only rule reads only those). */
function ruleApplies(rule: SourceRule, rel: string, islands: Set<string>): boolean {
  if (rule.only === "island") return islands.has(rel);
  return rule.only !== "main" || rel === "main.ts";
}

/** Scan the app's sources for what does not migrate: one finding per rule, naming the files. */
async function scanFindings(plan: Plan, islands: Set<string>, files: string[]): Promise<void> {
  const hits = new Map<SourceRule, string[]>();
  for (const rel of files) {
    const source = await mfs.readTextFile(join(plan.dir, rel)).catch(() => "");
    for (const rule of SOURCE_RULES) {
      if (ruleApplies(rule, rel, islands) && rule.re.test(source)) {
        hits.set(rule, [...(hits.get(rule) ?? []), rel]);
      }
    }
  }
  for (const [rule, where] of hits) {
    const finding = { item: rule.item, reason: `${rule.reason} (${where.join(", ")})` };
    (rule.wont ? plan.wont : plan.review).push(finding);
  }
}

// ── deno.json ────────────────────────────────────────────────────────────────

/** Fresh's and Vite's own packages (Preact's: `isPreactPackage`): dropped from the import map. */
const DROPPED_IMPORTS = [
  /^fresh(?:\/|$)/,
  /^@fresh\//,
  /^\$fresh\//,
  /^vite(?:\/|$)/,
  /^@tailwindcss\/vite$/,
  /^@types\/babel__core$/,
];

/** The import-map keys of a Fresh app that point at Fresh / Preact / Vite (removed by the merge). */
export function droppedFreshImports(imports: Record<string, string>): string[] {
  return Object.keys(imports).filter((k) =>
    isPreactPackage(k) || DROPPED_IMPORTS.some((re) => re.test(k))
  );
}

/**
 * The specifiers a migrated Fresh app's import map aliases to denext: Fresh's server and runtime
 * modules (Fresh 2's and 1.x's; the partial navigation and `import.meta.env` ones), Preact, its hooks / compat / JSX runtime, and Preact Signals.
 *
 * @param sub Resolves a `denext/<sub>` entry (`R.sub`).
 * @returns The import-map entries.
 */
export function freshAliasImports(sub: (s: string) => string): Record<string, string> {
  return {
    "denext/fresh": sub("fresh"),
    "denext/fresh/runtime": sub("fresh/runtime"),
    "denext/fresh/partial": sub("fresh/partial"),
    "denext/fresh/env": sub("fresh/env"),
    "denext/fresh/server": sub("fresh/server"),
    "fresh": sub("fresh"),
    "fresh/runtime": sub("fresh/runtime"),
    "@fresh/core": sub("fresh"),
    "@fresh/core/runtime": sub("fresh/runtime"),
    "$fresh/server.ts": sub("fresh"),
    "$fresh/runtime.ts": sub("fresh/runtime"),
    ...preactAliasImports(sub),
  };
}

/** What the merged `deno.json` takes from the migration. */
export interface FreshDenoJsonInput {
  /** The marker text (the `"//"` key) that lets a re-run rewrite the file. */
  marker: string;
  /** denext's import-map entries (react family, `denext/*`, the Fresh / Preact aliases). */
  imports: Record<string, string>;
  /** denext's tasks (`dev`, `build`, `start`, `export`). */
  tasks: Record<string, string>;
  /** The `unstable` list. */
  unstable: string[];
}

/**
 * A `minimumDependencyAge` value without the `"jsr:@denext/*"` exclude entry migrate wrote
 * before 4.5.2 (every other entry kept; an object left empty becomes `undefined`).
 */
function withoutDenextExclude(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const { exclude, ...rest } = value as { exclude?: unknown };
  if (!Array.isArray(exclude) || !exclude.includes(DENEXT_EXCLUDE)) return value;
  const kept = exclude.filter((e) => e !== DENEXT_EXCLUDE);
  const out = kept.length ? { ...rest, exclude: kept } : rest;
  return Object.keys(out).length ? out : undefined;
}

/** The Fresh-only tasks a migrated app drops (denext's replace `dev` / `build` / `start`). */
const DROPPED_TASKS = new Set(["dev", "build", "start", "preview", "update", "manifest"]);

/** Fresh-era compiler options denext does not use. */
function compilerOptionsFor(existing: unknown): Record<string, unknown> {
  const opts = { ...(existing && typeof existing === "object" ? existing : {}) } as Record<
    string,
    unknown
  >;
  for (const key of ["jsxPrecompileSkipElements", "jsxFactory", "jsxFragmentFactory"]) {
    delete opts[key];
  }
  if (Array.isArray(opts.types)) {
    opts.types = (opts.types as string[]).filter((t) => t !== "vite/client");
    if ((opts.types as string[]).length === 0) delete opts.types;
  }
  const lib = Array.isArray(opts.lib) ? opts.lib as string[] : ["deno.window"];
  return {
    ...opts,
    jsx: "react-jsx",
    // Preact's JSX runtime on denext: signal-valued DOM props are bound.
    jsxImportSource: "preact",
    lib: [...new Set([...lib, "dom", "dom.iterable", "dom.asynciterable"])],
  };
}

/**
 * The Fresh app's `deno.json`, merged for denext: Fresh / Preact / Vite imports replaced by the
 * denext aliases, denext's tasks for `dev` / `build` / `start`, the JSX runtime pointed at
 * denext, and everything else the author wrote kept.
 *
 * @param config The parsed existing config.
 * @param input The migration's entries.
 * @returns The merged config.
 */
export function freshDenoJson(
  config: Record<string, unknown>,
  input: FreshDenoJsonInput,
): Record<string, unknown> {
  const { "//": _marker, ...rest } = config;
  const imports = { ...importsOf(config) };
  for (const key of droppedFreshImports(imports)) delete imports[key];
  const tasks = Object.fromEntries(
    Object.entries((rest.tasks ?? {}) as Record<string, string>).filter(([k]) =>
      !DROPPED_TASKS.has(k)
    ),
  );
  return {
    "//": input.marker,
    ...rest,
    tasks: { ...tasks, ...input.tasks },
    nodeModulesDir: "auto",
    // The author's own hold, if any — minus the `jsr:@denext/*` exemption an earlier migrate wrote.
    minimumDependencyAge: withoutDenextExclude(rest.minimumDependencyAge),
    unstable: input.unstable,
    compilerOptions: compilerOptionsFor(rest.compilerOptions),
    imports: { ...imports, ...input.imports },
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Whether a generated file may be written: absent, or written by an earlier run. */
async function writableGen(path: string): Promise<boolean> {
  const current = await mfs.readTextFile(path).catch(() => null);
  return current === null || current.includes("generated by `denext migrate`");
}

/** Write the planned files; one the user wrote is left alone (and reported). */
async function writeGenerated(plan: Plan, written: string[]): Promise<void> {
  for (const g of plan.gen) {
    const path = join(plan.dir, g.path);
    if (!(await writableGen(path))) {
      plan.wont.push({
        item: g.path,
        reason: "exists and was not generated by migrate; left as is",
      });
      continue;
    }
    await mfs.mkdir(dirname(path), { recursive: true });
    await mfs.writeTextFile(path, g.source);
    written.push(path);
  }
}

/** Whether a stylesheet holds the Tailwind directive. */
async function isTailwindInput(path: string): Promise<boolean> {
  return TAILWIND_DIRECTIVE.test(await mfs.readTextFile(path).catch(() => ""));
}

/**
 * The stylesheets the root layout imports (absolute) and the Tailwind setup: a Vite client
 * entry's Tailwind input is compiled to a `.gen.css` beside it, which the layout imports
 * instead; a `static/` Tailwind input (Fresh's own builder) compiles to its old `public/` path.
 */
async function layoutStylesheets(
  dir: string,
  clientCss: string[],
  staticTailwind: { input: string; output: string } | null,
): Promise<{ tailwind: { input: string; output: string } | null; css: string[] }> {
  let tailwind = staticTailwind;
  const css: string[] = [];
  for (const sheet of clientCss) {
    if (!tailwind && await isTailwindInput(sheet)) {
      const rel = "./" + sheet.slice(dir.length + 1).replaceAll("\\", "/");
      tailwind = { input: rel, output: rel.replace(/\.(?:css|scss|sass)$/, ".gen.css") };
      css.push(join(dir, tailwind.output));
    } else css.push(sheet);
  }
  return { tailwind, css };
}

/**
 * Restructure the Fresh app at `dir` for denext (see the module comment). The import map is not
 * written here: {@link freshDenoJson} merges it, and `migrate.ts` writes it with the config.
 *
 * @param dir The app directory.
 * @param detection What {@link detectFresh} found.
 * @param written Collects the paths written.
 * @returns What was done, and what is left to the user.
 */
export async function transformFreshApp(
  dir: string,
  detection: FreshDetection,
  written: string[],
): Promise<FreshMigrateInfo> {
  const v1 = detection.version === 1;
  const scan = await scanRoutes(dir);
  const findings: FreshFinding[] = [];
  const plan: Plan = {
    dir,
    v1,
    main: null,
    roles: rolesOf(scan.files, findings),
    gen: [],
    mwRoutes: [],
    wont: findings,
    review: [],
    pages: 0,
    handlers: 0,
  };
  const sourcesBefore = await sourceFiles(dir);
  for (const route of plan.roles.routes) planRoute(plan, route);
  plan.mwRoutes.sort((a, b) => byMatchOrder(a, b));
  planLayouts(plan);

  const islands = await markIslands(dir, scan.localIslands);
  const envFiles = await rewriteEnv(dir, sourcesBefore);
  const importOverrides = await planPartials(plan, sourcesBefore);
  const staticTailwind = await moveStatic(plan);
  const clientCss = await carryClientEntry(plan);
  await dropViteConfig(plan);
  if (v1) await dropFreshConfig(plan);
  const main = await dropFreshEntries(plan);
  plan.main = main;
  const mainSource = main ? await mfs.readTextFile(main).catch(() => null) : null;
  planNotFound(plan, mainSource);
  const appRoute = main ? planAppRoutePage(plan) : undefined;

  const { tailwind, css } = await layoutStylesheets(dir, clientCss, staticTailwind);
  plan.gen.unshift(rootLayout(plan, css));

  const mwPath = join(dir, "middleware.ts");
  plan.gen.push({
    path: "middleware.ts",
    source: middlewareSource(mwPath, {
      v1,
      main,
      middlewares: plan.roles.middlewares.map((m) => ({
        file: m,
        abs: abs(plan, m.path),
        prefix: /[[(]/.test(m.dir) ? null : "/" + m.dir,
      })),
      layouts: plan.roles.layouts.map((l) => ({ file: l, abs: abs(plan, l.path) })),
      routes: plan.mwRoutes,
      appRoute,
    }),
  });
  await writeGenerated(plan, written);
  await scanFindings(plan, new Set(islands), sourcesBefore);
  if (envFiles.length > 0) {
    plan.review.push({
      item: "import.meta.env",
      reason: "rewritten to importMetaEnv from denext/fresh/env (MODE, DEV, PROD, SSR, BASE_URL " +
        "and the FRESH_PUBLIC_* / DENEXT_PUBLIC_* / NEXT_PUBLIC_* variables; server-only " +
        "variables are not in it: read Deno.env). PROD is true under `denext start`, where " +
        "your source runs in place, not from Vite's build output: check code that picks a " +
        `file path by it (${envFiles.join(", ")})`,
    });
  }
  if (tailwind && staticTailwind && v1) {
    plan.review.push({
      item: tailwind.input,
      reason: "denext compiles Tailwind v4; a Tailwind v3 stylesheet and tailwind.config.ts " +
        "need `npx @tailwindcss/upgrade` first",
    });
  }
  return {
    version: detection.version,
    pages: plan.pages,
    handlers: plan.handlers,
    layouts: plan.roles.layouts.length + (plan.roles.app ? 1 : 0),
    middlewares: plan.roles.middlewares.length,
    islands: islands.length,
    tailwind,
    wontMigrate: plan.wont,
    review: plan.review,
    importOverrides,
  };
}
