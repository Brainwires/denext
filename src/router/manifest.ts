// Route manifest: scan an app directory into an ordered list of page and API
// routes, each with its parsed pattern and (for pages) the chain of layouts
// that wrap it.
//
// File conventions inside the app dir:
//   page.{tsx,ts,jsx,js}     -> a rendered page at that path
//   layout.{tsx,ts,jsx,js}   -> wraps this segment and everything beneath it
//   route.{ts,js}            -> an API endpoint (exports GET/POST/... handlers)
//   (group)/                 -> a route group: folder name omitted from the URL

import { join } from "@std/path";
import {
  compareSpecificity,
  type Intercept,
  parseIntercept,
  parseSegment,
  parseSlot,
  type Segment,
} from "./segments.ts";
import { type Directive, readDirective } from "../build/directives.ts";

/** A rendered page route discovered by scanning the app directory. */
export interface PageRoute {
  /** Discriminant marking this as a page route. */
  kind: "page";
  /** Parsed URL pattern segments. */
  pattern: Segment[];
  /** Human-readable route path, e.g. "/blog/[slug]". */
  routePath: string;
  /** Absolute path to the page module. */
  filePath: string;
  /** Layout module paths from outermost (root) to innermost. */
  layoutChain: string[];
  /**
   * URL segment depth of each layout in {@link layoutChain} (parallel array):
   * the number of path segments consumed above that layout. Used to resolve
   * `useSelectedLayoutSegment(s)` relative to each layout's level. Always
   * populated by {@link scanRoutes}; optional only so hand-built routes may omit it.
   */
  layoutDepths?: number[];
  /** Nearest loading.tsx (Suspense fallback) up the tree, or null. */
  loading: string | null;
  /** Nearest error.tsx (error boundary) up the tree, or null. */
  error: string | null;
  /** Nearest not-found.tsx up the tree, or null. */
  notFound: string | null;
  /** Nearest forbidden.tsx (403 UI) up the tree, or null. */
  forbidden: string | null;
  /** Nearest unauthorized.tsx (401 UI) up the tree, or null. */
  unauthorized: string | null;
  /**
   * Nearest `opengraph-image` URL path up the tree for this route (e.g.
   * `/blog/opengraph-image`), or undefined. Resolved from static route segments
   * (a dynamic-segment image can't be served statically, so it's skipped); the
   * root image is not carried here — it remains the global fallback via
   * {@link RouteManifest.openGraphImage}. Injected as `og:image` when the page
   * declares none. See {@link RouteManifest.imageRoutes} for serving.
   */
  openGraphImage?: string;
  /** Nearest `twitter-image` URL path up the tree, or undefined (as {@link openGraphImage}). */
  twitterImage?: string;
  /** Template module paths (like layouts, but conceptually re-mounted), outer→inner. */
  templateChain: string[];
  /**
   * Per-directory-level files from the root down to the page's directory, in order —
   * only levels that define at least one of layout/template/loading/error. Lets the
   * renderer nest boundaries per segment the way Next.js does (`layout → template →
   * error → loading → children`), so a throw in a nested layout is caught by the
   * nearest ANCESTOR segment's `error.tsx`. `loading`/`error` stay the nearest
   * (inherited) files for consumers that only need one.
   */
  levels?: SegmentLevel[];
  /**
   * Parallel-route slots (`@name` folders) collected at this page's own level,
   * mapping slot name to its routable subtree. Kept for introspection; rendering
   * uses {@link layoutSlots} (slots are scoped to the layout at their level).
   */
  slots?: Record<string, SlotRoutes>;
  /**
   * Slots to render into each layout in {@link layoutChain} (parallel array).
   * `layoutSlots[i]` holds the slots declared beside `layoutChain[i]`, matched
   * against the current URL — so a slot spans every route under its layout
   * (Next.js parallel-route semantics, e.g. modals).
   */
  layoutSlots?: Array<Record<string, SlotRoutes> | undefined>;
  /**
   * Set when this route was produced by an intercepting folder (`(.)`/`(..)`/
   * `(...)`). Such routes match only during soft (client) navigation; a hard load
   * falls through to the real route at the same path.
   */
  intercept?: Intercept;
}

