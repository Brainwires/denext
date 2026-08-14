// Browser bundling via Deno's own `deno bundle` — no third-party bundler.
//
// For each page route we generate a single entry module that imports the page,
// its layouts, and the client runtime, then hydrates. Bundling the whole thing
// as one module graph keeps shared module identity (e.g. context symbols)
// intact, which separate dynamic imports would break.

import { basename, dirname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import type { PageRoute } from "../router/manifest.ts";
import type { BoundaryManifest } from "./module-graph.ts";

/** Absolute path to the denext framework root (contains deno.json, mod.ts). */
export function frameworkRoot(): string {
  return fromFileUrl(new URL("../../", import.meta.url));
}

/**
 * Resolve the `deno` executable to shell out to for bundling.
 *
 * Under `deno run`, `Deno.execPath()` is the deno binary. But in a `deno
 * compile`d denext binary it is `denext` itself — running `denext bundle` would
 * just print help. Resolution order:
 *   1. `DENO_BIN` env var (explicit override)
 *   2. `Deno.execPath()` when it is actually `deno`
 *   3. the standard install location `~/.deno/bin/deno`
 *   4. `deno` on PATH (last resort)
 */
export function denoExecutable(): string {
  const fromEnv = Deno.env.get("DENO_BIN");
  if (fromEnv) return fromEnv;

  const exec = Deno.execPath();
  const base = basename(exec).toLowerCase().replace(/\.exe$/, "");
  if (base === "deno") return exec;

  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (home) {
    const bin = Deno.build.os === "windows" ? "deno.exe" : "deno";
    const candidate = join(home, ".deno", "bin", bin);
    try {
      Deno.statSync(candidate);
      return candidate;
    } catch {
      // not there; fall through
    }
  }
  return "deno";
}

/** Minimum Deno major version providing the `deno bundle` subcommand denext uses. */
const MIN_DENO_MAJOR = 2;

let bundleSupport: Promise<void> | undefined;

/**
 * Verify the resolved `deno` exists and is new enough for the (experimental)
 * `deno bundle` subcommand, with a clear, actionable error otherwise. Runs the
 * check once per process (memoized). `deno bundle` is an evolving subcommand;
 * this fails fast on a missing/old binary instead of a cryptic bundle error, and
 * the build-smoke test guards against output-shape drift.
 */
export function ensureBundleSupport(): Promise<void> {
  // Memoize only a SUCCESSFUL probe. Caching a rejection would permanently brick
  // a long-lived dev server after one transient spawn failure (or after the user
  // fixes their Deno install / sets DENO_BIN) — reset so the next call re-probes.
  if (!bundleSupport) {
    bundleSupport = probeBundleSupport().catch((err) => {
      bundleSupport = undefined;
      throw err;
    });
  }
  return bundleSupport;
}

async function probeBundleSupport(): Promise<void> {
  const deno = denoExecutable();
  let versionText: string;
  try {
    const out = await new Deno.Command(deno, {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    versionText = new TextDecoder().decode(out.stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `denext: could not run \`${deno} --version\` to bundle client code (${msg}). ` +
        `Install Deno ${MIN_DENO_MAJOR}.x, or set DENO_BIN to a compatible deno binary.`,
    );
  }
  const match = versionText.match(/deno\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    throw new Error(
      `denext: unexpected \`deno --version\` output while checking bundle support:\n${versionText}\n` +
        `denext needs Deno ${MIN_DENO_MAJOR}.x (the \`deno bundle\` subcommand). Set DENO_BIN if needed.`,
    );
  }
  if (Number(match[1]) < MIN_DENO_MAJOR) {
    throw new Error(
      `denext: bundling requires Deno ${MIN_DENO_MAJOR}.x (the \`deno bundle\` subcommand); ` +
        `found ${match[0]}. Upgrade Deno, or set DENO_BIN to a Deno ${MIN_DENO_MAJOR}.x binary.`,
    );
  }
}

/**
 * The route's own top-level source files (page, layouts, templates, loading,
 * error, and slot pages) — the crawl roots for discovering a route's CSS.
 */
export function routeSourceFiles(route: PageRoute): string[] {
  const files = [route.filePath, ...route.layoutChain, ...route.templateChain];
  if (route.loading) files.push(route.loading);
  if (route.error) files.push(route.error);
  for (const slot of Object.values(route.slots ?? {})) {
    if (slot.default) files.push(slot.default);
    for (const p of slot.pages) files.push(p.filePath);
  }
  return files;
}

/** Generate the browser entry source that hydrates a single page route. */
export function generateRouteEntry(route: PageRoute): string {
  const pageUrl = toFileUrl(route.filePath).href;
  const layoutImports = route.layoutChain
    .map((p, i) => `import Layout${i} from ${JSON.stringify(toFileUrl(p).href)};`)
    .join("\n");
  const templateImports = route.templateChain
    .map((p, i) => `import Template${i} from ${JSON.stringify(toFileUrl(p).href)};`)
    .join("\n");

  const specialImports: string[] = [];
  if (route.loading) {
    specialImports.push(
      `import Loading from ${JSON.stringify(toFileUrl(route.loading).href)};`,
    );
  }
  if (route.error) {
    specialImports.push(
      `import ErrorComp from ${JSON.stringify(toFileUrl(route.error).href)};`,
    );
  }
  // Parallel-route slots: for the isomorphic client bundle, render each slot's
  // `default` (or its most-specific page). Per-URL slot matching + intercepts are
  // resolved on the server (SSR/Flight); interactive slots use the Flight path.
  const slotEntries = Object.entries(route.slots ?? {})
    .map(([name, slot]) => [name, slot.default ?? slot.pages[0]?.filePath] as const)
    .filter(([, file]) => !!file);
  const slotImports = slotEntries
    .map(([, file], i) => `import Slot${i} from ${JSON.stringify(toFileUrl(file!).href)};`)
    .join("\n");
  const slotProps = slotEntries
    .map(([name], i) => `${JSON.stringify(name)}: h(Slot${i}, { params: data.params })`)
    .join(", ");

  // Wrap innermost -> outermost, mirroring the server's composition.
  let wrap = "let tree = h(Page, { params: data.params, searchParams: sp });\n";
  if (route.loading) {
    wrap += "  tree = h(Suspense, { fallback: h(Loading, {}), children: tree });\n";
  }
  if (route.error) {
    wrap += "  tree = h(ErrorBoundary, { fallback: ErrorComp, children: tree });\n";
  }
  for (let i = route.templateChain.length - 1; i >= 0; i--) {
    wrap += `  tree = h(Template${i}, { children: tree, params: data.params });\n`;
  }
  const innermostLayout = route.layoutChain.length - 1;
  for (let i = innermostLayout; i >= 0; i--) {
    // The innermost layout also receives the parallel-route slot props.
    const extra = i === innermostLayout && slotProps ? `, ${slotProps}` : "";
    const depth = route.layoutDepths?.[i] ?? 0;
    wrap += `  tree = h(Layout${i}, { children: tree, params: data.params${extra} });\n`;
    // Provide the layout's segment depth so useSelectedLayoutSegment(s) resolves
    // relative to its level (mirrors the server's wrapLayouts).
    wrap +=
      `  tree = provideLayoutSegments({ pathname: location.pathname, depth: ${depth} }, tree);\n`;
  }

  return `// denext generated route entry — do not edit.
import { startClient, Suspense, ErrorBoundary, provideLayoutSegments } from "denext/client";
import { h } from "denext/jsx-runtime";
import Page from ${JSON.stringify(pageUrl)};
${layoutImports}
${templateImports}
${slotImports}
${specialImports.join("\n")}

function main() {
  const el = document.getElementById("__denext");
  const dataEl = document.getElementById("__denext_data");
  if (!el) return;
  const data = dataEl
    ? JSON.parse(dataEl.textContent || "{}")
    : { params: {}, searchParams: "" };
  const sp = new URLSearchParams(data.searchParams || "");
  ${wrap}
  try {
    startClient(el, tree);
  } catch (err) {
    // Async (server-only) components can't hydrate; leave SSR markup as-is.
    console.warn("denext: skipping hydration for this route:", err && err.message);
  }
}

main();
`;
}

/**
 * Generate the browser entry for a Flight route. Unlike {@link generateRouteEntry}
 * (which statically imports the whole page tree), this imports ONLY the app's
 * `"use client"` modules, builds a registry keyed by client-reference id, reads
 * the `#__denext_flight` island, and hydrates the reconstructed island tree.
 * Server-component code never enters this bundle.
 *
 * @param boundary The app's boundary manifest (its `client` modules are imported).
 * @returns The generated entry module source.
 */
export function generateFlightEntry(boundary: BoundaryManifest): string {
  const entries = [...boundary.client.entries()];
  const imports = entries
    .map(([, ref], i) => `import * as M${i} from ${JSON.stringify(ref.url)};`)
    .join("\n");
  const registrations = entries
    .map(([clientId], i) => `  reg(M${i}, ${JSON.stringify(clientId)});`)
    .join("\n");

  return `// denext generated Flight entry — do not edit.
import { startClient, parseFlight, setFlightParser } from "denext/client";

const registry = new Map();
function reg(mod, clientId) {
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === "function") registry.set(clientId + "#" + k, mod[k]);
  }
}
${imports}
${registrations}

// Register the soft-nav Flight parser so a client navigation to another Flight
// route reconstructs its tree through this app-wide registry (no bundle re-run).
setFlightParser((flight) => parseFlight(flight, registry));

function main() {
  const el = document.getElementById("__denext");
  const flightEl = document.getElementById("__denext_flight");
  if (!el || !flightEl) return;
  let flight;
  try {
    flight = JSON.parse(flightEl.textContent || "null");
  } catch {
    return;
  }
  if (flight == null) return;
  const tree = parseFlight(flight, registry);
  try {
    startClient(el, tree);
  } catch (err) {
    console.warn("denext: flight hydration failed:", err && err.message);
  }
}

main();
`;
}

export interface BundleOptions {
  configPath: string;
  minify?: boolean;
  /**
   * Extra import-map redirects merged into the bundle's config `imports` (keyed
   * by full module URL). Used to replace `"use server"` modules with client
   * stubs so server code never enters the browser bundle.
   */
  importMap?: Record<string, string>;
}

/**
 * Generate a browser stub module for a `"use server"` module: each export becomes
 * a client dispatch stub (POSTs to the action endpoint). Used as the redirect
 * target so the real server module never reaches the browser bundle.
 *
 * @param moduleId The server module's stable id.
 * @param exports The server module's exported symbol names.
 * @returns The stub module source.
 */
export function generateServerStub(moduleId: string, exports: string[]): string {
  const lines = exports.map((name) =>
    name === "default"
      ? `export default clientActionStub(${JSON.stringify(moduleId + "#default")});`
      : `export const ${name} = clientActionStub(${JSON.stringify(moduleId + "#" + name)});`
  );
  return `import { clientActionStub } from "denext/client";\n${lines.join("\n")}\n`;
}

/**
 * Bundle the app-wide Flight entry, redirecting every `"use server"` module to a
 * generated client stub so server-only code is stripped from the browser bundle.
 *
 * @param boundary The app's boundary manifest (client modules + server modules
 *   with their `exports`).
 * @param opts Bundle config + minify flag.
 * @returns The bundled Flight entry (entry file + any dynamic-import chunks).
 */
export async function bundleFlightEntry(
  boundary: BoundaryManifest,
  opts: BundleOptions,
): Promise<BundleOutput> {
  const stubDir = await Deno.makeTempDir({ prefix: "denext_stubs_" });
  const importMap: Record<string, string> = {};
  try {
    for (const [moduleId, ref] of boundary.server) {
      const stubPath = join(stubDir, moduleId.replace(/[^a-z0-9]/gi, "_") + ".ts");
      await Deno.writeTextFile(stubPath, generateServerStub(moduleId, ref.exports));
      importMap[ref.url] = toFileUrl(stubPath).href;
    }
    return await bundleSourceFiles(generateFlightEntry(boundary), {
      configPath: opts.configPath,
      minify: opts.minify,
      // Merge any CSS redirects from the caller with the server-stub redirects.
      importMap: { ...opts.importMap, ...importMap },
    });
  } finally {
    await Deno.remove(stubDir, { recursive: true });
  }
}

/**
 * The result of bundling one entry: its entry file plus any split chunks.
 *
 * With code splitting enabled, a `dynamic()` import (or any dynamic `import()`)
 * becomes a separate chunk file; shared modules are hoisted into a common chunk
 * that both the entry and the lazy chunks import, so module identity (context
 * symbols, registries) is preserved. All files must be served from the same
 * directory so the entry's relative chunk imports resolve.
 */
export interface BundleOutput {
  /** Basename of the entry file within {@linkcode files} (e.g. `"entry.js"`). */
  entry: string;
  /** Every emitted JS file (entry + split chunks) keyed by basename. */
  files: Map<string, string>;
}

/** Convenience: the entry file's JavaScript source from a {@linkcode BundleOutput}. */
export function entryCode(output: BundleOutput): string {
  const code = output.files.get(output.entry);
  if (code === undefined) {
    throw new Error(`bundle output is missing its entry file "${output.entry}"`);
  }
  return code;
}

/**
 * Resolve an import map's relative specifiers (`./x`, `../x`) to absolute file
 * URLs against `baseDir`, so the map keeps working when copied into a merged
 * config elsewhere. Bare specifiers (jsr:, npm:, https:, and already-absolute
 * file URLs) pass through unchanged.
 */
function absolutizeImports(
  imports: Record<string, string> | undefined,
  baseDir: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(imports ?? {})) {
    // Resolve relative (`./`, `../`) and root-relative (`/`) path values to
    // absolute file URLs; bare specifiers (jsr:, npm:, https:, data:, file://)
    // and already-absolute URLs pass through unchanged.
    const isPath = value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
    out[key] = isPath ? toFileUrl(resolve(baseDir, value)).href : value;
  }
  return out;
}

/**
 * Resolve the config path to pass to `deno bundle`: the caller's config, or —
 * when import-map redirects are supplied — a merged config in `tmpDir` that
 * extends the base `imports` with them (deno bundle takes a single config).
 */
async function prepareConfig(tmpDir: string, opts: BundleOptions): Promise<string> {
  if (!opts.importMap || Object.keys(opts.importMap).length === 0) return opts.configPath;
  const base = JSON.parse(await Deno.readTextFile(opts.configPath));
  // The merged config lives in a temp dir, so any relative import-map paths in
  // the base config (e.g. `denext` -> `../../mod.ts`) must be resolved to
  // absolute against the ORIGINAL config's directory or they break.
  base.imports = {
    ...absolutizeImports(base.imports, dirname(opts.configPath)),
    ...opts.importMap,
  };
  const configPath = join(tmpDir, "deno.merged.json");
  await Deno.writeTextFile(configPath, JSON.stringify(base));
  return configPath;
}

/**
 * Shell out to `deno bundle` over one or more entry files (code splitting on),
 * returning every emitted `.js` file keyed by basename. `--code-splitting`
 * requires `--outdir` (it cannot stream to stdout); with multiple entries, any
 * module imported by more than one is hoisted into a shared chunk.
 */
async function runDenoBundle(
  entryPaths: string[],
  configPath: string,
  outDir: string,
  minify: boolean | undefined,
): Promise<Map<string, string>> {
  const args = [
    "bundle",
    "--platform=browser",
    "--code-splitting",
    "--outdir",
    outDir,
    "--config",
    configPath,
  ];
  if (minify) args.push("--minify");
  args.push(...entryPaths);

  const { code, stderr } = await new Deno.Command(denoExecutable(), {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `deno bundle failed (${code}):\n${new TextDecoder().decode(stderr)}\n` +
        `(\`deno bundle\` is an evolving subcommand; if this looks like a CLI/flag ` +
        `error rather than a code error, check your Deno version or set DENO_BIN.)`,
    );
  }
  const files = new Map<string, string>();
  for await (const dirEntry of Deno.readDir(outDir)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".js")) {
      files.set(dirEntry.name, await Deno.readTextFile(join(outDir, dirEntry.name)));
    }
  }
  return files;
}

