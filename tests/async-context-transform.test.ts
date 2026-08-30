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
import { swcParse } from "../src/build/swc-ast.ts";

const RUNTIME = toFileUrl(
  new URL("../src/runtime/async-context.ts", import.meta.url).pathname,
).href;

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

  // The mode module is redirected to a generated `= true`.
  const modeKey = Object.keys(map).find((k) => k.endsWith("async-context-mode.ts"));
  assert(modeKey, "mode module present in the map");
  const modeText = await Deno.readTextFile(new URL(map[modeKey!]).pathname);
  assertEquals(modeText.trim(), "export const asyncContextScopingEnabled = true;");

  await Deno.remove(srcDir, { recursive: true }).catch(() => {});
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
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