/** The convention files one route directory level contributes (own files, not inherited). */
export interface SegmentLevel {
  /** Path segments consumed above this level (for layout-relative segment hooks). */
  depth: number;
  layout: string | null;
  template: string | null;
  loading: string | null;
  error: string | null;
}

/** A parallel-route slot's own routable subtree (its pages + a default fallback). */
export interface SlotRoutes {
  /** The slot's page routes (mirroring real URLs; slot name omitted), sorted. */
  pages: PageRoute[];
  /** The slot's `default.tsx` module path, rendered when nothing matches, or null. */
  default: string | null;
}

/** An API endpoint route discovered by scanning the app directory. */
export interface ApiRoute {
  /** Discriminant marking this as an API route. */
  kind: "api";
  /** Parsed URL pattern segments. */
  pattern: Segment[];
  /** Human-readable route path, e.g. "/api/users/[id]". */
  routePath: string;
  /** Absolute path to the route module. */
  filePath: string;
}

/** The complete set of routes and root-level boundaries for an app. */
export interface RouteManifest {
  /** All page routes, sorted most-specific first. */
  pages: PageRoute[];
  /** All API routes, sorted most-specific first. */
  api: ApiRoute[];
  /** Root layout path if present, else null. */
  rootLayout: string | null;
  /** Root not-found.tsx path if present, else null. */
  rootNotFound: string | null;
  /** Root global-error.tsx path (wraps the entire tree incl. root layout), or null. */
  rootGlobalError: string | null;
  /** `sitemap.ts` module path (served at /sitemap.xml), or null. */
  sitemap?: string | null;
  /** `robots.ts` module path (served at /robots.txt), or null. */
  robots?: string | null;
  /** `manifest.ts` module path (served at /manifest.webmanifest), or null. */
  webManifest?: string | null;
  /** `favicon.ico` file path (served at /favicon.ico), or null. */
  favicon?: string | null;
  /** Root `opengraph-image.{tsx,ts,jsx,js}` module path (served at /opengraph-image), or null. */
  openGraphImage?: string | null;
  /** Root `icon.*` file (static image or module, served at /icon), or null. */
  icon?: string | null;
  /** Root `apple-icon.*` file (static image or module, served at /apple-icon), or null. */
  appleIcon?: string | null;
  /** Root `twitter-image.*` file (static image or module, served at /twitter-image), or null. */
  twitterImage?: string | null;
  /**
   * Nested (non-root) metadata-image conventions, mapping the served URL path
   * (e.g. `/blog/opengraph-image`) to the module/file that produces it. Populated
   * for static route segments only; the root images stay in {@link openGraphImage}
   * /{@link twitterImage}. Consumed by `serveMetadataFile`.
   */
  imageRoutes?: Map<string, string>;
  /**
   * Boundary directive (`"use client"` / `"use server"`) per component module,
   * keyed by absolute file path. Only modules that declare a directive appear;
   * an absent key means the module is undirected ("shared"/isomorphic). Populated
   * by scanning each discovered component module's directive prologue.
   */
  directives?: Map<string, Directive>;
}

/** Inheritable special-file boundaries carried down the tree (nearest wins). */
interface Boundaries {
  loading: string | null;
  error: string | null;
  notFound: string | null;
  forbidden: string | null;
  unauthorized: string | null;
}

/** All-null boundaries, the starting state for the root and each slot subtree. */
const EMPTY_BOUNDARIES: Boundaries = {
  loading: null,
  error: null,
  notFound: null,
  forbidden: null,
  unauthorized: null,
};

/** Nearest nested metadata-image URL paths carried down the tree (nearest wins). */
interface MetaImages {
  openGraphImage?: string;
  twitterImage?: string;
}

