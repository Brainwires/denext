// Browser bundling via Deno's own `deno bundle` — no third-party bundler.
//
// For each page route we generate a single entry module that imports the page,
// its layouts, and the client runtime, then hydrates. Bundling the whole thing
// as one module graph keeps shared module identity (e.g. context symbols)
// intact, which separate dynamic imports would break.

import { basename, fromFileUrl, join, toFileUrl } from "@std/path";
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
import { startClient, parseFlight } from "denext/client";

const registry = new Map();
function reg(mod, clientId) {
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === "function") registry.set(clientId + "#" + k, mod[k]);
  }
}
${imports}
${registrations}

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
 * @returns The bundled Flight entry JavaScript.
 */
export async function bundleFlightEntry(
  boundary: BoundaryManifest,
  opts: BundleOptions,
): Promise<string> {
  const stubDir = await Deno.makeTempDir({ prefix: "denext_stubs_" });
  const importMap: Record<string, string> = {};
  try {
    for (const [moduleId, ref] of boundary.server) {
      const stubPath = join(stubDir, moduleId.replace(/[^a-z0-9]/gi, "_") + ".ts");
      await Deno.writeTextFile(stubPath, generateServerStub(moduleId, ref.exports));
      importMap[ref.url] = toFileUrl(stubPath).href;
    }
    return await bundleSource(generateFlightEntry(boundary), {
      configPath: opts.configPath,
      minify: opts.minify,
      importMap,
    });
  } finally {
    await Deno.remove(stubDir, { recursive: true });
  }
}

/**
 * Bundle an entry source string into browser JavaScript by shelling out to
 * `deno bundle`. Returns the bundled code.
 */
export async function bundleSource(
  entrySource: string,
  opts: BundleOptions,
): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "denext_bundle_" });
  const entryPath = `${tmpDir}/entry.tsx`;
  try {
    await Deno.writeTextFile(entryPath, entrySource);
    // When redirects are given, write a merged config that extends the base
    // config's imports with the redirect entries (deno bundle takes one config).
    let configPath = opts.configPath;
    if (opts.importMap && Object.keys(opts.importMap).length > 0) {
      const base = JSON.parse(await Deno.readTextFile(opts.configPath));
      base.imports = { ...(base.imports ?? {}), ...opts.importMap };
      configPath = `${tmpDir}/deno.merged.json`;
      await Deno.writeTextFile(configPath, JSON.stringify(base));
    }
    const args = [
      "bundle",
      "--platform=browser",
      "--config",
      configPath,
    ];
    if (opts.minify) args.push("--minify");
    args.push(entryPath);

    const command = new Deno.Command(denoExecutable(), {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    if (code !== 0) {
      throw new Error(
        `deno bundle failed (${code}):\n${new TextDecoder().decode(stderr)}`,
      );
    }
    return new TextDecoder().decode(stdout);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** Bundle a page route's browser entry to JavaScript. */
export function bundleRoute(
  route: PageRoute,
  opts: BundleOptions,
): Promise<string> {
  return bundleSource(generateRouteEntry(route), opts);
}
