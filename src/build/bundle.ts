// Browser bundling via Deno's own `deno bundle` — no third-party bundler.
//
// For each page route we generate a single entry module that imports the page,
// its layouts, and the client runtime, then hydrates. Bundling the whole thing
// as one module graph keeps shared module identity (e.g. context symbols)
// intact, which separate dynamic imports would break.

import { fromFileUrl, toFileUrl } from "@std/path";
import type { PageRoute } from "../router/manifest.ts";

/** Absolute path to the denext framework root (contains deno.json, mod.ts). */
export function frameworkRoot(): string {
  return fromFileUrl(new URL("../../", import.meta.url));
}

/** Generate the browser entry source that hydrates a single page route. */
export function generateRouteEntry(route: PageRoute): string {
  const pageUrl = toFileUrl(route.filePath).href;
  const layoutImports = route.layoutChain
    .map((p, i) => `import Layout${i} from ${JSON.stringify(toFileUrl(p).href)};`)
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

  // Wrap innermost -> outermost, mirroring the server's composition.
  let wrap = "let tree = h(Page, { params: data.params, searchParams: sp });\n";
  if (route.loading) {
    wrap +=
      "  tree = h(Suspense, { fallback: h(Loading, {}), children: tree });\n";
  }
  if (route.error) {
    wrap += "  tree = h(ErrorBoundary, { fallback: ErrorComp, children: tree });\n";
  }
  for (let i = route.layoutChain.length - 1; i >= 0; i--) {
    wrap +=
      `  tree = h(Layout${i}, { children: tree, params: data.params });\n`;
  }

  return `// denext generated route entry — do not edit.
import { hydrateRoot, Suspense, ErrorBoundary } from "denext/client";
import { h } from "denext/jsx-runtime";
import Page from ${JSON.stringify(pageUrl)};
${layoutImports}
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
    hydrateRoot(el, tree);
  } catch (err) {
    // Async (server-only) components can't hydrate; leave SSR markup as-is.
    console.warn("denext: skipping hydration for this route:", err && err.message);
  }
}

main();
`;
}

export interface BundleOptions {
  configPath: string;
  minify?: boolean;
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
    const args = [
      "bundle",
      "--platform=browser",
      "--config",
      opts.configPath,
    ];
    if (opts.minify) args.push("--minify");
    args.push(entryPath);

    const command = new Deno.Command(Deno.execPath(), {
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