/** URL-path suffixes for the metadata-image conventions (mirror metadata-files.ts). */
const OPENGRAPH_IMAGE_SUFFIX = "/opengraph-image";
const TWITTER_IMAGE_SUFFIX = "/twitter-image";

// Standard component extensions vs. handler-only (route) extensions.
const COMPONENT_EXT = "(tsx|ts|jsx|js)";
const HANDLER_EXT = "(ts|js)";
// Metadata images come as a static file or a dynamic module.
const IMAGE_ASSET_EXT = "(png|ico|jpe?g|svg|gif|webp|avif|tsx|ts|jsx|js)";

/** The built-in App Router file conventions, keyed by name. */
const conventions = new Map<string, RegExp>([
  ["page", new RegExp(`^page\\.${COMPONENT_EXT}$`)],
  ["layout", new RegExp(`^layout\\.${COMPONENT_EXT}$`)],
  ["template", new RegExp(`^template\\.${COMPONENT_EXT}$`)],
  ["route", new RegExp(`^route\\.${HANDLER_EXT}$`)],
  ["loading", new RegExp(`^loading\\.${COMPONENT_EXT}$`)],
  ["error", new RegExp(`^error\\.${COMPONENT_EXT}$`)],
  ["not-found", new RegExp(`^not-found\\.${COMPONENT_EXT}$`)],
  ["forbidden", new RegExp(`^forbidden\\.${COMPONENT_EXT}$`)],
  ["unauthorized", new RegExp(`^unauthorized\\.${COMPONENT_EXT}$`)],
  ["global-error", new RegExp(`^global-error\\.${COMPONENT_EXT}$`)],
  ["default", new RegExp(`^default\\.${COMPONENT_EXT}$`)],
  // Metadata files (code modules serving a well-known URL).
  // Code modules OR the static file Next.js also accepts (`sitemap.xml`, `robots.txt`,
  // `manifest.json`/`.webmanifest`).
  ["sitemap", new RegExp(`^sitemap\\.(${HANDLER_EXT.slice(1, -1)}|xml)$`)],
  ["robots", new RegExp(`^robots\\.(${HANDLER_EXT.slice(1, -1)}|txt)$`)],
  ["web-manifest", new RegExp(`^manifest\\.(${HANDLER_EXT.slice(1, -1)}|json|webmanifest)$`)],
  ["opengraph-image", new RegExp(`^opengraph-image\\.${IMAGE_ASSET_EXT}$`)],
  ["icon", new RegExp(`^icon\\.${IMAGE_ASSET_EXT}$`)],
  ["apple-icon", new RegExp(`^apple-icon\\.${IMAGE_ASSET_EXT}$`)],
  ["twitter-image", new RegExp(`^twitter-image\\.${IMAGE_ASSET_EXT}$`)],
]);

/**
 * Register (or override) a file convention's matcher by name. Extension point
 * for consumers that add or retarget conventions before scanning.
 *
 * @param name The convention name (e.g. "page").
 * @param match A RegExp tested against each file basename.
 */
export function registerConvention(name: string, match: RegExp): void {
  conventions.set(name, match);
}

/** Look up a convention matcher by name (throws if unknown). */
function conv(name: string): RegExp {
  const re = conventions.get(name);
  if (!re) throw new Error(`denext: unknown file convention "${name}"`);
  return re;
}

/** Boundary fields and the convention name that populates each. */
const BOUNDARY_CONVENTIONS: Array<[keyof Boundaries, string]> = [
  ["loading", "loading"],
  ["error", "error"],
  ["notFound", "not-found"],
  ["forbidden", "forbidden"],
  ["unauthorized", "unauthorized"],
];

/**
 * A hook run over the scanned manifest before it is returned. May add, remove,
 * or adjust routes — the extension point behind synthesized/derived routes. May
 * be async (e.g. a plugin scanning its own route tree off disk).
 */
export type RouteSynthesizer = (manifest: RouteManifest) => void | Promise<void>;

const synthesizers: RouteSynthesizer[] = [];

