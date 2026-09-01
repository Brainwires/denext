// Pages Router benchmark (`@denext/pages-router`). Three self-contained measures,
// all on denext (no Next.js dependency), so they're reproducible anywhere Deno is:
//
//   1. SSR throughput  — full pages-router document render (renderPage: _app +
//      page + __NEXT_DATA__ + scripts), plus a raw denext renderToString baseline
//      of the same tree, so the plugin's document-assembly overhead is explicit.
//   2. Client bytes    — gzipped JS a browser downloads for a route (per-route
//      entry + the shared runtime chunk), from a production build of
//      examples/pages-router.
//   3. Serve throughput— requests/second + latency percentiles against the
//      production server for a warm page.
//
//   deno run -A --v8-flags=--expose-gc bench/pages/run.ts
//
// Writes bench/pages/REPORT.md and prints it.

import { join } from "@std/path";
import { h } from "../../src/jsx/jsx-runtime.ts";
import { renderToString } from "../../src/jsx/render-to-string.ts";
import type { HeadCollector } from "../../src/jsx/render-to-string.ts";
import { renderPage } from "../../packages/pages-router/src/render.ts";
import { microbench } from "../lib/microbench.ts";
import { gzipSize } from "../lib/sizes.ts";
import { captureProvenance } from "../lib/provenance.ts";

const BENCH = new URL("..", import.meta.url).pathname;
const ROOT = join(BENCH, "..");
const EXAMPLE = join(ROOT, "examples", "pages-router");
const DENO = Deno.execPath();
const CLI = join(ROOT, "cli.ts");

// deno-lint-ignore no-explicit-any
type AnyProps = any;
// The bench components use concrete prop types; renderPage/h want the generic
// component type, so pass them through `as never` at the call sites.
// deno-lint-ignore no-explicit-any
const asC = (c: unknown) => c as any;

// ── A representative page tree (a modest real page: header, a list, footer) ──
function Item({ n }: { n: number }) {
  return h(
    "li",
    { class: "item" },
    h("span", { class: "k" }, `Item ${n}`),
    h("span", { class: "v" }, `value-${n}`),
  );
}
function Page({ title, count }: { title: string; count: number }) {
  const items = [];
  for (let i = 0; i < count; i++) items.push(h(Item, { n: i, key: i }));
  return h(
    "main",
    { class: "page" },
    h("h1", null, title),
    h(
      "p",
      null,
      "A representative Pages Router page rendered by @denext/pages-router.",
    ),
    h("ul", { class: "list" }, items),
  );
}
function App(
  { Component, pageProps }: { Component: AnyProps; pageProps: AnyProps },
) {
  return h(
    "div",
    { class: "app" },
    h("header", { class: "chrome" }, "denext pages-router"),
    h(Component, pageProps),
    h("footer", { class: "chrome" }, "Built on Deno"),
  );
}

const ITEMS = 50;
const pageProps = { title: "Benchmark", count: ITEMS };
const nextData = {
  props: { pageProps },
  page: "/",
  query: {} as Record<string, string>,
  asPath: "/",
  isServer: false,
};

// ── 1. SSR throughput ────────────────────────────────────────────────────────
async function ssr() {
  // Correctness gate.
  const doc = await renderPage({
    Page: asC(Page),
    pageProps,
    App: asC(App),
    nextData,
  });
  if (!doc.includes("<!DOCTYPE html>") || !doc.includes("__NEXT_DATA__")) {
    throw new Error("pages-router render produced an unexpected document");
  }
  const tree = h(asC(App), { Component: Page, pageProps });
  const baseline = await renderToString(tree as never, {
    head: { tags: [] } as HeadCollector,
  });
  if (baseline.length === 0) {
    throw new Error("baseline render produced empty HTML");
  }

  console.error("pages-router renderPage …");
  const full = await microbench(
    "pages-router renderPage (full document)",
    () => renderPage({ Page: asC(Page), pageProps, App: asC(App), nextData }),
    { samples: 21 },
  );
  console.error("denext renderToString baseline …");
  const base = await microbench(
    "denext renderToString (page tree only)",
    () =>
      renderToString(h(asC(App), { Component: Page, pageProps }) as never, {
        head: { tags: [] } as HeadCollector,
      }),
    {
      samples: 21,
    },
  );
  return {
    full,
    base,
    docBytes: new TextEncoder().encode(doc).length,
    items: ITEMS,
  };
}

// ── 2. Client bytes (gzipped) ────────────────────────────────────────────────
async function clientBytes() {
  // Build the example for production (writes .denext/pages-client/…).
  console.error("building examples/pages-router …");
  const build = await new Deno.Command(DENO, {
    args: ["run", "-A", CLI, "build", "."],
    cwd: EXAMPLE,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!build.success) {
    throw new Error(
      "example build failed:\n" + new TextDecoder().decode(build.stderr),
    );
  }
  const dir = join(EXAMPLE, ".denext", "pages-client");
  const manifest = JSON.parse(
    await Deno.readTextFile(join(dir, "manifest.json")),
  ) as {
    entries: Record<string, string>;
  };
  const homeEntry = manifest.entries["/"];
  // Discover the shared chunk(s) the entry imports (its relative `./chunk-*.js`).
  const entryCode = await Deno.readTextFile(join(dir, homeEntry));
  const chunks = [...entryCode.matchAll(/from\s*"\.\/(chunk-[^"]+\.js)"/g)].map(
    (m) => m[1],
  );
  const files = [homeEntry, ...new Set(chunks)];
  let raw = 0, gz = 0;
  const per: Array<{ file: string; raw: number; gzip: number }> = [];
  for (const f of files) {
    const bytes = await Deno.readFile(join(dir, f));
    const g = await gzipSize(bytes);
    raw += bytes.length;
    gz += g;
    per.push({ file: f, raw: bytes.length, gzip: g });
  }
  return { per, raw, gz };
}

