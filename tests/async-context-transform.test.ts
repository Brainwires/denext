// The AsyncContext build transform: it must make denext's AsyncContext survive
// `await` (and `for await`) while staying behavior-neutral otherwise. The
// highest-value tests EXECUTE the transformed output against the real runtime and
// assert context propagation + no trailing leak; the rest check shape and bail-outs.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  compileAsyncContextModules,
  transformAsyncContext,
} from "../src/build/async-context-transform.ts";
import { clientTransforms } from "../src/build/build-pipeline/transforms.ts";
import { computeBoundaryRoutes, resetModuleGraphCache } from "../src/build/module-graph.ts";
import { resolveProject } from "../src/build/paths.ts";
import { swcParse } from "../src/build/swc-ast.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { Variable } from "../src/runtime/async-context.ts";

const RUNTIME = new URL("../src/runtime/async-context.ts", import.meta.url).href;

/** Transform `source` (helpers pointed at the real runtime), write it, import it. */
// deno-lint-ignore no-explicit-any
async function transformAndImport(source: string): Promise<any> {
  const { code, changed } = await transformAsyncContext(source, { runtime: RUNTIME });
  assert(changed, "expected the source to be transformed");
  const path = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(path, code);
  try {
    return await import(toFileUrl(path).href);
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

Deno.test("transform: a value set before an await is visible after it (block-body arrow)", async () => {
  const mod = await transformAndImport(`
    import { Variable } from ${JSON.stringify(RUNTIME)};
    export const v = new Variable();
    export async function run() {
      return v.run("X", async () => {
        const before = v.get();
        await Promise.resolve(1);
        const after = v.get();
        // An interloper mutates the global context while we're suspended.
        await v.run("Y", () => Promise.resolve());
        const afterInterloper = v.get();
        return [before, after, afterInterloper];
      });
    }
  `);
  assertEquals(await mod.run(), ["X", "X", "X"]);
  assertEquals(mod.v.get(), undefined); // no trailing leak
});

Deno.test("transform: concise (expression-body) async arrow is instrumented", async () => {
  const mod = await transformAndImport(`
    import { Variable } from ${JSON.stringify(RUNTIME)};
    export const v = new Variable();
    const later = async () => (await Promise.resolve(), v.get());
    export async function run() {
      return v.run("Z", () => later());
    }
  `);
  // `later` is called inside v.run("Z"), so after its await it still sees "Z".
  assertEquals(await mod.run(), "Z");
  assertEquals(mod.v.get(), undefined);
});

Deno.test("transform: context survives a `for await` loop", async () => {
  const mod = await transformAndImport(`
    import { Variable } from ${JSON.stringify(RUNTIME)};
    export const v = new Variable();
    async function* gen() { yield 1; yield 2; yield 3; }
    export async function run() {
      return v.run("L", async () => {
        const seen = [];
        for await (const _ of gen()) seen.push(v.get());
        return seen;
      });
    }
  `);
  assertEquals(await mod.run(), ["L", "L", "L"]);
  assertEquals(mod.v.get(), undefined);
});

Deno.test("transform: nested async functions each keep their own context", async () => {
  const mod = await transformAndImport(`
    import { Variable } from ${JSON.stringify(RUNTIME)};
    export const v = new Variable();
    export async function run() {
      return v.run("outer", async () => {
        const inner = await v.run("inner", async () => {
          await Promise.resolve();
          return v.get();
        });
        await Promise.resolve();
        return [inner, v.get()];
      });
    }
  `);
  assertEquals(await mod.run(), ["inner", "outer"]);
  assertEquals(mod.v.get(), undefined);
});

Deno.test("transform: context restores after a rejected await (try/catch)", async () => {
  const mod = await transformAndImport(`
    import { Variable } from ${JSON.stringify(RUNTIME)};
    export const v = new Variable();
    export async function run() {
      return v.run("R", async () => {
        try {
          await Promise.reject(new Error("x"));
        } catch { /* swallow */ }
        return v.get();
      });
    }
  `);
  assertEquals(await mod.run(), "R");
  assertEquals(mod.v.get(), undefined);
});

Deno.test("transform: a module with no await is left unchanged", async () => {
  const src = `export const f = (x) => x + 1;\n`;
  const { code, changed } = await transformAsyncContext(src);
  assertEquals(changed, false);
  assertEquals(code, src);
});

Deno.test("transform: an async function with no direct await is not instrumented", async () => {
  const src = `export async function f() { return 5; }\n`;
  const { changed } = await transformAsyncContext(src);
  assertEquals(changed, false);
});

Deno.test("transform: an async generator's context survives its awaits AND yields", async () => {
  // The frame is captured at the first `.next()`; it must be restored after each
  // await and after each yield-resume, even when the caller resumes the generator
  // under a DIFFERENT context.
  const mod = await transformAndImport(`
    import { Variable } from ${JSON.stringify(RUNTIME)};
    export const v = new Variable();
    async function* gen(seen) {
      seen.push(v.get());        // A: first run — frame captured here
      await Promise.resolve();
      seen.push(v.get());        // B: after await
      yield 1;
      seen.push(v.get());        // C: after yield-resume (resumed under "H")
      await Promise.resolve();
      yield 2;
      seen.push(v.get());        // D: after 2nd yield-resume (resumed under "I")
    }
    export async function run() {
      const seen = [];
      const it = gen(seen);
      await v.run("G", () => it.next());   // first .next while "G" current
      await v.run("H", () => it.next());   // resume under "H"
      await v.run("I", () => it.next());   // resume under "I"
      return seen;
    }
  `);
  // Every observation sees the frame's own "G" — never the caller's "H"/"I".
  assertEquals(await mod.run(), ["G", "G", "G", "G"]);
  assertEquals(mod.v.get(), undefined); // no trailing leak
});

Deno.test("transform: a bare `yield` (no argument) in an async generator is instrumented", async () => {
  const mod = await transformAndImport(`
    import { Variable } from ${JSON.stringify(RUNTIME)};
    export const v = new Variable();
    async function* gen(seen) {
      await Promise.resolve();
      yield;                     // bare yield
      seen.push(v.get());
    }
    export async function run() {
      const seen = [];
      const it = gen(seen);
      await v.run("G", () => it.next());
      await v.run("H", () => it.next());
      return seen;
    }
  `);
  assertEquals(await mod.run(), ["G"]);
  assertEquals(mod.v.get(), undefined);
});

Deno.test("transform: an async generator using `yield*` delegation is left uninstrumented", async () => {
  // Delegation suspends through a sub-iterator, which needs different bracketing —
  // leave it alone (graceful) rather than mis-instrument it.
  const src = `export async function* g(sub) { yield* sub; await h(); }\n`;
  const { changed } = await transformAsyncContext(src, { runtime: RUNTIME });
  assertEquals(changed, false);
});

Deno.test("compileAsyncContextModules: redirects changed modules + flips the mode module", async () => {
  const srcDir = await Deno.makeTempDir();
  const outDir = await Deno.makeTempDir();
  const withAwait = join(srcDir, "a.tsx");
  const noAwait = join(srcDir, "b.tsx");
  await Deno.writeTextFile(withAwait, `export async function f() { await g(); }\n`);
  await Deno.writeTextFile(noAwait, `export const x = 1;\n`);

  const map = await compileAsyncContextModules([withAwait, noAwait], { outDir });

  // The awaiting module is redirected; the plain one is not.
  assert(map[toFileUrl(withAwait).href], "awaiting module redirected");
  assertEquals(map[toFileUrl(noAwait).href], undefined, "plain module not redirected");

  // The mode module is redirected to a generated one exporting the transition-identity
  // `Variable` — the framework's own class, so the transformed modules' context reaches it.
  const modeKey = Object.keys(map).find((k) => k.endsWith("async-context-mode.ts"));
  assert(modeKey, "mode module present in the map");
  const mode = await import(map[modeKey!]);
  assert(mode.transitionScope instanceof Variable, "the mode module exports a Variable");

  await Deno.remove(srcDir, { recursive: true }).catch(() => {});
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
});

Deno.test("transform: with moduleUrl, an instrumented module's relative specifiers are made absolute", async () => {
  const src = `
    import "./look.css";
    import data from "./data.json" with { type: "json" };
    import { Tag } from "../ui/tag.tsx";
    import { useState } from "denext";
    export { helper } from "./helper.ts";
    const Island = () => import("./island.tsx");
    export async function load(name) {
      const a = await import(\`./extra.ts\`);
      const b = await import(name);
      return [a, b, import.meta.resolve("./asset.txt"), new URL("./x.png", import.meta.url)];
    }
  `;
  const moduleUrl = "file:///app/routes/page.tsx";
  const { code, changed } = await transformAsyncContext(src, { runtime: RUNTIME, moduleUrl });
  assert(changed);
  for (
    const url of [
      "file:///app/routes/look.css",
      "file:///app/routes/data.json",
      "file:///app/ui/tag.tsx",
      "file:///app/routes/helper.ts",
      "file:///app/routes/island.tsx",
      "file:///app/routes/extra.ts",
    ]
  ) {
    assert(code.includes(JSON.stringify(url)), `${url} in:\n${code}`);
  }
  assert(code.includes(`with { type: "json" }`), "the import attribute is kept");
  assert(code.includes(`from "denext"`), "a bare specifier is left to the import map");
  // The client bundler follows neither, and the browser resolves both against the chunk, as it
  // does for the original module: they are left as written.
  assert(code.includes(`import(name)`), "a non-literal import() is left as written");
  assert(code.includes(`import.meta.resolve("./asset.txt")`), "import.meta is left as written");
  assert(code.includes(`new URL("./x.png", import.meta.url)`));
  const parse = await swcParse();
  await parse(code);
});

Deno.test("transform: without moduleUrl (or with nothing to instrument) specifiers are untouched", async () => {
  const src = `import "./a.css";\nexport async function f() { await import("./b.ts"); }\n`;
  const { code } = await transformAsyncContext(src, { runtime: RUNTIME });
  assert(code.includes(`"./a.css"`) && code.includes(`import("./b.ts")`));
  const plain = `import "./a.css";\nexport const x = () => import("./b.ts");\n`;
  const result = await transformAsyncContext(plain, { moduleUrl: "file:///app/x.tsx" });
  assertEquals(result, { code: plain, changed: false });
});

Deno.test("compileAsyncContextModules: a copy's static and dynamic imports reach the original's siblings", async () => {
  const srcDir = await Deno.makeTempDir();
  const outDir = await Deno.makeTempDir();
  try {
    const page = join(srcDir, "page.tsx");
    await Deno.writeTextFile(join(srcDir, "dep.ts"), `export const dep = "dep-ok";\n`);
    await Deno.writeTextFile(join(srcDir, "lazy.ts"), `export const lazy = "lazy-ok";\n`);
    await Deno.writeTextFile(join(srcDir, "data.json"), `{ "label": "json-ok" }\n`);
    await Deno.writeTextFile(
      page,
      `import { dep } from "./dep.ts";
import data from "./data.json" with { type: "json" };
export async function run() {
  const { lazy } = await import("./lazy.ts");
  return [dep, lazy, data.label];
}
`,
    );
    const map = await compileAsyncContextModules([page], { outDir });
    const copy = map[toFileUrl(page).href];
    assert(copy?.includes("/asyncctx/"), "the page is instrumented into asyncctx/");
    const mod = await import(copy);
    assertEquals(await mod.run(), ["dep-ok", "lazy-ok", "json-ok"]);
  } finally {
    await Deno.remove(srcDir, { recursive: true }).catch(() => {});
    await Deno.remove(outDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("transform: output re-parses cleanly (valid syntax) for a mixed module", async () => {
  const src = `
    "use client";
    export async function a() { await x(); const y = await z(); return y; }
    export const b = async () => { for await (const i of it()) await use(i); };
    export function plain() { return 1; }
  `;
  const { code, changed } = await transformAsyncContext(src, { runtime: RUNTIME });
  assert(changed);
  const parse = await swcParse();
  await parse(code); // throws on a syntax error
  // The directive prologue is preserved as the first statement.
  assert(code.trimStart().startsWith(`"use client"`), "directive prologue preserved");
});

// The build's AsyncContext pass instruments a plain `.ts` / `.js` / `.mts` module a client bundle
// can contain (a hook or store awaiting inside a transition), not just `.tsx` / `.jsx`; a module
// only the server tree reaches, or a route that ships no JS, is left alone.
Deno.test("clientTransforms (asyncContext): client .ts modules are instrumented, server-only ones are not", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_ac_sources_" }));
  const awaits = (name: string) =>
    `export async function ${name}() { await Promise.resolve(); return "${name}"; }\n`;
  const files: Record<string, string> = {
    // A Flight route: the island's hook ships, the page's data module does not.
    "app/page.tsx":
      `import { Island } from "./island.tsx";\nimport { serverOnly } from "./data.ts";\n` +
      `export default async function Page() { return [await serverOnly(), Island]; }\n`,
    "app/data.ts": awaits("serverOnly"),
    "app/island.tsx": `"use client";\nimport { clientHook } from "./hook.ts";\n` +
      `export function Island() { return clientHook; }\n`,
    "app/hook.ts": awaits("clientHook"),
    // A route hydrated whole (it uses a hook): its tree ships.
    "app/whole/page.tsx": `import { wholeTree } from "./util.mts";\n` +
      `export default function Whole() { const [s] = useState(0); return [s, wholeTree]; }\n` +
      `function useState(x: number) { return [x]; }\n`,
    "app/whole/util.mts": awaits("wholeTree"),
    // A static route (no interactivity): nothing of it ships.
    "app/static/page.tsx": `import { staticOnly } from "./util.js";\n` +
      `export default function Static() { return staticOnly; }\n`,
    "app/static/util.js": awaits("staticOnly"),
  };
  try {
    for (const [name, src] of Object.entries(files)) {
      await Deno.mkdir(join(dir, name, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, name), src);
    }
    const paths = await resolveProject(dir);
    const manifest = await scanRoutes(paths.appDir);
    const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
    assertEquals([...flightRoutes], ["/"]);
    const map = await clientTransforms({
      projectDir: dir,
      paths: { ...paths, config: { asyncContext: true } },
      manifest,
      flightRoutes,
    });
    const url = (p: string) => toFileUrl(join(dir, p)).href;
    for (const p of ["app/hook.ts", "app/whole/util.mts"]) {
      assert(map[url(p)], `${p} was not instrumented`);
      const code = await Deno.readTextFile(new URL(map[url(p)]));
      assert(code.includes("__asyncAwait("), `${p}'s await is not bracketed`);
    }
    for (const p of ["app/data.ts", "app/static/util.js"]) {
      assertEquals(map[url(p)], undefined, `${p} (server-only) was instrumented`);
    }
  } finally {
    resetModuleGraphCache();
    await Deno.remove(dir, { recursive: true });
  }
});
