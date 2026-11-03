// `denext build --compile` for the two app shapes beside the native App Router: a Next.js drop-in
// (next-compat: `react` / `next/*` imports through `compatibilityMode`) and a Pages Router app
// (`@denext/pages-router`). Each fixture is built and compiled, its project directory DELETED,
// and the binary run from another directory: its pages (server-rendered, with their client
// bundles), its API routes and its static assets must all come from what it embedded. The Pages
// Router app also uses what its server render loads through the build's server copies: a
// platform file (`.web.tsx`), `"use cache"` and an inline `"use server"` function.
//
// Heavy (two builds and two `deno compile`s, ~300 MB each): run it where there is room.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { removeTempDir } from "../helpers/temp.ts";
import { boundedOutput } from "../helpers/bounded-command.ts";
import { boundPort } from "../helpers/port.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FW_URL = toFileUrl(FW).href;

/** A Next.js App Router drop-in: React and `next/*` imports, nothing denext-specific. */
const NEXT_COMPAT: Record<string, string> = {
  "deno.json": JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  "denext.config.ts": "export default { compatibilityMode: true };\n",
  "app/globals.css": ".page { color: rgb(7, 8, 9); }\n",
  "app/layout.tsx": `import type { ReactNode } from "react";
import "./globals.css";
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/counter.tsx": `"use client";
import { useState } from "react";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
`,
  "app/page.tsx": `import Link from "next/link";
import { Counter } from "./counter";
export default async function Home() {
  const greeting = await Promise.resolve("drop-in rendered");
  return <main className="page"><h1>{greeting}</h1><Counter /><Link href="/about">About</Link></main>;
}
`,
  "app/about/page.tsx": `export default function About() {
  return <h1>about the drop-in</h1>;
}
`,
  "app/api/hello/route.ts": `import { NextResponse } from "next/server";
export function GET(request: Request) {
  return NextResponse.json({ hello: new URL(request.url).searchParams.get("name") });
}
`,
  // A route reading a file beside itself (an OG image route's font): the bundled module's
  // `import.meta.url` names its embedded source file.
  "app/api/og/route.ts": `import fs from "node:fs/promises";
export async function GET() {
  return new Response(await fs.readFile(new URL("./Inter-SemiBold.ttf", import.meta.url)));
}
`,
  "app/api/og/Inter-SemiBold.ttf": "font bytes beside the route\n",
  "public/hello.txt": "hello from the drop-in\n",
};

/** A Pages Router app on the `@denext/pages-router` plugin. */
const PAGES_ROUTER: Record<string, string> = {
  "deno.json": JSON.stringify({
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "@denext/denext",
      lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
    },
    imports: {
      "@denext/denext": `${FW_URL}mod.ts`,
      "@denext/denext/jsx-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
      "@denext/denext/jsx-dev-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
      "@denext/denext/client": `${FW_URL}src/client/mod.ts`,
      "@denext/denext/server": `${FW_URL}src/server/mod.ts`,
      "@denext/denext/bundle": `${FW_URL}src/build/plugin-bundle.ts`,
      "@denext/pages-router": `${FW_URL}packages/pages-router/mod.ts`,
      "@denext/pages-router/router": `${FW_URL}packages/pages-router/router.ts`,
      "@denext/pages-router/link": `${FW_URL}packages/pages-router/link.ts`,
      "@denext/pages-router/head": `${FW_URL}packages/pages-router/head.ts`,
      "@denext/pages-router/document": `${FW_URL}packages/pages-router/src/document.ts`,
      "@denext/pages-router/client-runtime": `${FW_URL}packages/pages-router/src/client-runtime.ts`,
      "@std/path": "jsr:@std/path@^1.0.0",
    },
  }),
  "denext.config.ts": `import { pagesRouter } from "@denext/pages-router";
export default { plugins: [pagesRouter()], cacheComponents: true };
`,
  "components/variant.tsx": "export function Variant() { return <p>plain variant</p>; }\n",
  "components/variant.web.tsx": "export function Variant() { return <p>web variant</p>; }\n",
  "lib/stamp.ts": `export async function stamp(): Promise<string> {
  "use cache";
  return crypto.randomUUID();
}
`,
  "lib/actions.ts": `export async function act(): Promise<number> {
  "use server";
  return 1;
}
`,
  "pages/cached.tsx": `import { stamp } from "../lib/stamp.ts";
export async function getServerSideProps() {
  return { props: { stamp: await stamp() } };
}
export default function Cached({ stamp }: { stamp: string }) {
  return <p>stamp[{stamp}]</p>;
}
`,
  "pages/api/action.ts": `import { act } from "../../lib/actions.ts";
// deno-lint-ignore no-explicit-any
export default function handler(_req: any, res: any) {
  res.status(200).json({ reference: typeof (act as any).denextActionId });
}
`,
  "styles/globals.css": ".shell { color: rgb(1, 2, 3); }\n",
  "pages/_app.tsx": `import "../styles/globals.css";
// deno-lint-ignore no-explicit-any
export default function App({ Component, pageProps }: { Component: any; pageProps: any }) {
  return <div><header className="shell">pages shell</header><Component {...pageProps} /></div>;
}
`,
  "pages/index.tsx": `import { useState } from "@denext/denext";
import { Link } from "@denext/pages-router/link";
import { Variant } from "../components/variant.tsx";
export default function Home() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1>pages home</h1>
      <Variant />
      <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>
      <Link href="/blog/hello">Post</Link>
    </main>
  );
}
`,
  "pages/blog/[slug].tsx":
    `export function getServerSideProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}