/**
 * Register a hook that post-processes the manifest after scanning. Hooks run in
 * registration order; the manifest is re-sorted (most-specific first) afterward.
 *
 * @param fn The synthesizer to run over each scanned manifest.
 * @returns A disposer that unregisters this synthesizer — used by the plugin layer
 * so `resetPlugins()` can clear plugin-registered synthesizers (registration is
 * otherwise process-global and would leak across in-process runs).
 */
export function registerRouteSynthesizer(fn: RouteSynthesizer): () => void {
  synthesizers.push(fn);
  return () => {
    const i = synthesizers.indexOf(fn);
    if (i >= 0) synthesizers.splice(i, 1);
  };
}

/** Is a directory name a route group like "(marketing)"? */
function isRouteGroup(name: string): boolean {
  return name.startsWith("(") && name.endsWith(")");
}

/** Resolve the URL pattern an intercepting folder targets from its location. */
function interceptTarget(segments: Segment[], ic: Intercept): Segment[] {
  const name = parseSegment(ic.name);
  if (ic.level === "same") return [...segments, name];
  if (ic.level === "root") return [name];
  const up = Math.min(ic.level, segments.length);
  return [...segments.slice(0, segments.length - up), name];
}

/** Most-specific first; ties broken by routePath for deterministic output. */
function bySpecificity(
  a: { pattern: Segment[]; routePath: string },
  b: { pattern: Segment[]; routePath: string },
): number {
  const d = compareSpecificity(a.pattern, b.pattern);
  if (d !== 0) return d;
  return a.routePath < b.routePath ? -1 : a.routePath > b.routePath ? 1 : 0;
}

/** Mutable collection the walk appends discovered routes into. */
interface WalkOut {
  pages: PageRoute[];
  api: ApiRoute[];
}

/** Everything a directory inherits from its ancestors during the walk. */
interface WalkFrame {
  segments: Segment[];
  layoutChain: string[];
  /** Each layout consumes `segments.length` path segments above it (for layout-relative `useSelectedLayoutSegment(s)`). */
  layoutDepths: number[];
  layoutSlotsChain: Array<Record<string, SlotRoutes> | undefined>;
  templateChain: string[];
  levels: SegmentLevel[];
  boundaries: Boundaries;
  metaImages: MetaImages;
  intercept: Intercept | undefined;
}

/** Per-scan state: URL path → file for nested (non-root) metadata images. */
interface ScanCtx {
  imageRoutes: Map<string, string>;
}

