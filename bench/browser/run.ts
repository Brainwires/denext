// Browser harness — the empirical half of the report. It serves each framework's
// PRODUCTION build and drives a headless Chromium (astral) to measure, on the
// exact same pages, two things a real user experiences:
//
//   Layer 1 — bytes over the wire: the compressed JS a browser actually downloads
//             for a route (Resource Timing `encodedBodySize`), summed. No bundler
//             manifest parsing — this is what the network sees, for either
//             framework, regardless of webpack/Turbopack/deno bundle internals.
//
//   Layer 3 — runtime: time-to-interactive (navigation → the hydration marker
//             `.on` both apps flip once hydrated) and interaction latency (a
//             counter click → the DOM text updating). Reported as p50/p95.
//
// Emits JSON on stdout; progress on stderr. Run with the repo-root deno config so
// denext's server code and astral both resolve:
//   deno run -A --config deno.json bench/browser/run.ts

import { join } from "@std/path";
import { launch } from "@astral/astral";
import { serveDenext, serveNext } from "../lib/serve.ts";
import { gzipSize } from "../lib/sizes.ts";

console.log = (...a: unknown[]) => console.error(...a); // keep stdout JSON-only

const REPO = new URL("../../", import.meta.url).pathname;
const DENEXT_APP = join(REPO, "examples/hello");
const NEXT_APP = join(REPO, "bench/fixtures/next-hello");
const NEXT_BIN = join(REPO, "bench/node_modules/.bin/next");

// Routes present in BOTH apps. The home route is the interactive one (counter +
// hydration marker + ssr:false island); about/blog exercise lighter pages.
const ROUTES = ["/", "/about", "/blog/hello-world"];
// Hydration samples are expensive (each is a fresh full page navigation), so
// keep them modest. Interaction samples are cheap (clicks on one hydrated page)
// and p95 needs a real tail, so take many more. Both overridable via env.
const HYDRATION_SAMPLES = Number(Deno.env.get("BENCH_HYDRATION_SAMPLES") ?? 15);
const INTERACTION_SAMPLES = Number(
  Deno.env.get("BENCH_INTERACTION_SAMPLES") ?? 60,
);
// Bytes are deterministic; timing-focused runs can skip them to go faster.
const SKIP_BYTES = Deno.env.get("BENCH_SKIP_BYTES") === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Map a served URL path back to its file on disk, per framework, so we can gzip
// every route's JS with ONE identical compressor — instead of trusting each
// server's own on-the-wire encoding (denext's prod server serves raw; Next's
// `next start` gzips). Browser discovers WHICH files a route loads; we control
// HOW they're compressed. That is the fair "bytes over the wire (gzip)".
const DISK_ROOTS = [
  { prefix: "/_denext/", root: join(DENEXT_APP, ".denext") },
  { prefix: "/_next/", root: join(NEXT_APP, ".next") },
];

async function diskSize(
  pathname: string,
): Promise<{ raw: number; gzip: number } | null> {
  for (const { prefix, root } of DISK_ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    try {
      const bytes = await Deno.readFile(
        join(root, pathname.slice(prefix.length)),
      );
      return { raw: bytes.length, gzip: await gzipSize(bytes) };
    } catch {
      return null; // e.g. a virtual/served-from-memory asset with no disk file
    }
  }
  return null;
}

interface ResourceEntry {
  name: string;
  type: string;
  enc: number;
}
interface PageBytes {
  routePath: string;
  htmlEnc: number;
  /** Sum of on-the-wire encoded JS bytes as the server actually sent them. */
  jsEnc: number;
  jsFiles: string[];
  /** JS gzipped uniformly from disk (the fair cross-framework number). */
  jsRawDisk: number;
  jsGzipDisk: number;
}

/** Cold-load a route in a FRESH browser and sum the JS bytes transferred. */
async function measureBytes(
  origin: string,
  routePath: string,
): Promise<PageBytes> {
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage(origin + routePath);
    await page.waitForFunction("document.readyState === 'complete'");
    await sleep(600); // let any post-hydration lazy chunk (the island) arrive
    const raw = await page.evaluate(`(() => {
      const res = performance.getEntriesByType('resource').map((e) => ({
        name: e.name, type: e.initiatorType, enc: e.encodedBodySize || 0,
      }));
      const nav = performance.getEntriesByType('navigation')[0];
      return JSON.stringify({ resources: res, htmlEnc: nav ? nav.encodedBodySize : 0 });
    })()`) as string;
    const parsed = JSON.parse(raw) as {
      resources: ResourceEntry[];
      htmlEnc: number;
    };
    const js = parsed.resources.filter((r) => r.type === "script" || r.name.endsWith(".js"));
    const jsFiles = js.map((r) => new URL(r.name).pathname);

    // Uniform gzip from disk.
    let jsRawDisk = 0, jsGzipDisk = 0;
    for (const p of jsFiles) {
      const d = await diskSize(p);
      if (d) {
        jsRawDisk += d.raw;
        jsGzipDisk += d.gzip;
      }
    }

    return {
      routePath,
      htmlEnc: parsed.htmlEnc,
      jsEnc: js.reduce((n, r) => n + r.enc, 0),
      jsFiles,
      jsRawDisk,
      jsGzipDisk,
    };
  } finally {
    await browser.close();
  }
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    p50: q(50),
    p95: q(95),
    min: s[0],
    max: s[s.length - 1],
    n: s.length,
  };
}

