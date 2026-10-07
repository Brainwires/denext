// The server render's copy loader (src/build/use-cache-loader.ts) under the conditions a server
// meets: concurrent loads sharing a module (`denext start` warms every route with
// `Promise.all`), import cycles, and a copied module that reads a file beside itself through
// `import.meta` — for platform redirects and for `"use cache"` alike.

import { assert, assertEquals } from "@std/assert";
import { dirname, join, toFileUrl } from "@std/path";
import { projectPlatformRedirects } from "../src/build/platform-extensions.ts";
import { createUseCacheLoader } from "../src/build/use-cache-loader.ts";
import type { ModuleLoader } from "../src/server/types.ts";

/** A temp dir holding `files` (relative path → contents). */
async function tree(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_platform_loader_" }));
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

const base: ModuleLoader = (p) => import(p.startsWith("file:") ? p : toFileUrl(p).href);

/** The web target's copy loader for `dir`. */
async function webLoader(dir: string, useCache = false): Promise<ModuleLoader> {
  return createUseCacheLoader(base, {
    projectDir: dir,
    cacheDir: join(dir, ".denext", "server-cache"),
    redirects: await projectPlatformRedirects(dir, {}, "web"),
    useCache,
  });
}

Deno.test("copy loader: concurrent loads sharing a module all take the variant", async () => {
  const dir = await tree({
    "a.tsx": `import { Nav } from "./nav.tsx";\nexport const A = Nav;\n`,
    "b.tsx": `import { Nav } from "./nav.tsx";\nexport const B = Nav;\n`,
    "c.tsx": `import { Btn } from "./btn.tsx";\nexport const C = Btn;\n`,
    "nav.tsx": `import { Btn } from "./btn.tsx";\nexport const Nav = Btn;\n`,
    "btn.tsx": `export const Btn = "plain";\n`,
    "btn.web.tsx": `export const Btn = "web";\n`,
  });
  try {
    const load = await webLoader(dir);
    const [a, b, c] = await Promise.all(
      ["a.tsx", "b.tsx", "c.tsx"].map((f) => load(join(dir, f))),
    ) as [{ A: string }, { B: string }, { C: string }];
    assertEquals([a.A, b.B, c.C], ["web", "web", "web"]);
    // Memoized for the loader's life: a later load agrees.
    assertEquals((await load(join(dir, "b.tsx")) as { B: string }).B, "web");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("copy loader: an import cycle is copied whole and reaches the variant", async () => {
  const dir = await tree({
    "page.tsx": `import { a } from "./a.tsx";\nexport const got = a();\n`,
    "a.tsx": `import { b } from "./b.tsx";\nexport function a() { return "a+" + b(); }\n` +
      `export const fromA = "A";\n`,
    "b.tsx": `import { fromA } from "./a.tsx";\nimport { Btn } from "./btn.tsx";\n` +
      `export function b() { return fromA + ":" + Btn; }\n`,
    "btn.tsx": `export const Btn = "plain";\n`,
    "btn.web.tsx": `export const Btn = "web";\n`,
  });
  try {
    const load = await webLoader(dir);
    // Entered from two members of the cycle at once.
    const [page, b] = await Promise.all([
      load(join(dir, "page.tsx")),
      load(join(dir, "b.tsx")),
    ]) as [{ got: string }, { b: () => string }];
    assertEquals(page.got, "a+A:web");
    assertEquals(b.b(), "A:web");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("copy loader: a copy's import.meta names the original module", async () => {
  const dir = await tree({
    "page.tsx": `import { Btn } from "./btn.tsx";\n` +
      `export const text = Deno.readTextFileSync(new URL("./data.txt", import.meta.url));\n` +
      `export const meta = [import.meta.filename, import.meta.dirname];\n` +
      `export const resolved = import.meta.resolve("./data.txt");\n` +
      `const { url } = import.meta;\nexport const whole = url;\n` +
      `export const btn = Btn;\n`,
    "data.txt": "hello",
    "btn.tsx": `export const Btn = "plain";\n`,
    "btn.web.tsx": `export const Btn = "web";\n`,
  });
  try {
    const loads: string[] = [];
    const load = createUseCacheLoader((p) => {
      loads.push(p);
      return base(p);
    }, {
      projectDir: dir,
      cacheDir: join(dir, ".denext", "server-cache"),
      redirects: await projectPlatformRedirects(dir, {}, "web"),
      useCache: false,
    });
    const page = join(dir, "page.tsx");
    const mod = await load(page) as Record<string, unknown>;
    assert(loads[0].includes("/.denext/server-cache/"), "the page was copied");
    assertEquals(mod.btn, "web");
    assertEquals(mod.text, "hello");
    assertEquals(mod.meta, [page, dirname(page)]);
    assertEquals(mod.resolved, toFileUrl(join(dir, "data.txt")).href);
    assertEquals(mod.whole, toFileUrl(page).href);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("copy loader: a `use cache` copy's import.meta names the original module", async () => {
  const dir = await tree({
    "page.ts": `export async function read() { "use cache";\n` +
      `  return await Deno.readTextFile(new URL("./data.txt", import.meta.url)); }\n`,
    "data.txt": "cached",
  });
  try {
    const load = await webLoader(dir, true);
    const mod = await load(join(dir, "page.ts")) as { read: () => Promise<string> };
    assertEquals(await mod.read(), "cached");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * A copy's dynamic imports resolve like its static ones: a literal `import()` (relative, a
 * template literal with no substitutions, or an import-map alias) is rewritten to the module the
 * target loads — the variant, or its copy — and a non-literal one resolves a relative specifier
 * against the original module.
 */
const DYNAMIC_IMPORTS = `export const lazy = () => import("./lazy.ts").then((m) => m.v);\n` +
  "export const tpl = () => import(`./other.ts`).then((m) => m.o);\n" +
  `export const aliased = () => import("@/lazy.ts").then((m) => m.v);\n` +
  `export const byName = (n: string) => import("./" + n).then((m) => m.o);\n`;

const DYNAMIC_FILES = {
  "deno.json": JSON.stringify({ imports: { "@/": "./" } }),
  "lazy.ts": `export const v = "plain";\n`,
  "lazy.web.ts": `export const v = "web";\n`,
  "other.ts": `export const o = "other";\n`,
};

type Dynamic = {
  lazy: () => Promise<string>;
  tpl: () => Promise<string>;
  aliased: () => Promise<string>;
  byName: (n: string) => Promise<string>;
};

Deno.test("copy loader: a platform copy's dynamic imports resolve from the original", async () => {
  const dir = await tree({
    ...DYNAMIC_FILES,
    // The variant import makes the page a copy.
    "page.tsx": `import { Btn } from "./btn.tsx";\nexport const btn = Btn;\n` + DYNAMIC_IMPORTS,
    "btn.tsx": `export const Btn = "plain";\n`,
    "btn.web.tsx": `export const Btn = "web";\n`,
  });
  try {
    const mod = await (await webLoader(dir))(join(dir, "page.tsx")) as Dynamic & { btn: string };
    assertEquals(mod.btn, "web");
    assertEquals(await mod.lazy(), "web");
    assertEquals(await mod.tpl(), "other");
    assertEquals(await mod.aliased(), "web");
    assertEquals(await mod.byName("other.ts"), "other");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("copy loader: a `use cache` copy's dynamic imports resolve from the original", async () => {
  const dir = await tree({
    ...DYNAMIC_FILES,
    "page.ts": `export async function cached() { "use cache";\n` +
      `  return (await import("./other.ts")).o + ":" + (await import("./" + "other.ts")).o; }\n` +
      DYNAMIC_IMPORTS,
  });
  try {
    const mod = await (await webLoader(dir, true))(join(dir, "page.ts")) as Dynamic & {
      cached: () => Promise<string>;
    };
    assertEquals(await mod.cached(), "other:other");
    assertEquals(await mod.lazy(), "web");
    assertEquals(await mod.tpl(), "other");
    assertEquals(await mod.aliased(), "web");
    assertEquals(await mod.byName("other.ts"), "other");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