/** A fresh frame rooted at `segments` (the app root, or a parallel slot's subtree). */
function rootFrame(segments: Segment[]): WalkFrame {
  return {
    segments,
    layoutChain: [],
    layoutDepths: [],
    layoutSlotsChain: [],
    templateChain: [],
    levels: [],
    boundaries: { ...EMPTY_BOUNDARIES },
    metaImages: {},
    intercept: undefined,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** Scan `appDir` recursively and produce a sorted route manifest. */
export async function scanRoutes(appDir: string): Promise<RouteManifest> {
  const out: WalkOut = { pages: [], api: [] };
  // No `app/` tree → no App Router routes. A Pages Router app (served by the
  // `@denext/pages-router` plugin) has only `pages/`, so return an empty manifest
  // rather than throwing on the missing directory — the plugin's request handler
  // (wired as the app's `matchExternal`) serves every route.
  if (!(await isDirectory(appDir))) {
    return { ...out, rootLayout: null, rootNotFound: null, rootGlobalError: null };
  }
  const ctx: ScanCtx = { imageRoutes: new Map() };
  await walk(ctx, appDir, rootFrame([]), out);
  // Most-specific routes first so the matcher can return on first hit.
  out.pages.sort(bySpecificity);
  out.api.sort(bySpecificity);
  const manifest: RouteManifest = {
    ...out,
    rootLayout: out.pages.find((p) => p.layoutChain.length > 0)?.layoutChain[0] ?? null,
    ...(await rootFiles(appDir)),
    imageRoutes: ctx.imageRoutes.size > 0 ? ctx.imageRoutes : undefined,
  };
  // Route-synthesis hooks may add or adjust routes; re-sort afterward. With no
  // hooks registered this is a no-op on already-sorted arrays. Hooks may be async
  // (a plugin scanning its own tree), so await each in registration order.
  for (const synth of synthesizers) await synth(manifest);
  manifest.pages.sort(bySpecificity);
  manifest.api.sort(bySpecificity);
  manifest.directives = await scanDirectives(manifest);
  return manifest;
}

/** Walk one directory: its slots, its own routes, then its child directories. */
async function walk(ctx: ScanCtx, dir: string, frame: WalkFrame, out: WalkOut): Promise<void> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  const slots = await scanSlots(ctx, dir, entries, frame.segments);
  const here = levelFrame(ctx, dir, entries, frame, slots);
  collectRoutes(dir, entries, here, slots, out);
  for (const entry of entries) {
    // Parallel slots are scanned above, not walked as standalone routes; a `_private`
    // folder (Next.js convention) is colocated code that is never routable.
    if (!entry.isDirectory || parseSlot(entry.name) || isPrivateFolder(entry.name)) continue;
    await walk(ctx, join(dir, entry.name), childFrame(here, entry.name), out);
  }
}

/**
 * Collect parallel-route slots (`@name` folders): each is scanned into its own
 * routable subtree (slot name omitted from the URL, like a route group), plus its
 * `default` fallback. Slot subtrees start fresh layout/boundary chains (the parent
 * layout wraps the slot as a named prop).
 */
async function scanSlots(
  ctx: ScanCtx,
  dir: string,
  entries: Deno.DirEntry[],
  segments: Segment[],
): Promise<Record<string, SlotRoutes> | undefined> {
  const slots: Record<string, SlotRoutes> = {};
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const slot = parseSlot(entry.name);
    if (!slot || slot === "children") continue;
    const slotDir = join(dir, entry.name);
    const slotOut: WalkOut = { pages: [], api: [] };
    await walk(ctx, slotDir, rootFrame(segments), slotOut);
    slotOut.pages.sort(bySpecificity);
    slots[slot] = { pages: slotOut.pages, default: await slotDefault(slotDir) };
  }
  return Object.keys(slots).length > 0 ? slots : undefined;
}

/** A slot's `default.*` fallback file, if any. */
async function slotDefault(slotDir: string): Promise<string | null> {
  for await (const e of Deno.readDir(slotDir)) {
    if (e.isFile && conv("default").test(e.name)) return join(slotDir, e.name);
  }
  return null;
}

/**
 * The frame for routes AT this level: special files here override the inherited ones.
 * Slots at this level are scoped to this level's layout, so a slot spans every route
 * beneath that layout.
 */
function levelFrame(
  ctx: ScanCtx,
  dir: string,
  entries: Deno.DirEntry[],
  frame: WalkFrame,
  slots: Record<string, SlotRoutes> | undefined,
): WalkFrame {
  const fileHere = (re: RegExp): string | null => {
    const found = entries.find((e) => e.isFile && re.test(e.name));
    return found ? join(dir, found.name) : null;
  };
  const layoutFile = fileHere(conv("layout"));
  const templateFile = fileHere(conv("template"));
  const boundaries: Boundaries = { ...frame.boundaries };
  for (const [key, name] of BOUNDARY_CONVENTIONS) {
    boundaries[key] = fileHere(conv(name)) ?? frame.boundaries[key];
  }
  const level: SegmentLevel = {
    depth: frame.segments.length,
    layout: layoutFile,
    template: templateFile,
    loading: fileHere(conv("loading")),
    error: fileHere(conv("error")),
  };
  const hasLevel = level.layout || level.template || level.loading || level.error;
  return {
    ...frame,
    layoutChain: layoutFile ? [...frame.layoutChain, layoutFile] : frame.layoutChain,
    layoutDepths: layoutFile ? [...frame.layoutDepths, frame.segments.length] : frame.layoutDepths,
    layoutSlotsChain: layoutFile ? [...frame.layoutSlotsChain, slots] : frame.layoutSlotsChain,
    templateChain: templateFile ? [...frame.templateChain, templateFile] : frame.templateChain,
    levels: hasLevel ? [...frame.levels, level] : frame.levels,
    boundaries,
    metaImages: nestedMetaImages(ctx, fileHere, frame),
  };
}

