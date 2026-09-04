// SPA mode: bundle the single entry (native `deno bundle`, or the next-compat esbuild
// react→denext rewrite) and extract its stylesheet. Shared by build, export and dev.

import { join, toFileUrl } from "@std/path";
import { nodeResolveEnabled, type SpaConfig } from "../../server/config.ts";
import { bundleSourceFiles, writeBundleOutput } from "../bundle.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "../css.ts";
import { buildNextCompatClientEntries } from "../next-compat-build.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { stopNextCompat } from "../next-compat.ts";
import type { ProjectPaths } from "../paths.ts";
import { spaRefreshPlugin } from "../spa-refresh-plugin.ts";
import { tailwindPaths } from "../tailwind.ts";
import { CLIENT_PREFIX, ENTRY_FILE, generateSpaEntry, STYLE_FILE } from "./shared.ts";

type DependencyGroups = Partial<
  Record<
    "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies",
    Record<string, string>
  >
>;

/**
 * Package names whose version in the project's `package.json` is a pnpm
 * `catalog:` / `workspace:*` reference. The esbuild deno-loader's resolver can't
 * parse those version strings (the real version lives in `pnpm-workspace.yaml`),
 * so denext front-runs the loader and resolves these packages straight from
 * `node_modules`. Empty for a non-pnpm-catalog app (or no/invalid `package.json`).
 */
