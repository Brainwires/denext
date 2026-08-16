/**
 * next-compat page pipeline: build a page whose components import **real npm
 * React libraries** into a server (SSR) bundle and a client (hydration) bundle,
 * both running on denext's single React (via {@link bundleNextCompat}). This is
 * the wiring that lets `denext build`/`dev` serve a Next-style app on denext.
 *
 * A next-compat page is a plain React component (default export) taking
 * `{ params, searchParams }` — exactly the denext page contract, but its subtree
 * may pull in npm Radix/shadcn/etc.
 *
 * @module
 */

import { join, relative } from "@std/path";
import {
  bundleNextCompat,
  bundleNextCompatModules,
  prebuildDenextRuntime,
  toImportUrl,
  withEsbuild,
} from "./next-compat.ts";
import { frameworkRoot } from "./bundle.ts";

/** A built next-compat page: paths to its server + client bundles. */
export interface BuiltNextCompatPage {
  /** Route path (e.g. `/about`). */
  routePath: string;
  /** Absolute path to the SSR bundle (exports `render(props)`). */
  serverBundle: string;
  /** Absolute path to the client hydration bundle. */
  clientBundle: string;
}

/** A page to build: its route + the source module (default-export component). */
export interface NextCompatPageInput {
  /** Route path. */
  routePath: string;
  /** Absolute path to the page source (`.tsx`). */
  filePath: string;
  /**
   * Absolute paths to the App Router layout chain wrapping this page, outermost
   * first (e.g. `[app/layout.tsx, app/(marketing)/layout.tsx]`). Each layout is a
   * default-export component receiving `{ children, params }`.
   */
  layouts?: string[];
}