/**
 * Nested metadata images (opengraph-image / twitter-image). Recorded and inherited
 * (nearest wins) only for STATIC route segments — a dynamic segment (`[slug]`) can't be
 * served as a fixed URL, so it's skipped and the page keeps inheriting the nearest static
 * ancestor's image (or the root fallback). The root ("/") image is left to the root scan
 * + manifest.openGraphImage.
 */
function nestedMetaImages(
  ctx: ScanCtx,
  fileHere: (re: RegExp) => string | null,
  frame: WalkFrame,
): MetaImages {
  const segPath = patternToPath(frame.segments);
  const next: MetaImages = { ...frame.metaImages };
  // Root images are the RouteManifest's own fields; nested ones (static OR dynamic
  // segments — `[slug]/opengraph-image.tsx` is matched with params at request time) are
  // registered by route path.
  if (segPath === "/") return next;
  const ogFile = fileHere(conv("opengraph-image"));
  if (ogFile) {
    next.openGraphImage = segPath + OPENGRAPH_IMAGE_SUFFIX;
    ctx.imageRoutes.set(next.openGraphImage, ogFile);
  }
  const twFile = fileHere(conv("twitter-image"));
  if (twFile) {
    next.twitterImage = segPath + TWITTER_IMAGE_SUFFIX;
    ctx.imageRoutes.set(next.twitterImage, twFile);
  }
  return next;
}

/** The `page.*` and `route.*` files at this level. */
function collectRoutes(
  dir: string,
  entries: Deno.DirEntry[],
  here: WalkFrame,
  slots: Record<string, SlotRoutes> | undefined,
  out: WalkOut,
): void {
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (conv("page").test(entry.name)) {
      out.pages.push(pageRoute(join(dir, entry.name), here, slots));
    } else if (conv("route").test(entry.name)) {
      out.api.push({
        kind: "api",
        pattern: here.segments,
        routePath: patternToPath(here.segments),
        filePath: join(dir, entry.name),
      });
    }
  }
}

function pageRoute(
  filePath: string,
  f: WalkFrame,
  slots: Record<string, SlotRoutes> | undefined,
): PageRoute {
  return {
    kind: "page",
    pattern: f.segments,
    routePath: patternToPath(f.segments),
    filePath,
    layoutChain: f.layoutChain,
    layoutDepths: f.layoutDepths,
    layoutSlots: f.layoutSlotsChain.some((s) => s) ? f.layoutSlotsChain : undefined,
    templateChain: f.templateChain,
    levels: f.levels,
    loading: f.boundaries.loading,
    error: f.boundaries.error,
    notFound: f.boundaries.notFound,
    forbidden: f.boundaries.forbidden,
    unauthorized: f.boundaries.unauthorized,
    openGraphImage: f.metaImages.openGraphImage,
    twitterImage: f.metaImages.twitterImage,
    slots,
    intercept: f.intercept,
  };
}

/**
 * The frame for a child directory: an intercepting route walks in with the intercepted
 * target path; a route group keeps the same URL segments; anything else adds a segment.
 */
/** `_name` folders opt their subtree out of routing (Next.js "private folders"). */
export function isPrivateFolder(name: string): boolean {
  return name.startsWith("_");
}

function childFrame(here: WalkFrame, name: string): WalkFrame {
  const ic = parseIntercept(name);
  if (ic) return { ...here, segments: interceptTarget(here.segments, ic), intercept: ic };
  if (isRouteGroup(name)) return here;
  return { ...here, segments: [...here.segments, parseSegment(name)] };
}