export default function Post({ slug }: { slug: string }) {
  return <h1>post {slug} from gssp</h1>;
}
`,
  "pages/api/hello.ts": `// deno-lint-ignore no-explicit-any
export default function handler(req: any, res: any) {
  res.status(200).json({ hello: req.query.name ?? null });
}
`,
  "public/hello.txt": "hello from the pages app\n",
};

/**
 * A Pages Router app on npm React (the plugin's compat path: `react` imports, `compatibilityMode`):
 * its server render loads the compat bundles the build recorded, as the binary can neither build
 * them nor write them into its embedded `.denext`.
 */
const COMPAT_PAGES: Record<string, string> = {
  // As `denext migrate` writes it: `react` aliased to denext's compat modules.
  "deno.json": JSON.stringify({
    nodeModulesDir: "auto",
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
    imports: {
      "@denext/pages-router": `${FW_URL}packages/pages-router/mod.ts`,
      "react": `${FW_URL}src/compat/react.ts`,
      "react/jsx-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
      "react/jsx-dev-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
      "react-dom": `${FW_URL}src/compat/react-dom.ts`,
    },
  }),
  "denext.config.ts": `import { pagesRouter } from "@denext/pages-router";
export default { compatibilityMode: true, plugins: [pagesRouter()] };
`,
  "pages/_app.tsx": `// deno-lint-ignore no-explicit-any
export default function App({ Component, pageProps }: { Component: any; pageProps: any }) {
  return <div className="shell"><Component {...pageProps} /></div>;
}
`,
  "pages/index.tsx": `import { useState } from "react";
export default function Home() {
  const [n] = useState(3);
  return <main><h1>compat pages home</h1><p>count {n}</p></main>;
}
`,
  "pages/post/[id].tsx":
    `export function getServerSideProps({ params }: { params: { id: string } }) {
  return { props: { id: params.id } };
}
export default function Post({ id }: { id: string }) {
  return <h1>compat post {id}</h1>;
}
`,
  "pages/api/hello.ts": `// deno-lint-ignore no-explicit-any