export async function pnpmCatalogPackages(projectDir: string): Promise<string[]> {
  let pkg: DependencyGroups;
  try {
    pkg = JSON.parse(await Deno.readTextFile(join(projectDir, "package.json")));
  } catch {
    return []; // no/invalid package.json → not a pnpm-catalog app
  }
  const groups = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ];
  const names: string[] = [];
  for (const group of groups) {
    for (const [name, v] of Object.entries(group ?? {})) {
      if (typeof v === "string" && (v.startsWith("catalog:") || v.startsWith("workspace:"))) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * The esbuild `define` map for a SPA's compile-time `import.meta.env` values
 * (`spa.env`) — the Vite-`define` analogue. Only meaningful on the next-compat
 * (esbuild) path.
 */
function spaDefines(spa: SpaConfig, dev: boolean): Record<string, string> {
  // Vite's built-in `import.meta.env` values, with correct types (DEV/PROD/SSR are
  // booleans, not strings) so `if (import.meta.env.DEV)` etc. behave as in Vite.
  const out: Record<string, string> = {
    "import.meta.env.MODE": JSON.stringify(dev ? "development" : "production"),
    "import.meta.env.DEV": String(dev),
    "import.meta.env.PROD": String(!dev),
    "import.meta.env.SSR": "false",
    "import.meta.env.BASE_URL": JSON.stringify("/"),
  };
  // App-provided values (`spa.env`) — strings — override / extend the built-ins.
  for (const [key, value] of Object.entries(spa.env ?? {})) {
    out[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  return out;
}

/** The app's CSS assets, crawled from the SPA entry (the whole app's import root). */
function spaCss(paths: ProjectPaths, entryPath: string, minify: boolean): Promise<AppCss | null> {
  return buildAppCss({
    projectDir: paths.projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify,
    // Crawling the entry finds `.scss`/`.css` in sibling workspace packages a monorepo
    // app pulls in (e.g. excalidraw's `../packages/*`), which the `projectDir` walk
    // alone can't reach.
    entryFiles: [entryPath],
    tailwind: tailwindPaths(paths.projectDir, paths.config?.tailwind),
  });
}

/**
 * next-compat path: when the app uses npm React (node_modules/react present, or
 * `compatibilityMode` forced), bundle through the esbuild react→denext rewrite so the
 * npm libraries' own `import "react"` also resolve to denext's single React — the "two
 * Reacts" fix a plain `deno bundle` can't do. This is also where the `import.meta.env`
 * (`spa.env`) define applies. Emits `index.js` + shared chunks.
 */
async function bundleCompatSpa(
  paths: ProjectPaths,
  entrySource: string,
  clientDir: string,
  css: AppCss | null,
  minify: boolean,
  dev: boolean,
): Promise<void> {
  const spa = paths.config!.spa!;
  await buildNextCompatClientEntries({
    projectDir: paths.projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    clientDir,
    entries: [{ id: "index", source: entrySource }],
    minify,
    classComponents: paths.config?.classComponents ?? true,
    define: spaDefines(spa, dev),
    // Vite-style asset imports (?url/?worker/.wasm/…) → files under clientDir, URLs
    // prefixed with the path the SPA servers already serve them at.
    assets: { publicPath: CLIENT_PREFIX },
    // pnpm catalog:/workspace: deps the esbuild deno-loader can't resolve — denext
    // resolves these straight from node_modules (front-runs the loader).
    catalogPackages: await pnpmCatalogPackages(paths.projectDir),
    // Resolve ALL app npm deps from node_modules (supersedes the narrow catalog set) —
    // the seamless-migration path. Default-on; `experimental.nodeResolve: false` opts out.
    resolveAllNodeModules: nodeResolveEnabled(paths.config),
    // App-configured MDX plugins (denext.config `mdx`) for `.mdx`/`.md` sources.
    mdxOptions: paths.config?.mdx,
    // Redirect stylesheet imports to their shims — covers `.scss` in sibling workspace
    // packages the esbuild default resolver would otherwise choke on.
    cssImportMap: css?.importMap,
    // Dev only: instrument each app module with Fast Refresh family registrations
    // (front-runs the deno-loader's onLoad). Omitted in prod → nothing extra ships.
    extraPlugins: dev ? [spaRefreshPlugin(paths.projectDir)] : undefined,
  });
  // Tear the esbuild service down only for a one-shot build/export. In dev this runs on
  // every rebuild, so stopping it would force a cold re-init each keystroke (and could
  // kill the process-shared service mid-flight); the dev server stops it once on shutdown.
  if (!dev) await stopNextCompat();
}

/**
 * Bundle the SPA entry and extract its stylesheet. Writes the entry bundle (+ split
 * chunks) into `clientDir` as `index.js`, and — when the app has CSS reachable from the
 * entry graph — `index.css`.
 *
 * @returns Whether a stylesheet was emitted (so the caller can `<link>` it).
 */
export async function bundleSpaInto(
  paths: ProjectPaths,
  entryPath: string,
  clientDir: string,
  minify: boolean,
  dev = false,
): Promise<{ hasStyles: boolean }> {
  const spa = paths.config!.spa!;
  const css = await spaCss(paths, entryPath, minify);
  const entrySource = generateSpaEntry(toFileUrl(entryPath).href, dev);
  const compat = await detectNextCompat(paths);
  // `spa.env` and Vite-style asset imports (`?url`/`?worker`) only apply on the compat
  // (esbuild) path; a denext-native SPA bundles with plain `deno bundle`. Warn rather
  // than silently ignore, so the footgun surfaces.
  if (!compat && spa.env && Object.keys(spa.env).length > 0) {
    console.warn(
      "  denext: `spa.env` is ignored — it applies only when the app uses npm React " +
        "(node_modules/react, or set `compatibilityMode: true`).",
    );
  }
  if (compat) {
    await bundleCompatSpa(paths, entrySource, clientDir, css, minify, dev);
  } else {
    // denext-native path: plain `deno bundle` (fast, no esbuild). The app already
    // imports denext directly, so there is no react alias to rewrite.
    const bundle = await bundleSourceFiles(entrySource, {
      configPath: paths.configPath,
      minify,
      importMap: css?.importMap,
      dev,
    });
    await writeBundleOutput(clientDir, bundle, ENTRY_FILE);
  }
  if (!css) return { hasStyles: false };
  const text = await extractRouteCss([entryPath], css);
  if (text.trim().length === 0) return { hasStyles: false };
  await Deno.writeTextFile(join(clientDir, STYLE_FILE), text);
  return { hasStyles: true };
}
