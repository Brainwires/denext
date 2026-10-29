// A `"use client"` island a page reaches only through an import-map alias (`@/components/…` with
// `"@/": "./"` in the app's deno.json) hydrates on every path: the boundary / hydration crawls run
// `deno info` in the app's folder, so Deno resolves the alias through the app's own import map even
// when the build runs from another directory (`denext build ./app`, an in-process `build(dir)`).
// Before, the crawl took the CALLER's config, missed the island, and the route shipped no client JS.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildInChild } from "./helpers/bounded-build.ts";
import { boundPort, listenedPort } from "./helpers/port.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** A one-page native App Router app whose only island is imported through `@/`. */
async function aliasApp(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_alias_island_" }));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      nodeModulesDir: "manual",
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
        "@/": "./",
      },
    }),
  );
  const files: Record<string, string> = {
    "app/page.tsx": `import { Counter } from "@/components/Counter.tsx";\n` +
      `export default function Page(){ return <main><Counter/></main>; }\n`,
    "components/Counter.tsx": `"use client"\nimport { useState } from "denext";\n` +
      `export function Counter(){ const [n, setN] = useState(0);\n` +
      `  return <button type="button" onClick={() => setN(n + 1)}>COUNT_MARK{n}</button>; }\n`,
  };
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

/** Every `.js` file under `dir`, concatenated. */
async function allJs(dir: string): Promise<string> {
  let js = "";
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(dir, e.name));
  }
  return js;
}

/** The built manifest's static routes and client JS. */
async function builtOutput(dir: string) {
  const manifest = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "manifest.json")));
  return {
    staticRoutes: (manifest.staticRoutes ?? []) as string[],
    js: await allJs(join(dir, ".denext", "client")),
  };
}

/** The CLI (`denext <args> <dir>`) run from a folder outside the app. */
async function cliFromElsewhere(args: string[], dir: string): Promise<void> {
  const elsewhere = await Deno.makeTempDir({ prefix: "denext_alias_cwd_" });
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", abs("cli.ts"), ...args, dir],
      cwd: elsewhere,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assert(out.success, log);
    assert(!log.includes("ship no client JS"), log);
  } finally {
    await Deno.remove(elsewhere, { recursive: true });
  }
}

Deno.test("build(dir) from another folder: an island reached only through an alias hydrates", async () => {
  const dir = await aliasApp();
  try {
    await buildInChild(dir);
    const got = await builtOutput(dir);
    assertEquals(got.staticRoutes, [], "the route is not static");
    assertStringIncludes(got.js, "COUNT_MARK", "the island is bundled");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext build <dir> (CLI) from another folder: an aliased island hydrates", async () => {
  const dir = await aliasApp();
  try {
    await cliFromElsewhere(["build"], dir);
    const got = await builtOutput(dir);
    assertEquals(got.staticRoutes, []);
    assertStringIncludes(got.js, "COUNT_MARK");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext export <dir> (CLI) from another folder: an aliased island hydrates", async () => {
  const dir = await aliasApp();
  try {
    await cliFromElsewhere(["export"], dir);
    const html = await Deno.readTextFile(join(dir, "out", "index.html"));
    assertStringIncludes(html, "COUNT_MARK", "the island is server-rendered");
    assertStringIncludes(html, "/_denext/", "the page loads client JS");
    assertStringIncludes(await allJs(join(dir, "out", "_denext", "client")), "COUNT_MARK");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * `denext dev <dir>` from `cwd` on `--port 0`, once it answers `/` on the port it says it bound
 * (its output kept for a failure).
 */
async function startDev(dir: string, cwd: string, unbundled: boolean) {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", abs("cli.ts"), "dev", dir, "--port", "0"],
    cwd,
    env: { DENEXT_DEV_UNBUNDLED: unbundled ? "1" : "0" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Keep the server's output: a cold CI cache can take a while, and a real failure should say why.
  let errText = "";
  let port: number | undefined; // read before the tail is cut
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of stream) {
      errText += dec.decode(c, { stream: true });
      port ??= listenedPort(errText);
      errText = errText.slice(-4000);
    }
  };
  const errDone = Promise.all([read(child.stdout), read(child.stderr)]);
  let exited = false;
  child.status.then(() => exited = true);
  await boundPort(() => port, () => exited);
  const text = async (path: string) =>
    await (await fetch(`http://localhost:${port}${path}`)).text();
  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch { /* exited */ }
    await child.status;
    await errDone;
  };
  let html = "";
  for (let i = 0; i < 720 && port !== undefined && !html && !exited; i++) { // ~3 min (cold cache)
    html = await text("/").catch(() => "");
    if (!html) await new Promise((r) => setTimeout(r, 250));
  }
  if (!html) {
    await stop();
    throw new Error(`the dev server never answered; its output ended with:\n${errText}`);
  }
  return { html, text, stop };
}

// `denext dev <dir>` as a user runs it from another folder (the CLI's own process; an in-process
// dev server could not render `@/` here, whose import map is denext's own).
for (const unbundled of [true, false]) {
  const loop = unbundled ? "unbundled" : "bundled";
  Deno.test(`denext dev <dir> (CLI, ${loop}) from another folder: an aliased island is in the Flight entry`, async () => {
    const dir = await aliasApp();
    const elsewhere = await Deno.makeTempDir({ prefix: "denext_alias_cwd_" });
    let server: Awaited<ReturnType<typeof startDev>> | undefined;
    try {
      server = await startDev(dir, elsewhere, unbundled);
      const { html, text } = server;
      assertStringIncludes(html, "COUNT_MARK");
      assertStringIncludes(html, "/_denext/flight.js", "the page boots the Flight islands");
      const entry = await text("/_denext/flight.js");
      const chunks = [...entry.matchAll(/import\("\.\/([^"]+\.js)"\)/g)].map((c) => c[1]);
      let flight = entry;
      for (const c of chunks) flight += await text(`/_denext/${c}`);
      assert(
        flight.includes("Counter.tsx") || flight.includes("COUNT_MARK"),
        "the Flight entry carries the aliased island",
      );
    } finally {
      await server?.stop();
      await Deno.remove(elsewhere, { recursive: true });
      await Deno.remove(dir, { recursive: true });
    }
  });
}