/** Options for {@link buildNextCompatPages}. */
export interface BuildNextCompatOptions {
  /** Project directory (contains `deno.json` + `node_modules`). */
  projectDir: string;
  /** Project `deno.json` used to resolve app + npm deps. */
  configPath: string;
  /** Output directory (bundles are written under `outDir/next-compat/`). */
  outDir: string;
  /** Pages to build. */
  pages: NextCompatPageInput[];
  /** Minify (production). */
  minify?: boolean;
  /** Enable the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
}

// ---------------------------------------------------------------------------
// Server-module re-export bundles (for the MAIN denext build/SSR pipeline)
// ---------------------------------------------------------------------------

/** Options for {@link buildNextCompatModules}. */
export interface BuildNextCompatModulesOptions {
  /** Project directory (contains `deno.json` + `node_modules`). */
  projectDir: string;
  /** Project `deno.json` used to resolve app + npm deps. */
  configPath: string;
  /** Output directory (bundles land under `outDir/server/`). */
  outDir: string;
  /** Absolute paths of the route SOURCE modules to rewrite (page/layout/…). */
  modules: string[];
  /** Minify (production). */
  minify?: boolean;
  /** Enable the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
}

/** Stable, filesystem-safe id for a source module (unique per project-relative path). */
function moduleId(projectDir: string, absPath: string): string {
  return relative(projectDir, absPath)
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Build react→denext-rewritten SSR bundles for a set of route source modules,
 * each RE-EXPORTING the source module's shape (`default` + named exports:
 * `metadata`/`generateMetadata`/segment-config/…) rather than wrapping it in a
 * `render()`. The main SSR loader ({@link createNextCompatServerLoader}) returns
 * these instead of the raw source, so the whole route subtree — including npm
 * React libraries imported inside it — runs on denext's single React.
 *
 * All modules are bundled in ONE code-split pass ({@link bundleNextCompatModules})
 * so they share one denext runtime chunk → a single denext instance at runtime.
 *
 * Callers manage the esbuild lifecycle (dev keeps the service warm; a one-shot
 * build should wrap in {@link withEsbuild}). The denext runtime is prebuilt once
 * per call into `outDir/server/runtime/`.
 *
 * SSR bundles inline a prebuilt denext runtime; the hook dispatcher lives on
 * globalThis (see `src/runtime/hooks.ts`), so this bundled denext copy shares the
 * one dispatcher denext's source SSR renderer installs → hooks in the rendered
 * (npm React) components resolve correctly.
 *
 * @param options Build configuration.
 * @returns Map of absolute source path → absolute server bundle path.
 */
export async function buildNextCompatModules(
  options: BuildNextCompatModulesOptions,
): Promise<Map<string, string>> {
  const outRoot = join(options.outDir, "server");
  const runtimeDir = join(outRoot, "runtime");
  const entriesDir = join(outRoot, ".entries");
  await Deno.mkdir(entriesDir, { recursive: true });
  await prebuildDenextRuntime({
    outDir: runtimeDir,
    configPath: options.configPath,
    classComponents: options.classComponents,
  });

  // One re-export entry per source module.
  const entryPoints: Record<string, string> = {};
  const idToSrc = new Map<string, string>();
  for (const abs of options.modules) {
    const id = moduleId(options.projectDir, abs);
    const entryPath = join(entriesDir, `${id}.tsx`);
    await Deno.writeTextFile(
      entryPath,
      `export * from ${JSON.stringify(abs)};\n` +
        `export { default } from ${JSON.stringify(abs)};\n`,
    );
    entryPoints[id] = entryPath;
    idToSrc.set(id, abs);
  }

  await bundleNextCompatModules({
    entryPoints,
    runtimeDir,
    outdir: outRoot,
    configPath: options.configPath,
    platform: "deno",
    minify: options.minify,
    classComponents: options.classComponents,
    absWorkingDir: options.projectDir,
  });

  const map = new Map<string, string>();
  for (const [id, abs] of idToSrc) {
    map.set(abs, join(outRoot, `${id}.js`));
  }
  return map;
}

/** A compat client entry to build: an output id + its generated entry source. */
export interface NextCompatClientEntry {
  /** Output base name (route id) → `${id}.js` in the client dir. */
  id: string;
  /** Generated hydration entry source (e.g. from `generateRouteEntry`). */
  source: string;
}

/** Options for {@link buildNextCompatClientEntries}. */
export interface BuildNextCompatClientOptions {
  projectDir: string;
  configPath: string;
  /** Output directory for the prebuilt browser runtime (e.g. `.denext/server`). */
  outDir: string;
  /** Directory the client `${id}.js` + shared chunks are written to. */
  clientDir: string;
  entries: NextCompatClientEntry[];
  minify?: boolean;
  classComponents?: boolean;
}

/**
 * Build react→denext-rewritten CLIENT hydration bundles for compat routes, in one
 * code-split pass so every route's client entry shares the one denext runtime
 * chunk (single denext instance in the browser too). Mirrors the native
 * `bundleRoutes` output shape (`${id}.js` + shared chunks in the client dir) so
 * the prod server serves and references them identically.
 *
 * @param options Build configuration (reuses a prebuilt runtime dir).
 */
export async function buildNextCompatClientEntries(
  options: BuildNextCompatClientOptions,
): Promise<void> {
  if (options.entries.length === 0) return;
  // The browser bundle can't leave denext external (no runtime import map), so
  // inline a prebuilt denext runtime shared across all client entries (splitting).
  const runtimeDir = join(options.outDir, "client-runtime");
  await prebuildDenextRuntime({
    outDir: runtimeDir,
    configPath: options.configPath,
    classComponents: options.classComponents,
  });
  const entriesDir = join(options.clientDir, ".entries");
  await Deno.mkdir(entriesDir, { recursive: true });
  const entryPoints: Record<string, string> = {};
  for (const { id, source } of options.entries) {
    const entryPath = join(entriesDir, `${id}.tsx`);
    await Deno.writeTextFile(entryPath, source);
    entryPoints[id] = entryPath;
  }
  await bundleNextCompatModules({
    entryPoints,
    runtimeDir,
    outdir: options.clientDir,
    configPath: options.configPath,
    platform: "browser",
    minify: options.minify,
    classComponents: options.classComponents,
    absWorkingDir: options.projectDir,
  });
  await Deno.remove(entriesDir, { recursive: true }).catch(() => {});
}

/** Import lines + a `wrap(props)` expression composing the layout chain over the page. */
function composition(filePath: string, layouts: string[]): { imports: string; tree: string } {
  // Import the page + layouts by absolute path (esbuild resolves paths, not file://).
  const imports = [
    `import Page from ${JSON.stringify(filePath)};`,
    ...layouts.map((p, i) => `import Layout${i} from ${JSON.stringify(p)};`),
  ].join("\n");
  // Wrap innermost -> outermost: Layout0(Layout1(...(Page))).
  let tree = "h(Page, props)";
  for (let i = layouts.length - 1; i >= 0; i--) {
    tree = `h(Layout${i}, { children: ${tree}, params: props.params })`;
  }
  return { imports, tree };
}

/** Generate the SSR entry for a page: render its (layout-wrapped) tree to HTML. */
function serverEntry(filePath: string, layouts: string[]): string {
  const { imports, tree } = composition(filePath, layouts);
  return `${imports}
import { h } from "denext/jsx-runtime";
import { renderToString } from "denext/ssr";
export async function render(rawProps) {
  const props = rawProps ?? {};
  return await renderToString(${tree});
}
`;
}

/** Generate the client hydration entry for a page (same layout-wrapped tree). */
function clientEntry(filePath: string, mountId: string, layouts: string[]): string {
  const { imports, tree } = composition(filePath, layouts);
  return `${imports}
import { h } from "denext/jsx-runtime";
import { hydrateRoot } from "denext/client";
const el = document.getElementById(${JSON.stringify(mountId)});
const props = (globalThis.__DENEXT_PROPS__ ?? {});
if (el) hydrateRoot(el, ${tree});
`;
}

/** The DOM id the SSR HTML is mounted under (and the client hydrates). */
export const MOUNT_ID = "__denext_root";

/**
 * Build each page into a server + client bundle on denext's single React.
 * Prebuilds the denext runtime once and reuses it across pages; always releases
 * the esbuild service (even on error).
 *
 * @param options Build configuration.
 * @returns The built pages.
 */
export function buildNextCompatPages(
  options: BuildNextCompatOptions,
): Promise<BuiltNextCompatPage[]> {
  return withEsbuild(async () => {
    const outRoot = join(options.outDir, "next-compat");
    await Deno.mkdir(outRoot, { recursive: true });
    const runtimeDir = await prebuildDenextRuntime({
      outDir: join(outRoot, ".runtime"),
      frameworkRoot: frameworkRoot(),
      configPath: join(frameworkRoot(), "deno.json"),
      classComponents: options.classComponents,
    });
    const tmp = join(outRoot, ".entries");
    await Deno.mkdir(tmp, { recursive: true });

    const built: BuiltNextCompatPage[] = [];
    for (const page of options.pages) {
      const id = routeToId(page.routePath);
      const serverEntryPath = join(tmp, `${id}.server.tsx`);
      const clientEntryPath = join(tmp, `${id}.client.tsx`);
      const layouts = page.layouts ?? [];
      await Deno.writeTextFile(serverEntryPath, serverEntry(page.filePath, layouts));
      await Deno.writeTextFile(clientEntryPath, clientEntry(page.filePath, MOUNT_ID, layouts));

      const serverBundle = join(outRoot, `${id}.server.js`);
      const clientBundle = join(outRoot, `${id}.client.js`);
      await bundleNextCompat({
        entry: serverEntryPath,
        runtimeDir,
        outfile: serverBundle,
        configPath: options.configPath,
        platform: "deno",
        denoLoader: false,
        absWorkingDir: options.projectDir,
        minify: options.minify,
        classComponents: options.classComponents,
      });
      await bundleNextCompat({
        entry: clientEntryPath,
        runtimeDir,
        outfile: clientBundle,
        configPath: options.configPath,
        platform: "browser",
        denoLoader: false,
        absWorkingDir: options.projectDir,
        minify: options.minify,
        classComponents: options.classComponents,
      });
      built.push({ routePath: page.routePath, serverBundle, clientBundle });
    }
    return built;
  });
}

/** Turn a route path into a filesystem-safe bundle id (`/` → `index`). */
export function routeToId(routePath: string): string {
  const clean = routePath.replace(/^\/|\/$/g, "").replace(/[^\w-]/g, "_");
  return clean === "" ? "index" : clean;
}

/** The render function a server bundle exports. */
export type PageRenderFn = (props?: unknown) => Promise<string>;

/**
 * SSR a built next-compat page to a full HTML document: server-render the body,
 * embed the props, and reference the client hydration bundle.
 *
 * @param page The built page.
 * @param props Props passed to the page (params/searchParams).
 * @param clientSrc URL path the client bundle is served at.
 * @returns The HTML document.
 */
export async function renderNextCompatPage(
  page: BuiltNextCompatPage,
  props: Record<string, unknown>,
  clientSrc: string,
): Promise<string> {
  const mod = await import(toImportUrl(page.serverBundle)) as { render: PageRenderFn };
  const body = await mod.render(props);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<div id="${MOUNT_ID}">${body}</div>` +
    `<script>globalThis.__DENEXT_PROPS__=${JSON.stringify(props)}</script>` +
    `<script type="module" src="${clientSrc}"></script>` +
    `</body></html>`;
}
