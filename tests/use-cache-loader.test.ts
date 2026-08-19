// Part B3: the server-side `use cache` loader — transitive transformation so a
// directive-free module that imports a cached helper still hits the cache.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { createUseCacheLoader } from "../src/build/use-cache-loader.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { inMemoryCacheStore, setCacheStore } from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";

const base: ModuleLoader = (p) => import(p.startsWith("file:") ? p : toFileUrl(p).href);

const JSX_RUNTIME = toFileUrl(join(Deno.cwd(), "src/jsx/jsx-runtime.ts")).href;

Deno.test("B3: a directive-free module reaches its cached helper through the loader", async () => {
  setCacheStore(inMemoryCacheStore());
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "lib"));
    // The helper opts into caching; `count` observes how many times the body ran.
    await Deno.writeTextFile(
      join(dir, "lib", "data.ts"),
      `let calls = 0;\n` +
        `export async function getPosts() { "use cache"; calls++; return calls; }\n` +
        `export function count() { return calls; }\n`,
    );
    // The page has NO directive; it merely imports the cached helper.
    await Deno.writeTextFile(
      join(dir, "page.ts"),
      `import { count, getPosts } from "./lib/data.ts";\n` +
        `export async function render() { return await getPosts(); }\n` +
        `export { count };\n`,
    );

    const load = createUseCacheLoader(base, {
      projectDir: dir,
      cacheDir: join(dir, ".cache"),
    });
    const mod = await load(join(dir, "page.ts")) as {
      render: () => Promise<number>;
      count: () => number;
    };

    const r1 = await runWithContext(
      createRequestContext(new Request("http://x/1")),
      () => mod.render(),
    );
    const r2 = await runWithContext(
      createRequestContext(new Request("http://x/2")),
      () => mod.render(),
    );
    assertEquals(r1, 1, "first request computes");
    assertEquals(r2, 1, "second request is a cache hit");
    assertEquals(mod.count(), 1, "the cached body ran exactly once across requests");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("B4: a `use cache` component's rendered output is cached across requests", async () => {
  setCacheStore(inMemoryCacheStore());
  const dir = await Deno.makeTempDir();
  try {
    // An async component that opts into caching; `count` reports body executions.
    await Deno.writeTextFile(
      join(dir, "widget.tsx"),
      `import { h } from ${JSON.stringify(JSX_RUNTIME)};\n` +
        `let calls = 0;\n` +
        `export async function Widget(props) { "use cache"; calls++; ` +
        `return h("div", null, props.label + ":" + calls); }\n` +
        `export function count() { return calls; }\n`,
    );
    const load = createUseCacheLoader(base, { projectDir: dir, cacheDir: join(dir, ".cache") });
    const mod = await load(join(dir, "widget.tsx")) as {
      // deno-lint-ignore no-explicit-any
      Widget: any;
      count: () => number;
    };

    const render = () =>
      runWithContext(
        createRequestContext(new Request("http://x/")),
        () => renderToString(h(mod.Widget, { label: "hi" })),
      );
    const html1 = await render();
    const html2 = await render();

    assertEquals(html1, "<div>hi:1</div>", "first render runs the component body");
    assertEquals(html2, html1, "second render serves the cached vnode (same output)");
    assertEquals(mod.count(), 1, "the component body ran exactly once across renders");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("B3: a project with no `use cache` anywhere loads the original module", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "plain.ts"),
      `export const value = 42;\n`,
    );
    const cacheDir = join(dir, ".cache");
    const load = createUseCacheLoader(base, { projectDir: dir, cacheDir });
    const mod = await load(join(dir, "plain.ts")) as { value: number };
    assertEquals(mod.value, 42);
    // No transformed copies were materialized.
    assert(
      !(await Deno.stat(cacheDir).then(() => true).catch(() => false)),
      "no cache dir created when nothing is cached",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
