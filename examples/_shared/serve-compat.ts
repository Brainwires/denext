// The request handler every next-compat example's `serve.ts` shares: the client bundle at
// `clientSrc`, the rendered page at `/` (rebuilt per request in dev), an optional extra
// route hook (static assets, a second page), and a 404 for anything else.

import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";

/** Build an example's single `app/page.tsx` through the next-compat esbuild path. */
export async function buildExamplePage(dir: string, dev: boolean): Promise<BuiltNextCompatPage> {
  const [page] = await buildNextCompatPages({
    projectDir: dir,
    configPath: `${dir}/deno.json`,
    outDir: `${dir}/.denext`,
    pages: [{ routePath: "/", filePath: `${dir}/app/page.tsx` }],
    minify: !dev,
  });
  return page;
}

export interface CompatServeOptions {
  port: number;
  /** The URL the page's `<script type="module">` loads the client bundle from. */
  clientSrc: string;
  /** The built page; in dev it is rebuilt on every `/` request. */
  page: BuiltNextCompatPage;
  dev: boolean;
  rebuild: () => Promise<BuiltNextCompatPage>;
  /** Route params passed to the page render. */
  params?: Record<string, unknown>;
  /** Post-process the rendered document (e.g. inject `<head>` tags). */
  decorate?: (html: string) => string;
  /** Answer a request the shared routes don't cover (static assets…), or null. */
  extra?: (url: URL) => Promise<Response | null>;
}

/** Start serving; logs the URL. */
export function serveCompat(opts: CompatServeOptions, name: string): void {
  let page = opts.page;
  console.log(
    `${name} example on http://localhost:${opts.port}${
      opts.dev ? "  (dev: rebuilds per request)" : ""
    }`,
  );
  Deno.serve({ port: opts.port }, async (req) => {
    const url = new URL(req.url);
    if (opts.dev && url.pathname === "/") page = await opts.rebuild();
    return (await route(url, page, opts)) ?? new Response("Not found", { status: 404 });
  });
}

/** The client bundle, the page, or the example's own extra routes; null when nothing matches. */
async function route(
  url: URL,
  page: BuiltNextCompatPage,
  opts: CompatServeOptions,
): Promise<Response | null> {
  if (url.pathname === opts.clientSrc) return await clientBundle(page);
  if (url.pathname === "/") return await renderRoot(page, opts);
  return opts.extra ? await opts.extra(url) : null;
}

async function clientBundle(page: BuiltNextCompatPage): Promise<Response> {
  return new Response(await Deno.readTextFile(page.clientBundle), {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}

async function renderRoot(page: BuiltNextCompatPage, opts: CompatServeOptions): Promise<Response> {
  const html = await renderNextCompatPage(page, opts.params ?? {}, opts.clientSrc);
  return new Response(opts.decorate ? opts.decorate(html) : html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
