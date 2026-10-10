// `denext export` under `basePath` / `assetPrefix`: every URL a page references — its
// scripts and their chunks, stylesheets, links, images — resolves when `out/` is served where
// the app lives (and `_denext/` from the asset prefix), as the production server's do.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { serveDir } from "@std/http/file-server";

const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));

/**
 * `denext export` the app in `dir` as the CLI runs it (its loader takes the app's stylesheet
 * imports), returning the output dir.
 */
async function exportApp(dir: string): Promise<{ outDir: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI, "export", dir],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, log);
  return { outDir: join(dir, "out") };
}

/** Scaffold a throwaway app in `dir`: deno.json aliasing `denext` to this checkout + files. */
async function scaffoldApp(dir: string, files: Record<string, string>) {
  const root = new URL("../", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${root}mod.ts`,
        "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
        "denext/server": `${root}src/server/mod.ts`,
        "denext/client": `${root}src/client/mod.ts`,
      },
    }),
  );
  for (const [name, src] of Object.entries(files)) {
    const path = join(dir, name);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, src);
  }
}

const APP = {
  "app/layout.tsx": `import "./globals.css";
export default function Layout({ children }: { children: unknown }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/globals.css": "main { color: rebeccapurple }\n",
  "app/toggle.tsx": `"use client";
import { useState } from "denext";
export function Toggle() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>clicked {n}</button>;
}
`,
  // An island page (Flight), a link to the other page and a public image.
  "app/page.tsx": `import { Image, Link } from "denext";
import { Toggle } from "./toggle.tsx";
export default function Page() {
  return (
    <main>
      <Toggle client:interaction />
      <Link href="/about">about</Link>
      <Image src="/base/logo.svg" alt="logo" width={10} height={10} />
    </main>
  );
}
`,
  // A client page: its root hydrates, so it loads the client runtime at once.
  "app/about/page.tsx": `"use client";
import { useState } from "denext";
export default function About() {
  const [n] = useState(1);
  return <p>about {n}</p>;
}
`,
  "public/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`,
};

/** Every `src` / `href` URL in `html` (decoded entities), excluding fragments. */
function documentUrls(html: string): string[] {
  return [...html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)].map((m) =>
    m[1].replace(/&amp;/g, "&")
  );
}

/**
 * Fetch `url` (200 required) and, for a script, every chunk it imports (static or dynamic),
 * transitively — the URLs a browser would request.
 */
async function assertResolves(url: URL, seen: Set<string>): Promise<void> {
  if (seen.has(url.href)) return;
  seen.add(url.href);
  const res = await fetch(url);
  const body = await res.text();
  assertEquals(res.status, 200, `${url.pathname} → ${res.status}`);
  if (!url.pathname.endsWith(".js")) return;
  for (const m of body.matchAll(/["'](\.\/[^"']+\.js)["']/g)) {
    await assertResolves(new URL(m[1], url), seen);
  }
}

/**
 * Serve `outDir` under each prefix in `mounts` (a static host serving the export where the app
 * lives, and the asset prefix's CDN path), load each page and resolve every URL it references.
 */
async function assertExportResolves(
  outDir: string,
  mounts: string[],
  pages: string[],
): Promise<Set<string>> {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    (req) => {
      const path = new URL(req.url).pathname;
      const mount = mounts.find((m) => path === m || path.startsWith(m + "/"));
      if (!mount) return new Response("outside the export's mounts", { status: 404 });
      return serveDir(req, { fsRoot: outDir, urlRoot: mount.slice(1), quiet: true });
    },
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const seen = new Set<string>();
  try {
    for (const page of pages) {
      const pageUrl = new URL(page, origin);
      const res = await fetch(pageUrl);
      assertEquals(res.status, 200, `${page} → ${res.status}`);
      for (const ref of documentUrls(await res.text())) {
        await assertResolves(new URL(ref, pageUrl), seen);
      }
    }
  } finally {
    ac.abort();
    await server.finished;
  }
  return seen;
}

Deno.test("staticExport under basePath: every asset, chunk and link resolves under the base", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_basepath_" });
  try {
    await scaffoldApp(dir, {
      ...APP,
      "denext.config.ts": `export default { basePath: "/base" };\n`,
    });
    const { outDir } = await exportApp(dir);
    const html = await Deno.readTextFile(join(outDir, "index.html"));
    assertStringIncludes(html, `src="/base/_denext/client/flight-boot.js"`);
    assertStringIncludes(html, `href="/base/_denext/client/index.css"`);
    assertStringIncludes(html, `href="/base/about"`); // <Link> carries the base
    assertStringIncludes(html, `"basePath":"/base"`); // and so does the client's
    const about = await Deno.readTextFile(join(outDir, "about", "index.html"));
    assertStringIncludes(about, `href="/base/_denext/client/about.css"`);
    assertStringIncludes(about, `src="/base/_denext/client/flight.js"`);
    const seen = await assertExportResolves(outDir, ["/base"], ["/base/", "/base/about/"]);
    // The pages' scripts and their chunks, the stylesheet, the link target and the image all
    // resolved — the deferred boot's on-demand import of flight.js included.
    for (
      const part of ["flight-boot.js", "flight.js", "/base/about", "/base/logo.svg", "index.css"]
    ) {
      assert([...seen].some((u) => u.includes(part)), `${part} was referenced and resolved`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("staticExport with assetPrefix: asset URLs take the prefix, links the basePath", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_assetprefix_" });
  try {
    await scaffoldApp(dir, {
      ...APP,
      "denext.config.ts": `export default { basePath: "/base", assetPrefix: "/cdn/" };\n`,
    });
    const { outDir } = await exportApp(dir);
    const html = await Deno.readTextFile(join(outDir, "index.html"));
    assertStringIncludes(html, `src="/cdn/_denext/client/flight-boot.js"`);
    assertStringIncludes(html, `href="/cdn/_denext/client/index.css"`);
    assertStringIncludes(html, `href="/base/about"`);
    // `/cdn` serves the same files (the CDN in front of `_denext/`); nothing else may hit it.
    const seen = await assertExportResolves(outDir, ["/base", "/cdn"], ["/base/", "/base/about/"]);
    for (const u of seen) {
      const path = new URL(u).pathname;
      if (path.includes("/_denext/")) assert(path.startsWith("/cdn/_denext/"), path);
      else assert(path.startsWith("/base/"), path);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
