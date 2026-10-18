// @denext/tanstack-start's `denext export` beyond the prerender itself: Start's `spa` option (its
// post-build adds the SPA shell page — the mask path rendered with Start's `X-TSS_SHELL` header to
// `_shell.html`, out of the sitemap, never refused) and its `sitemap` option (Start's own
// `buildSitemap` over every page the prerender met, writing `sitemap.xml` and `pages.json` beside
// the pages). The browser half is tests/e2e/tanstack-start.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  buildStep,
  type ExportPlan,
  type StartBundles,
} from "../packages/tanstack-start/src/bundles.ts";
import {
  prerenderPages,
  type RouteInfo,
  SHELL_HEADER,
  spaShellPage,
  type StartPage,
} from "../packages/tanstack-start/src/prerender.ts";
import type { SitemapInput } from "../packages/tanstack-start/src/toolchain.ts";
import type { PluginBuildContext } from "../src/plugin/mod.ts";

/** Answer each page with its path and a link, as HTML; record the shell header it carried. */
function server(links: Record<string, string> = {}) {
  const shells: string[] = [];
  return {
    shells,
    fetch: (req: Request) => {
      const path = new URL(req.url).pathname;
      if (req.headers.get(SHELL_HEADER) === "true") shells.push(path);
      return Promise.resolve(
        new Response(`${links[path] ?? ""}${path}`, { headers: { "content-type": "text/html" } }),
      );
    },
  };
}

Deno.test("tanstack-start spa: the shell page Start's post-build adds", () => {
  assertEquals(spaShellPage(undefined), null);
  assertEquals(spaShellPage({ enabled: false }), null);
  assertEquals(spaShellPage({}), {
    path: "/",
    prerender: {
      outputPath: "/_shell",
      crawlLinks: false,
      retryCount: 0,
      enabled: true,
      headers: { [SHELL_HEADER]: "true" },
    },
    sitemap: { exclude: true },
  });
  // The app's own shell options win over Start's defaults; the shell header and `enabled` stay.
  const custom = spaShellPage({
    maskPath: "/app",
    prerender: { outputPath: "/200", crawlLinks: true, enabled: false, headers: { "x-a": "1" } },
  })!;
  assertEquals(custom.path, "/app");
  assertEquals(custom.prerender, {
    outputPath: "/200",
    crawlLinks: true,
    retryCount: 0,
    enabled: true,
    headers: { "x-a": "1", [SHELL_HEADER]: "true" },
  });
  assertThrows(
    () => spaShellPage({ maskPath: "https://evil.example/" }),
    Error,
    "spa.maskPath must be a path (no protocol/host)",
  );
});

Deno.test("tanstack-start spa: the shell renders with Start's header to _shell.html", async () => {
  const root: RouteInfo = {
    id: "__root__",
    path: "/",
    file: "/app/src/routes/__root.tsx",
    layout: true,
    options: ["component"],
  };
  const routes: RouteInfo[] = [
    root,
    // The index route calls a server function: its page needs a server, the shell does not.
    {
      id: "/",
      path: "/",
      file: "/app/src/routes/index.tsx",
      layout: false,
      options: ["component"],
      parent: root,
    },
    {
      id: "/about",
      path: "/about",
      file: "/app/src/routes/about.tsx",
      layout: false,
      options: ["component"],
      parent: root,
    },
  ];
  const files = new Map<string, string>();
  const app = server({ "/about": '<a href="/">home</a>' });
  const shell = spaShellPage({})!;
  const result = await prerenderPages({
    options: {},
    pages: [shell],
    shellOutputPath: shell.prerender!.outputPath,
    routes,
    client: {
      graph: { imports: new Map(), importers: new Map(), kept: new Set() },
      serverFnModules: new Set(["/app/src/routes/index.tsx"]),
    },
    projectRoot: "/app",
    basePath: "",
    fetch: app.fetch,
    write: (file, html) => (files.set(file, html), Promise.resolve()),
  });
  // As in Start, the shell takes `/`: the index page is not written (a crawled `/` was seen).
  assertEquals([...files.keys()].sort(), ["_shell.html", "about/index.html"]);
  assertEquals(app.shells, ["/"], "only the shell carries the header");
  assertEquals(result.refused, [], "the shell is never refused");
  assertEquals(result.pages.map((p) => p.path), ["/", "/about"]);
  assertEquals(result.pages[0].sitemap, { exclude: true });
});

/** A build step context writing under `dir`, its emitted files recorded. */
function buildContext(dir: string): PluginBuildContext {
  return {
    outDir: join(dir, "out"),
    emitFile: () => Promise.resolve(),
  } as unknown as PluginBuildContext;
}

/** Bundles whose server answers every page. */
function bundlesFor(dir: string, fetch: (req: Request) => Promise<Response>): StartBundles {
  return {
    loadServerEntry: () => Promise.resolve({ fetch }),
    client: async () => {
      await Deno.mkdir(join(dir, "client"), { recursive: true });
      return join(dir, "client");
    },
    bundle: () => Promise.resolve(),
    clientGraph: () => null,
    prebuildServer: () => Promise.resolve(),
    forgetServerBuild: () => Promise.resolve(),
    reset: () => {},
    serverFunctions: () => Promise.resolve({}),
  };
}

