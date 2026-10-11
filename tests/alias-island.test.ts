// A `"use client"` island a page reaches only through an import-map alias (`@/components/…` with
// `"@/": "./"` in the app's deno.json) hydrates on every path: the boundary / hydration crawls run
// `deno info` in the app's folder, so Deno resolves the alias through the app's own import map even
// when the build runs from another directory (`denext build ./app`, an in-process `build(dir)`).
// Before, the crawl took the CALLER's config, missed the island, and the route shipped no client JS.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { build } from "../src/build/build.ts";

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
    await build(dir);
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

/** A free loopback port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

// `denext dev <dir>` as a user runs it from another folder (the CLI's own process; an in-process
// dev server could not render `@/` here, whose import map is denext's own).
for (const unbundled of [true, false]) {
  const loop = unbundled ? "unbundled" : "bundled";
  Deno.test(`denext dev <dir> (CLI, ${loop}) from another folder: an aliased island is in the Flight entry`, async () => {
    const dir = await aliasApp();
    const elsewhere = await Deno.makeTempDir({ prefix: "denext_alias_cwd_" });
    const port = freePort();
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", abs("cli.ts"), "dev", dir, "--port", String(port)],
      cwd: elsewhere,
      env: { DENEXT_DEV_UNBUNDLED: unbundled ? "1" : "0" },
      stdout: "null",
      stderr: "null",
    }).spawn();
    const text = async (path: string) =>
      await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
    try {
      let html = "";
      for (let i = 0; i < 240 && !html; i++) { // up to ~60 s for the server to come up
        html = await text("/").catch(() => "");
        if (!html) await new Promise((r) => setTimeout(r, 250));
      }
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
      child.kill("SIGTERM");
      await child.status;
      await Deno.remove(elsewhere, { recursive: true });
      await Deno.remove(dir, { recursive: true });
    }
  });
}