/** The root-level metadata-file conventions and error pages (`RouteManifest` fields). */
type RootFiles = Pick<
  RouteManifest,
  | "rootNotFound"
  | "rootGlobalError"
  | "sitemap"
  | "robots"
  | "webManifest"
  | "favicon"
  | "openGraphImage"
  | "icon"
  | "appleIcon"
  | "twitterImage"
>;

/**
 * Root-level files applying to otherwise-unmatched routes / the whole tree, plus the
 * metadata-file conventions served at well-known URLs. First match wins per slot; an
 * unreadable `appDir` leaves every slot null.
 */
async function rootFiles(appDir: string): Promise<RootFiles> {
  const found: RootFiles = {
    rootNotFound: null,
    rootGlobalError: null,
    sitemap: null,
    robots: null,
    webManifest: null,
    favicon: null,
    openGraphImage: null,
    icon: null,
    appleIcon: null,
    twitterImage: null,
  };
  try {
    for await (const entry of Deno.readDir(appDir)) {
      if (entry.isFile) claimRootFile(found, entry.name, join(appDir, entry.name));
    }
  } catch {
    // appDir unreadable — leave null.
  }
  return found;
}

/** Root conventions by slot; matched in order, first file per slot wins. */
const ROOT_CONVENTIONS: Array<[keyof RootFiles, (name: string) => boolean]> = [
  ["rootNotFound", (n) => conv("not-found").test(n)],
  ["rootGlobalError", (n) => conv("global-error").test(n)],
  ["sitemap", (n) => conv("sitemap").test(n)],
  ["robots", (n) => conv("robots").test(n)],
  ["webManifest", (n) => conv("web-manifest").test(n)],
  ["favicon", (n) => n === "favicon.ico"],
  ["openGraphImage", (n) => conv("opengraph-image").test(n)],
  ["twitterImage", (n) => conv("twitter-image").test(n)],
];

function claimRootFile(found: RootFiles, name: string, path: string): void {
  for (const [slot, matches] of ROOT_CONVENTIONS) {
    if (!found[slot] && matches(name)) found[slot] = path;
  }
  // apple-icon must be checked before icon (its name also contains "icon").
  if (!found.appleIcon && conv("apple-icon").test(name)) found.appleIcon = path;
  else if (!found.icon && conv("icon").test(name)) found.icon = path;
}

/**
 * Read the `"use client"` / `"use server"` directive of every component module
 * referenced by the manifest. Each file is read at most once (paths are unioned
 * first); modules with no directive are omitted from the returned map.
 */
async function scanDirectives(manifest: RouteManifest): Promise<Map<string, Directive>> {
  const paths = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (p) paths.add(p);
  };
  for (const page of manifest.pages) {
    add(page.filePath);
    page.layoutChain.forEach(add);
    page.templateChain.forEach(add);
    add(page.loading);
    add(page.error);
    add(page.notFound);
    add(page.forbidden);
    add(page.unauthorized);
    const slotMaps = [page.slots, ...(page.layoutSlots ?? [])];
    for (const map of slotMaps) {
      if (!map) continue;
      for (const slot of Object.values(map)) {
        add(slot.default);
        for (const sp of slot.pages) add(sp.filePath);
      }
    }
  }
  add(manifest.rootNotFound);
  add(manifest.rootGlobalError);

  const directives = new Map<string, Directive>();
  await Promise.all(
    [...paths].map(async (p) => {
      const d = await readDirective(p);
      if (d) directives.set(p, d);
    }),
  );
  return directives;
}

/** Render a segment list as a display path like "/blog/[slug]". */
function patternToPath(segments: Segment[]): string {
  if (segments.length === 0) return "/";
  return "/" + segments.map(segmentToString).join("/");
}

function segmentToString(seg: Segment): string {
  switch (seg.kind) {
    case "static":
      return seg.value;
    case "dynamic":
      return `[${seg.value}]`;
    case "catchAll":
      return `[...${seg.value}]`;
    case "optionalCatchAll":
      return `[[...${seg.value}]]`;
  }
}