/** Run `fn` with console output swallowed. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, log } = console;
  console.warn = console.log = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { warn, log });
  }
}

Deno.test("tanstack-start export: Start's sitemap over every page the prerender met", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_sitemap_" });
  try {
    const seen: SitemapInput[] = [];
    const app = server({ "/": '<a href="/about">a</a><a href="/admin">x</a>' });
    const plan: ExportPlan = {
      options: { filter: (page: StartPage) => page.path !== "/admin" },
      pages: [{ path: "/", sitemap: { priority: 1 } }],
      spa: { maskPath: "/app" },
      sitemap: { host: "https://start.example" },
      sitemapBuilder: () => Promise.resolve((input: SitemapInput) => void seen.push(input)),
      routes: () => null,
      projectRoot: dir,
      basePath: "",
    };
    await quiet(() => buildStep("export", bundlesFor(dir, app.fetch), buildContext(dir), plan));
    assertEquals(seen.length, 1);
    const [{ startConfig, publicDir }] = seen;
    // Start's defaults filled in; written beside the pages, which the export publishes at its root.
    assertEquals(startConfig.sitemap, {
      host: "https://start.example",
      enabled: true,
      outputPath: "sitemap.xml",
    });
    assertEquals(publicDir, join(dir, "out", "pages-static"));
    // Listed, the shell, and crawled — a filtered page included, as in Start.
    assertEquals(startConfig.pages.map((p) => p.path), ["/", "/app", "/about", "/admin"]);
    assertEquals(startConfig.pages[0].sitemap, { priority: 1 });
    assert(startConfig.pages[2].fromCrawl);
    assertEquals(
      await Deno.readTextFile(join(dir, "out", "pages-static", "_shell.html")),
      "/app",
      "the shell's own output path, not its mask path",
    );

    // `enabled: false` writes none; prerender off still writes the listed pages' sitemap, and
    // `spa` turns the prerender back on.
    seen.length = 0;
    await quiet(() =>
      buildStep("export", bundlesFor(dir, app.fetch), buildContext(dir), {
        ...plan,
        sitemap: { host: "https://start.example", enabled: false },
      })
    );
    assertEquals(seen, []);
    await quiet(() =>
      buildStep("export", bundlesFor(dir, app.fetch), buildContext(dir), {
        ...plan,
        options: { enabled: false },
        spa: undefined,
        sitemap: { host: "https://start.example", outputPath: "seo.xml" },
      })
    );
    assertEquals(seen.map((s) => [s.startConfig.sitemap?.outputPath, s.startConfig.pages]), [
      ["seo.xml", [{ path: "/", sitemap: { priority: 1 } }]],
    ]);
    seen.length = 0;
    app.shells.length = 0;
    await quiet(() =>
      buildStep("export", bundlesFor(dir, app.fetch), buildContext(dir), {
        ...plan,
        options: { enabled: false },
      })
    );
    assertEquals(app.shells, ["/app"], "spa turns the prerender on");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Start's own sitemap builder, from the example app's install (`deno install` in
// examples/tanstack-start; the e2e does it). Skipped when the example is not installed.
const EXAMPLE = fromFileUrl(new URL("../examples/tanstack-start", import.meta.url));
const installed = await Deno.stat(join(EXAMPLE, "node_modules", "@tanstack", "react-start"))
  .then(() => true, () => false);

Deno.test({
  name: "tanstack-start sitemap (installed example): Start's own buildSitemap writes the files",
  ignore: !installed,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_sitemap_real_" });
  try {
    const probe = fromFileUrl(
      new URL("./fixtures/tanstack-start/sitemap-probe.ts", import.meta.url),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(EXAMPLE, "deno.json"), probe, EXAMPLE, dir],
      cwd: EXAMPLE,
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    // Start's logger reports what it wrote.
    assertStringIncludes(new TextDecoder().decode(out.stdout), "[sitemap] Building Sitemap...");
    const xml = await Deno.readTextFile(join(dir, "sitemap.xml"));
    assertStringIncludes(xml, '<?xml version="1.0" encoding="UTF-8"?>');
    assertStringIncludes(xml, "<!--This file was automatically generated by TanStack Start.-->");
    assertStringIncludes(
      xml,
      "<loc>https://start.example/</loc>\n    <lastmod>2026-01-02</lastmod>\n    " +
        "<priority>1</priority>\n    <changefreq>daily</changefreq>",
    );
    assertStringIncludes(xml, "<loc>https://start.example/about</loc>");
    assertEquals(xml.match(/<url>/g)?.length, 2, "the shell is excluded");
    const pages = JSON.parse(await Deno.readTextFile(join(dir, "pages.json")));
    assertEquals(pages.host, "https://start.example");
    assertEquals(pages.pages[1], { path: "/about" }, "private fields (headers) are stripped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