// ── 3. Serve throughput (req/s + latency) ────────────────────────────────────
async function serve() {
  // Grab a free port, start the prod server on the already-built example.
  const probe = Deno.listen({ port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const child = new Deno.Command(DENO, {
    args: ["run", "-A", CLI, "start", ".", "--port", String(port)],
    cwd: EXAMPLE,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const origin = `http://localhost:${port}`;
  try {
    // Wait until healthy.
    let up = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(origin + "/_denext/health");
        await r.body?.cancel();
        if (r.ok) {
          up = true;
          break;
        }
      } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!up) throw new Error("server did not become healthy");

    const url = origin + "/";
    // Warm up.
    for (let i = 0; i < 200; i++) await (await fetch(url)).text();

    const TOTAL = 4000, CONC = 50;
    const latencies: number[] = [];
    let done = 0, errors = 0;
    const t0 = performance.now();
    const worker = async () => {
      while (done < TOTAL) {
        done++;
        const s = performance.now();
        try {
          const r = await fetch(url);
          await r.text();
          if (!r.ok) errors++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - s);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    const wall = (performance.now() - t0) / 1000;
    latencies.sort((a, b) => a - b);
    const pct = (p: number) =>
      latencies[
        Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))
      ];
    return {
      reqPerSec: TOTAL / wall,
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
      max: latencies[latencies.length - 1],
      errors,
      total: TOTAL,
      conc: CONC,
    };
  } finally {
    child.kill();
    await child.status;
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const prov = captureProvenance(now);
const ssrR = await ssr();
const bytesR = await clientBytes();
const serveR = await serve();

const kb = (n: number) => (n / 1024).toFixed(1) + " KB";
const k = (n: number) => Math.round(n).toLocaleString();
const overhead = ((ssrR.full.nsPerOp / ssrR.base.nsPerOp - 1) * 100).toFixed(0);

const report = `# @denext/pages-router — benchmark report

_Generated ${now}_

**Machine:** ${prov.cpu} · ${prov.cores} cores · ${prov.os}/${prov.arch}
**Runtime:** Deno ${prov.deno} (V8 ${prov.v8})

All figures are for \`@denext/pages-router\` running on denext — no Next.js in the
loop — so they are reproducible with \`deno task bench:pages\`. SSR uses a modest
representative page (${ssrR.items}-item list wrapped in \`_app\`).

## 1. SSR throughput

| Render path | renders/sec | ns/render | vs baseline |
| --- | ---: | ---: | ---: |
| \`renderPage\` (full document: \`_app\` + page + \`__NEXT_DATA__\` + scripts) | ${
  k(ssrR.full.opsPerSec)
} | ${k(ssrR.full.nsPerOp)} | +${overhead}% |
| denext \`renderToString\` (same tree, no document) | ${k(ssrR.base.opsPerSec)} | ${
  k(ssrR.base.nsPerOp)
} | baseline |

The full pages-router document render costs **+${overhead}%** over raw denext SSR of
the same tree — that delta is the document assembly (\`<html>\`/\`<head>\`, the
\`__NEXT_DATA__\` payload, and the hydration script), not per-component overhead.
Rendered document: ${kb(ssrR.docBytes)}.

## 2. Client bytes (gzipped) — home route

| File | raw | gzip |
| --- | ---: | ---: |
${
  bytesR.per.map((f) => `| \`${f.file}\` | ${kb(f.raw)} | ${kb(f.gzip)} |`)
    .join("\n")
}
| **total for the route** | **${kb(bytesR.raw)}** | **${kb(bytesR.gz)}** |

The shared \`chunk-*.js\` (the denext client runtime + \`_app\`) is downloaded once and
reused across every route and soft navigation, so a second route adds only its own
small entry.

## 3. Serve throughput (production server, warm)

${TOTAL_NOTE(serveR)}

| Metric | Value |
| --- | ---: |
| Requests/sec | **${k(serveR.reqPerSec)}** |
| Latency p50 | ${serveR.p50.toFixed(2)} ms |
| Latency p95 | ${serveR.p95.toFixed(2)} ms |
| Latency p99 | ${serveR.p99.toFixed(2)} ms |
| Latency max | ${serveR.max.toFixed(2)} ms |
| Errors | ${serveR.errors} / ${serveR.total} |

_Method: ${serveR.total} requests at concurrency ${serveR.conc} against the home page
of \`examples/pages-router\` built with \`denext build\` and served with \`denext start\`,
after a 200-request warmup. Localhost, single machine — absolute numbers are
machine-specific; use them for relative comparison across denext versions._
`;

// Helper referenced above.
function TOTAL_NOTE(_s: unknown): string {
  return "Full production path: route match → prerendered/SSR HTML served for the home page.";
}

await Deno.mkdir(join(BENCH, "pages"), { recursive: true });
await Deno.writeTextFile(join(BENCH, "pages", "REPORT.md"), report);
console.log(report);
Deno.exit(0);