/** Navigation → hydration marker `.on`, in ms since navigation start. */
async function measureHydration(
  browser: unknown,
  url: string,
): Promise<number[]> {
  // deno-lint-ignore no-explicit-any
  const b = browser as any;
  const out: number[] = [];
  for (let i = 0; i < HYDRATION_SAMPLES; i++) {
    const page = await b.newPage(url);
    const ms = await page.evaluate(`(async () => {
      if (document.querySelector('.on')) return performance.now();
      await new Promise((res) => {
        const obs = new MutationObserver(() => {
          if (document.querySelector('.on')) { obs.disconnect(); res(); }
        });
        obs.observe(document.documentElement, { subtree: true, attributes: true, childList: true });
      });
      return performance.now();
    })()`) as number;
    out.push(ms);
    await page.close();
  }
  return out;
}

/** Counter click → DOM text change, in ms (reconciler responsiveness). */
async function measureInteraction(
  browser: unknown,
  url: string,
): Promise<number[]> {
  // deno-lint-ignore no-explicit-any
  const b = browser as any;
  const page = await b.newPage(url);
  await page.waitForFunction(
    "!!document.querySelector('.on') && !!document.querySelector('button')",
  );
  const out: number[] = [];
  for (let i = 0; i < INTERACTION_SAMPLES; i++) {
    const ms = await page.evaluate(`(async () => {
      const btn = document.querySelector('button');
      const before = btn.textContent;
      const t0 = performance.now();
      btn.click();
      await new Promise((res) => {
        const obs = new MutationObserver(() => {
          if (document.querySelector('button').textContent !== before) { obs.disconnect(); res(); }
        });
        obs.observe(btn, { subtree: true, childList: true, characterData: true });
      });
      return performance.now() - t0;
    })()`) as number;
    out.push(ms);
    await sleep(30);
  }
  await page.close();
  return out;
}

/**
 * Reduce per-route file sets into the shared / first-load / per-nav model, using
 * the uniform disk gzip. Shared = files loaded on EVERY route.
 */
async function analyzeFramework(bytes: PageBytes[]) {
  const gzipCache = new Map<string, number>();
  const gz = async (p: string): Promise<number> => {
    if (gzipCache.has(p)) return gzipCache.get(p)!;
    const d = await diskSize(p);
    const v = d?.gzip ?? 0;
    gzipCache.set(p, v);
    return v;
  };

  let shared: Set<string> | null = null;
  for (const b of bytes) {
    const set = new Set<string>(b.jsFiles);
    if (shared === null) {
      shared = set;
    } else {
      const prev: Set<string> = shared;
      shared = new Set<string>([...prev].filter((f) => set.has(f)));
    }
  }
  const sharedFiles = [...(shared ?? new Set<string>())];
  let sharedGzip = 0;
  for (const f of sharedFiles) sharedGzip += await gz(f);

  const routes = [];
  for (const b of bytes) {
    let firstLoadGzip = 0;
    for (const f of b.jsFiles) firstLoadGzip += await gz(f);
    let perNavGzip = 0;
    for (const f of b.jsFiles.filter((f) => !sharedFiles.includes(f))) {
      perNavGzip += await gz(f);
    }
    routes.push({ routePath: b.routePath, firstLoadGzip, perNavGzip });
  }
  return { sharedGzip, routes };
}

async function measureFramework(name: string, origin: string) {
  const bytes: PageBytes[] = [];
  if (!SKIP_BYTES) {
    console.error(`\n[${name}] measuring bytes on ${ROUTES.length} routes…`);
    for (const r of ROUTES) {
      const b = await measureBytes(origin, r);
      console.error(
        `  ${name} ${r}: JS ${(b.jsGzipDisk / 1024).toFixed(1)} KB gzip ` +
          `(${(b.jsRawDisk / 1024).toFixed(1)} KB raw, ${b.jsFiles.length} files)`,
      );
      bytes.push(b);
    }
  }
  const analysis = await analyzeFramework(bytes);

  console.error(
    `[${name}] measuring timings on / (hydration ×${HYDRATION_SAMPLES}, interaction ×${INTERACTION_SAMPLES})…`,
  );
  const browser = await launch({ headless: true });
  let hydration, interaction;
  try {
    hydration = stats(await measureHydration(browser, origin + "/"));
    interaction = stats(await measureInteraction(browser, origin + "/"));
  } finally {
    await browser.close();
  }
  console.error(
    `  ${name} hydration p50/p95 ${hydration.p50.toFixed(0)}/${hydration.p95.toFixed(0)}ms | ` +
      `interaction p50/p95 ${interaction.p50.toFixed(2)}/${interaction.p95.toFixed(2)}ms`,
  );
  return { framework: name, bytes, analysis, hydration, interaction };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const denextServer = await serveDenext(DENEXT_APP);
let denext, next;
try {
  denext = await measureFramework("denext", denextServer.origin);
} finally {
  await denextServer.close();
}

const nextServer = await serveNext(NEXT_APP, NEXT_BIN);
try {
  next = await measureFramework("next", nextServer.origin);
} finally {
  await nextServer.close();
}

await Deno.stdout.write(
  new TextEncoder().encode(JSON.stringify({ denext, next }, null, 2)),
);
Deno.exit(0);
