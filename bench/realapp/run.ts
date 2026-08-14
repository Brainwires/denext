// Real-app tier: a fair, library-heavy comparison. Both apps render the SAME
// three routes with the SAME npm React libraries — recharts (a class-component
// library, exercising denext's `classComponents` opt-in), react-hook-form, Radix
// dialog, and lucide icons. This answers "can denext run a real app, and is it
// still smaller?" — where the toy hello app couldn't.
//
// Bytes = gzip of the JavaScript each route ships, measured with one compressor:
//   • denext — each next-compat page is a single self-contained client bundle, so
//     its gzip IS its first-load JS (no discovery needed).
//   • Next   — the route's chunks are discovered empirically in headless Chromium
//     (Resource Timing) and gzipped from disk (bundler-agnostic, same as Layer 1).
//
// That the recharts dashboard renders at all (SSR to SVG) is itself the proof
// that denext's opt-in class-component runtime handles a real class-based library.
//
//   deno run -A --config deno.json bench/realapp/run.ts

import { join } from "@std/path";
import { launch } from "@astral/astral";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
} from "../../src/build/next-compat-build.ts";
import { serveNext } from "../lib/serve.ts";
import { gzipSize } from "../lib/sizes.ts";

console.log = (...a: unknown[]) => console.error(...a); // stdout stays JSON-only

const REPO = new URL("../../", import.meta.url).pathname;
const DENEXT_APP = join(REPO, "bench/fixtures/denext-app");
const NEXT_APP = join(REPO, "bench/fixtures/next-real-app");
const NEXT_BIN = join(REPO, "bench/node_modules/.bin/next");
const ROUTES = ["/", "/form", "/ui"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pageFile(route: string): string {
  return route === "/"
    ? join(DENEXT_APP, "app/page.tsx")
    : join(DENEXT_APP, "app", route.slice(1), "page.tsx");
}

async function gzipFile(path: string): Promise<number> {
  return gzipSize(await Deno.readFile(path));
}

function buildDenext(classComponents: boolean): Promise<BuiltNextCompatPage[]> {
  const layout = join(DENEXT_APP, "app/layout.tsx");
  return buildNextCompatPages({
    projectDir: DENEXT_APP,
    configPath: join(DENEXT_APP, "deno.json"),
    outDir: join(DENEXT_APP, ".denext"),
    pages: ROUTES.map((r) => ({
      routePath: r,
      filePath: pageFile(r),
      layouts: [layout],
    })),
    classComponents,
    minify: true,
  });
}

// ── denext: gzip each self-contained page bundle ─────────────────────────────
console.error("[denext] building next-compat app (classComponents: true)…");
const pagesOn = await buildDenext(true);
const denextRoutes: Array<{ routePath: string; gzip: number }> = [];
for (const p of pagesOn) {
  const gz = await gzipFile(p.clientBundle);
  console.error(`  denext ${p.routePath}: ${(gz / 1024).toFixed(1)} KB gzip`);
  denextRoutes.push({ routePath: p.routePath, gzip: gz });
}

// ── Next: build, serve, discover + gzip per route ────────────────────────────
console.error("[next] building next-real-app…");
const build = await new Deno.Command(NEXT_BIN, {
  args: ["build"],
  cwd: NEXT_APP,
  env: { ...Deno.env.toObject(), NEXT_TELEMETRY_DISABLED: "1" },
  stdout: "null",
  stderr: "inherit",
}).output();
if (!build.success) throw new Error("next build (real app) failed");

const server = await serveNext(NEXT_APP, NEXT_BIN);
const browser = await launch({ headless: true });
const nextRoutes: Array<{ routePath: string; gzip: number }> = [];
try {
  for (const route of ROUTES) {
    const page = await browser.newPage(server.origin + route);
    await page.waitForFunction("document.readyState === 'complete'");
    await sleep(800); // let lazy chunks arrive
    const raw = await page.evaluate(
      `JSON.stringify(performance.getEntriesByType('resource').map((e) => ({ name: e.name, type: e.initiatorType })))`,
    ) as string;
    const resources = JSON.parse(raw) as Array<{ name: string; type: string }>;
    const seen = new Set<string>();
    let gz = 0;
    for (const r of resources) {
      if (r.type !== "script" && !r.name.endsWith(".js")) continue;
      const pathname = new URL(r.name).pathname;
      if (!pathname.startsWith("/_next/") || seen.has(pathname)) continue;
      seen.add(pathname);
      try {
        gz += await gzipFile(
          join(NEXT_APP, ".next", pathname.slice("/_next/".length)),
        );
      } catch {
        // asset without a disk file (rare) — skip
      }
    }
    console.error(`  next ${route}: ${(gz / 1024).toFixed(1)} KB gzip`);
    nextRoutes.push({ routePath: route, gzip: gz });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

await Deno.stdout.write(
  new TextEncoder().encode(
    JSON.stringify({ denext: denextRoutes, next: nextRoutes }, null, 2),
  ),
);
Deno.exit(0);
