// Run by tests/tanstack-start-export.test.ts under examples/tanstack-start's config (so the app's
// npm packages resolve): Start's own `buildSitemap`, loaded as the plugin loads it, over pages
// like the export's, into the directory given.

import { loadSitemapBuilder } from "../../../packages/tanstack-start/src/toolchain.ts";
import { spaShellPage } from "../../../packages/tanstack-start/src/prerender.ts";

const [example, outDir] = Deno.args;
const build = await loadSitemapBuilder(example);
await build({
  startConfig: {
    sitemap: { enabled: true, host: "https://start.example", outputPath: "sitemap.xml" },
    pages: [
      { path: "/", sitemap: { priority: 1, changefreq: "daily", lastmod: "2026-01-02" } },
      { path: "/about", prerender: { headers: { "x-a": "1" } } },
      spaShellPage({})!,
    ],
  },
  publicDir: outDir,
});