export default function handler(req: any, res: any) {
  res.status(200).json({ compat: req.query.name ?? null });
}
`,
  "public/hello.txt": "hello from the compat pages app\n",
};

/** Write `files` under `dir`. */
async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
}

/**
 * Build and compile `project` into `bin` with the CLI running under `config` (the drop-in's own
 * deno.json maps nothing the CLI imports, as a real one run through the installed CLI); exits
 * non-zero → the output in the error.
 */
async function compile(project: string, bin: string, config: string): Promise<void> {
  const r = await boundedOutput(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      config,
      join(FW, "cli.ts"),
      "build",
      "--compile",
      "--output",
      bin,
      project,
    ],
    cwd: project,
    env: { NO_COLOR: "1" },
    // A compile build on a loaded runner: a failure bound, not a latency claim.
    timeoutMs: 900_000,
  });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  assertEquals(r.code, 0, out);
}

/** A running binary. */
interface Served {
  get(path: string): Promise<{ status: number; type: string; text: string }>;
  stop(): Promise<string>;
}

/**
 * Start `bin` in `cwd` on `--port 0` and wait until `/` answers 200 on the port it says it bound
 * (nothing picks a port another process could take first).
 */
async function serve(bin: string, cwd: string): Promise<Served> {
  const child = new Deno.Command(bin, {
    args: ["--port", "0"],
    cwd,
    env: { NO_COLOR: "1" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const d = new TextDecoder();
    for await (const chunk of stream) output += d.decode(chunk, { stream: true });
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let exited = false;
  child.status.then(() => exited = true);
  const port = await boundPort(() => output, () => exited);
  const origin = `http://127.0.0.1:${port}`;
  const get = async (path: string) => {
    const res = await fetch(origin + path);
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      text: await res.text(),
    };
  };
  const stop = async () => {
    if (!exited) child.kill("SIGTERM");
    await child.status;
    await drained;
    return output;
  };
  for (let i = 0; i < 1200 && port !== undefined && !exited; i++) {
    try {
      if ((await get("/")).status === 200) return { get, stop };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the binary never served /:\n${await stop()}`);
}

/** Every same-origin `<script src>` / stylesheet `<link href>` of `html`: each must load. */
async function assertAssetsLoad(app: Served, html: string): Promise<string[]> {
  const urls = [
    ...html.matchAll(/<script[^>]*\ssrc="(\/[^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(\/[^"]+)"/g),
    ...html.matchAll(/<link[^>]*href="(\/[^"]+)"[^>]*rel="stylesheet"/g),
  ].map((m) => m[1]);
  const bodies: string[] = [];
  for (const url of new Set(urls)) {
    const res = await app.get(url);
    assertEquals(res.status, 200, url);
    bodies.push(res.text);
  }
  return bodies;
}

/** Compile `files`, delete the project, serve the binary from another directory and run `check`. */
async function compiledApp(
  prefix: string,
  files: Record<string, string>,
  cliConfig: "project" | "framework",
  check: (app: Served) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix }));
  const project = join(root, "project");
  const runDir = join(root, "run");
  const bin = join(root, "bin", Deno.build.os === "windows" ? "app.exe" : "app");
  try {
    await writeFiles(project, files);
    await Deno.mkdir(runDir);
    await compile(
      project,
      bin,
      cliConfig === "project" ? join(project, "deno.json") : join(FW, "deno.json"),
    );
    // Nothing left to read from: the binary must carry everything.
    await Deno.remove(project, { recursive: true });
    const app = await serve(bin, runDir);
    let output = "";
    try {
      await check(app);
    } finally {
      output = await app.stop();
    }
    assert(!output.includes("Module not found"), output);
  } finally {
    await removeTempDir(root);
  }
}

Deno.test({
  name: "denext build --compile: a next-compat drop-in app serves pages, API routes and assets",
  fn: () =>
    compiledApp("denext_compile_compat_", NEXT_COMPAT, "framework", async (app) => {
      const home = await app.get("/");
      assertEquals(home.status, 200);
      assertStringIncludes(home.text, "drop-in rendered");
      assertStringIncludes(home.text, "Clicked 0");
      assertStringIncludes(home.text, 'href="/about"');
      const assets = await assertAssetsLoad(app, home.text);
      assert(assets.some((css) => css.includes("#070809")), "the global stylesheet is served");
      const about = await app.get("/about");
      assertEquals(about.status, 200);
      assertStringIncludes(about.text, "about the drop-in");
      const hello = await app.get("/api/hello?name=bin");
      assertEquals(hello.status, 200);
      assertEquals(JSON.parse(hello.text), { hello: "bin" });
      const og = await app.get("/api/og");
      assertEquals(og.status, 200, og.text);
      assertEquals(og.text, "font bytes beside the route\n");
      assertEquals((await app.get("/hello.txt")).text, "hello from the drop-in\n");
      assertEquals((await app.get("/missing")).status, 404);
    }),
});

Deno.test({
  name: "denext build --compile: a Pages Router app serves pages, API routes and assets",
  fn: () =>
    compiledApp("denext_compile_pages_", PAGES_ROUTER, "project", async (app) => {
      const home = await app.get("/");
      assertEquals(home.status, 200);
      assertStringIncludes(home.text, "pages home");
      assertStringIncludes(home.text, "pages shell");
      assertStringIncludes(home.text, "Clicked 0");
      assertStringIncludes(home.text, "web variant", "the server render takes the .web file");
      const assets = await assertAssetsLoad(app, home.text);
      assert(assets.length > 0, "the page loads its client bundle");
      // `"use cache"`: the second render reuses the first one's value.
      const stamps: (string | undefined)[] = [];
      for (let i = 0; i < 2; i++) {
        const res = await app.get("/cached");
        assertEquals(res.status, 200);
        stamps.push(/stamp\[(?:<!-- -->)?([\w-]+)/.exec(res.text)?.[1]);
      }
      assert(stamps[0] !== undefined && stamps[0] === stamps[1], `cached: ${stamps}`);
      // The inline `"use server"` function is a registered server reference.
      assertEquals(JSON.parse((await app.get("/api/action")).text), { reference: "string" });
      const post = await app.get("/blog/hello");
      assertEquals(post.status, 200);
      assertStringIncludes(post.text, "post hello from gssp");
      const hello = await app.get("/api/hello?name=bin");
      assertEquals(hello.status, 200);
      assertEquals(JSON.parse(hello.text), { hello: "bin" });
      assertEquals((await app.get("/hello.txt")).text, "hello from the pages app\n");
      assertEquals((await app.get("/missing")).status, 404);
    }),
});

Deno.test({
  name: "denext build --compile: a compat (npm React) Pages Router app serves its pages",
  fn: () =>
    compiledApp("denext_compile_compat_pages_", COMPAT_PAGES, "framework", async (app) => {
      const home = await app.get("/");
      assertEquals(home.status, 200);
      assertStringIncludes(home.text, "compat pages home");
      assert(/count (?:<!-- -->)?3/.test(home.text), home.text);
      assertStringIncludes(home.text, 'class="shell"');
      const post = await app.get("/post/7");
      assertEquals(post.status, 200);
      assertStringIncludes(post.text, "compat post");
      const hello = await app.get("/api/hello?name=bin");
      assertEquals(JSON.parse(hello.text), { compat: "bin" });
      assertEquals((await app.get("/hello.txt")).text, "hello from the compat pages app\n");
    }),
});
