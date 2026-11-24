// `denext export` writes the non-page files Next's `output: "export"` writes: each route
// handler's GET response at its URL, and the metadata file conventions (sitemap, robots,
// favicon, web manifest, icon / Open Graph images). A static image file keeps its extension
// (`icon.png`), and the pages link it there, under the basePath.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { boundedOutput } from "../helpers/bounded-command.ts";
import { CHILD_DEADLINE_MS } from "../helpers/isolated.ts";
import { samplePng } from "../fixtures/sample-image.ts";

const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

async function exportApp(
  dir: string,
  env: Record<string, string> = {},
): Promise<{ outDir: string; log: string }> {
  const out = await boundedOutput(Deno.execPath(), {
    args: ["run", "-A", CLI, "export", dir],
    cwd: dir,
    env,
    timeoutMs: CHILD_DEADLINE_MS,
  });
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, log);
  return { outDir: join(dir, "out"), log };
}

async function writeApp(dir: string, config: string): Promise<void> {
  const root = new URL("../../", import.meta.url).href;
  const files: Record<string, string | Uint8Array> = {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${root}mod.ts`,
        "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
        "denext/server": `${root}src/server/mod.ts`,
      },
    }),
    "denext.config.ts": config,
    "app/layout.tsx": `export default function L({ children }: { children: unknown }) {
  return <html><body>{children}</body></html>;
}
`,
    "app/page.tsx": `export default function P() { return <main>SF_HOME</main>; }\n`,
    "app/api/hello/route.ts": `export const dynamic = "force-static";
export function GET() { return Response.json({ hello: "sf" }); }
`,
    "app/feed.xml/route.ts": `export const dynamic = "force-static";
export function GET() {
  return new Response("<rss/>", { headers: { "content-type": "application/rss+xml" } });
}
`,
    "app/items/[id]/route.ts": `export const revalidate = 60;
export function generateStaticParams() { return [{ id: "1" }, { id: "2" }, { id: "café" }]; }
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return Response.json({ id: (await params).id });
}
`,
    "app/live/route.ts": `export const dynamic = "force-dynamic";
export function GET() { return new Response("never"); }
`,
    "app/submit/route.ts": `export function POST() { return new Response("posted"); }\n`,
    "app/gone/route.ts": `export const dynamic = "force-static";
export function GET() { return new Response("no", { status: 404 }); }
`,
    // A GET not marked static: Next's export requires force-static; it is skipped, not run.
    "app/api/users/route.ts": `export function GET() {
  Deno.writeTextFileSync("ran-users-get", "x");
  return Response.json([]);
}
`,
    // A POST-only route whose module throws on import: never imported.
    "app/api/hook/route.ts": `throw new Error("needs DATABASE_URL");
export function POST() { return new Response("posted"); }
`,
    // A static GET whose module throws on import: skipped and listed, the export goes on.
    "app/broken/route.ts": `export const dynamic = "force-static";
throw new Error("BROKEN_IMPORT");
export function GET() { return new Response("never"); }
`,
    // An event stream: skipped, never awaited to its end.
    "app/events/route.ts": `export const dynamic = "force-static";
export function GET() {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: 1\\n\\n")); } });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
`,
    // A static GET whose body never ends: skipped at the response deadline.
    "app/endless/route.ts": `export const dynamic = "force-static";
export function GET() {
  return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } }));
}
`,
    "app/sitemap.ts":
      `export default function sitemap() { return [{ url: "https://sf.example/" }]; }\n`,
    "app/robots.ts":
      `export default function robots() { return { rules: { userAgent: "*", disallow: "/x" } }; }\n`,
    "app/manifest.ts": `export default function manifest() { return { name: "SF" }; }\n`,
    "app/favicon.ico": samplePng(),
    "app/icon.png": samplePng(),
    "app/opengraph-image.png": samplePng(),
  };
  for (const [name, data] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    if (typeof data === "string") await Deno.writeTextFile(join(dir, name), data);
    else await Deno.writeFile(join(dir, name), data);
  }
}

Deno.test({
  name: "export: route handlers' GET responses and the metadata files are written at their URLs",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_static_files_" });
  try {
    await writeApp(dir, "export default {};\n");
    const { outDir, log } = await exportApp(dir, { DENEXT_EXPORT_RESPONSE_TIMEOUT_MS: "1500" });
    const read = (p: string) => Deno.readTextFile(join(outDir, p));
    // Route handlers: GET (a plain one, force-static, and each generateStaticParams set).
    assertEquals(JSON.parse(await read("api/hello")), { hello: "sf" });
    assertEquals(await read("feed.xml"), "<rss/>");
    assertEquals(JSON.parse(await read("items/1")), { id: "1" });
    assertEquals(JSON.parse(await read("items/2")), { id: "2" });
    // A param is written under its decoded name, the file a static host serves for the URL.
    assertEquals(JSON.parse(await read("items/café")), { id: "café" });
    assertEquals(await exists(join(outDir, "items", "caf%C3%A9")), false);
    // No GET, force-dynamic, or a non-2xx answer: no file; the latter two are reported.
    assertEquals(await exists(join(outDir, "submit")), false);
    assertEquals(await exists(join(outDir, "live")), false);
    assertEquals(await exists(join(outDir, "gone")), false);
    assertStringIncludes(log, 'skip /live — export const dynamic = "force-dynamic"');
    assertStringIncludes(log, "skip /gone — answered 404");
    // Not marked static: listed, and the handler never ran on the build machine.
    assertEquals(await exists(join(outDir, "api", "users")), false);
    assertStringIncludes(log, "skip /api/users — not marked static");
    assertEquals(await exists(join(dir, "ran-users-get")), false);
    // A POST-only module is not imported; a static one that fails to import is listed.
    assert(!log.includes("needs DATABASE_URL"), log);
    assertStringIncludes(log, "skip /broken — module failed to load: BROKEN_IMPORT");
    // Streams: an event stream is skipped at once, an endless body at the deadline, by name.
    assertEquals(await exists(join(outDir, "events")), false);
    assertStringIncludes(log, "skip /events — answered an event stream");
    assertEquals(await exists(join(outDir, "endless")), false);
    assertStringIncludes(log, "skip /endless — GET did not finish within 1500 ms");
    // Metadata files.
    assertStringIncludes(await read("sitemap.xml"), "<loc>https://sf.example/</loc>");
    assertStringIncludes(await read("robots.txt"), "Disallow: /x");
    assertEquals(JSON.parse(await read("manifest.webmanifest")), { name: "SF" });
    const png = samplePng();
    for (const f of ["favicon.ico", "icon.png", "opengraph-image.png"]) {
      assertEquals(await Deno.readFile(join(outDir, f)), png, f);
    }
    // The pages link the static images by their exported names.
    const html = await read("index.html");
    assertStringIncludes(html, `<link rel="icon" href="/icon.png">`);
    assertStringIncludes(html, `<meta property="og:image" content="/opengraph-image.png">`);
    assertStringIncludes(html, `<link rel="manifest" href="/manifest.webmanifest">`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "export: under a basePath the pages link the metadata files under it",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_static_files_base_" });
  try {
    await writeApp(dir, `export default { basePath: "/docs" };\n`);
    const { outDir } = await exportApp(dir, { DENEXT_EXPORT_RESPONSE_TIMEOUT_MS: "1500" });
    const html = await Deno.readTextFile(join(outDir, "index.html"));
    assertStringIncludes(html, `<link rel="icon" href="/docs/icon.png">`);
    assertStringIncludes(html, `<meta property="og:image" content="/docs/opengraph-image.png">`);
    assertStringIncludes(html, `<link rel="manifest" href="/docs/manifest.webmanifest">`);
    // The files themselves sit at the export's root (the host serves it under the basePath).
    assert(await exists(join(outDir, "icon.png")));
    assert(await exists(join(outDir, "api", "hello")));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