/**
 * Bundle an entry source string into browser JavaScript by shelling out to
 * `deno bundle` with code splitting. Returns the entry file plus any chunk files
 * emitted for dynamic imports.
 */
export async function bundleSourceFiles(
  entrySource: string,
  opts: BundleOptions,
): Promise<BundleOutput> {
  await ensureBundleSupport();
  const tmpDir = await Deno.makeTempDir({ prefix: "denext_bundle_" });
  const srcDir = join(tmpDir, "src");
  const outDir = join(tmpDir, "out");
  await Deno.mkdir(srcDir);
  const entryPath = join(srcDir, "entry.tsx");
  try {
    await Deno.writeTextFile(entryPath, entrySource);
    const configPath = await prepareConfig(tmpDir, opts);
    const files = await runDenoBundle([entryPath], configPath, outDir, opts.minify);
    const entry = "entry.js";
    if (!files.has(entry)) {
      throw new Error(
        `deno bundle produced no entry file (got: ${[...files.keys()].join(", ") || "nothing"})`,
      );
    }
    return { entry, files };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/**
 * The result of bundling several entries together: each caller `key` mapped to
 * its emitted entry basename, plus every emitted file (entries + shared/split
 * chunks) keyed by basename.
 */
export interface MultiBundleOutput {
  /** Caller key (e.g. a route id) → that entry's emitted basename in {@linkcode files}. */
  entries: Map<string, string>;
  /** Every emitted JS file (entries + shared/split chunks) keyed by basename. */
  files: Map<string, string>;
}

/**
 * Bundle several browser entries in a **single** code-split pass, so any module
 * imported by more than one entry — chiefly the denext client runtime, which
 * every route entry imports — is hoisted into one shared chunk they all reference
 * (downloaded once, cached across client navigations) instead of being inlined
 * into each entry. Contrast {@linkcode bundleRoute}, which bundles one route in
 * isolation and therefore cannot share a chunk with its siblings.
 *
 * @param routeEntries The entries to bundle, each with a stable caller `key`.
 * @param opts Bundle config + minify flag (import-map redirects apply to all).
 * @returns The per-key entry basenames and every emitted file.
 */
export async function bundleRoutes(
  routeEntries: Array<{ key: string; source: string }>,
  opts: BundleOptions,
): Promise<MultiBundleOutput> {
  await ensureBundleSupport();
  const tmpDir = await Deno.makeTempDir({ prefix: "denext_bundle_" });
  const srcDir = join(tmpDir, "src");
  const outDir = join(tmpDir, "out");
  await Deno.mkdir(srcDir);
  try {
    // Distinct per-entry basenames so esbuild's outputs map back unambiguously.
    const bases = routeEntries.map((_, i) => `entry_${i}`);
    const entryPaths = bases.map((b) => join(srcDir, `${b}.tsx`));
    await Promise.all(
      routeEntries.map((re, i) => Deno.writeTextFile(entryPaths[i], re.source)),
    );
    const configPath = await prepareConfig(tmpDir, opts);
    const files = await runDenoBundle(entryPaths, configPath, outDir, opts.minify);

    const entries = new Map<string, string>();
    routeEntries.forEach((re, i) => {
      const out = `${bases[i]}.js`;
      if (!files.has(out)) {
        throw new Error(
          `deno bundle produced no output for entry "${re.key}" ` +
            `(expected ${out}; got: ${[...files.keys()].join(", ") || "nothing"})`,
        );
      }
      entries.set(re.key, out);
    });
    return { entries, files };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/**
 * Bundle an entry source string and return only the entry file's JavaScript.
 * Convenience for callers that do not emit split chunks (e.g. tests).
 */
export async function bundleSource(
  entrySource: string,
  opts: BundleOptions,
): Promise<string> {
  return entryCode(await bundleSourceFiles(entrySource, opts));
}

/** Bundle a page route's browser entry (entry + any dynamic-import chunks). */
export function bundleRoute(
  route: PageRoute,
  opts: BundleOptions,
): Promise<BundleOutput> {
  return bundleSourceFiles(generateRouteEntry(route), opts);
}

/**
 * Write a {@linkcode BundleOutput} to `dir`: the entry file as `entryName` and
 * every split chunk under its own (content-hashed) basename. Chunks are shared
 * by name, so identical chunks across routes overwrite with identical content.
 *
 * @param dir Target directory (all files must land together so relative chunk
 *   imports resolve).
 * @param output The bundle to write.
 * @param entryName The filename to give the entry (e.g. `"index.js"`).
 */
export async function writeBundleOutput(
  dir: string,
  output: BundleOutput,
  entryName: string,
): Promise<void> {
  for (const [name, code] of output.files) {
    const target = name === output.entry ? entryName : name;
    await Deno.writeTextFile(join(dir, target), code);
  }
}
