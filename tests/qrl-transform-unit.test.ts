// Additional branch coverage for the qrl auto-wrap transform
// (src/build/qrl-transform.ts): the `force` opt, the default/namespace/aliased
// import re-binding shapes, unsafe-construct bails (`this`), multi-handler
// counters, destructured component params, the pre-filter early-out, and
// compileQrlModules' unreadable-file skip.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compileQrlModules, transformQrl } from "../src/build/qrl-transform.ts";
import { swcParse } from "../src/build/swc-ast.ts";

const MOD = "file:///proj/mod.tsx";

async function assertParses(code: string): Promise<void> {
  const parse = await swcParse();
  await parse("0;\n" + code);
}

Deno.test("pre-filter: a module with no on-handler is identity even with 'resumable'", async () => {
  const src = `export const resumable = true;\nfunction C() { return <div>x</div>; }`;
  const r = await transformQrl(src, MOD);
  assertEquals(r.changed, false);
  assertEquals(r.code, src);
});

Deno.test("resumable = false is not resumable → identity", async () => {
  const src = `export const resumable = false;\n` +
    `function C() { return <button onClick={() => go()}>x</button>; }`;
  const r = await transformQrl(src, MOD);
  assertEquals(r.changed, false);
});

Deno.test("force: transforms a non-resumable module (tests-only opt)", async () => {
  const src = `function C() { return <button onClick={() => console.log(1)}>x</button>; }`;
  const r = await transformQrl(src, MOD, { force: true });
  assert(r.changed);
  await assertParses(r.code);
  assertStringIncludes(r.code, "qrl(() => import(");
  assertEquals(r.segments.length, 1);
});

Deno.test("force: an unparseable module falls back to identity", async () => {
  const broken = `function C( { return <button onClick={() => x()}`;
  const r = await transformQrl(broken, MOD, { force: true });
  assertEquals(r.changed, false);
  assertEquals(r.code, broken);
});

Deno.test("default import used inside a handler is re-bound as a default import", async () => {
  const src = [
    `export const resumable = true;`,
    `import track from "./analytics.ts";`,
    `function C() { return <button onClick={() => track("x")}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  const seg = r.segments[0].code;
  await assertParses(seg);
  assertStringIncludes(seg, `import track from "file:///proj/analytics.ts";`);
});

Deno.test("namespace import used inside a handler is re-bound as import *", async () => {
  const src = [
    `export const resumable = true;`,
    `import * as api from "./api.ts";`,
    `function C() { return <button onClick={() => api.hit()}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  const seg = r.segments[0].code;
  await assertParses(seg);
  assertStringIncludes(seg, `import * as api from "file:///proj/api.ts";`);
});

Deno.test("aliased named import used inside a handler keeps its alias", async () => {
  const src = [
    `export const resumable = true;`,
    `import { hit as go } from "./api.ts";`,
    `function C() { return <button onClick={() => go()}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  const seg = r.segments[0].code;
  await assertParses(seg);
  assertStringIncludes(seg, `import { hit as go } from "file:///proj/api.ts";`);
});

Deno.test("bare reference to a default import re-exports the default", async () => {
  const src = [
    `export const resumable = true;`,
    `import onClickHandler from "./h.ts";`,
    `function C() { return <button onClick={onClickHandler}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  const seg = r.segments[0].code;
  assertStringIncludes(seg, `export { default } from "file:///proj/h.ts";`);
});

Deno.test("bare reference to a namespace import re-exports via its namespace kind", async () => {
  const src = [
    `export const resumable = true;`,
    `import * as handlers from "./h.ts";`,
    `function C() { return <button onClick={handlers}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  const seg = r.segments[0].code;
  // A namespace binding's `kind` is the literal "namespace" (the non-default,
  // non-matching branch of the bare-ref re-export).
  assertStringIncludes(seg, `export { namespace as default } from "file:///proj/h.ts";`);
});

Deno.test("handler using `this` bails (unsafe construct)", async () => {
  const src = [
    `export const resumable = true;`,
    `function C() { return <button onClick={() => this.go()}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assertEquals(r.changed, false);
});

Deno.test("multiple handlers → distinct segments and incrementing ids", async () => {
  const src = [
    `export const resumable = true;`,
    `function C() {`,
    `  return (<div>`,
    `    <button onClick={() => console.log("a")}>a</button>`,
    `    <button onClick={() => console.log("b")}>b</button>`,
    `  </div>);`,
    `}`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  await assertParses(r.code);
  assertEquals(r.segments.length, 2);
  // Two distinct handler ids (onClick0, onClick1).
  assertStringIncludes(r.code, "#onClick0");
  assertStringIncludes(r.code, "#onClick1");
  // Only one qrl runtime import injected regardless of handler count.
  assertEquals(r.code.match(/import \{ qrl \} from/g)?.length, 1);
});

Deno.test("destructured component params are captured when used in a handler", async () => {
  const src = [
    `export const resumable = true;`,
    `function C({ onDone, items: [first] }) {`,
    `  return <button onClick={() => onDone(first)}>x</button>;`,
    `}`,
  ].join("\n");
  const r = await transformQrl(src, MOD, { force: true });
  assert(r.changed);
  const seg = r.segments[0].code;
  await assertParses(seg);
  // Both destructured bindings are component-scope locals → captured.
  assertStringIncludes(seg, "capturedScope();");
  assert(seg.includes("onDone") && seg.includes("first"));
});

Deno.test("directive prologue is preserved; qrl import lands after it", async () => {
  const src = [
    `"use client";`,
    `export const resumable = true;`,
    `function C() { return <button onClick={() => console.log(1)}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  await assertParses(r.code);
  // The "use client" directive stays at the very top.
  assert(r.code.trimStart().startsWith('"use client"'), "directive stays first");
  assertStringIncludes(r.code, `import { qrl } from`);
});

Deno.test("compileQrlModules skips files it cannot read", async () => {
  const outDir = await Deno.makeTempDir();
  try {
    const missing = join(outDir, "does-not-exist.tsx");
    const map = await compileQrlModules([missing], { outDir });
    // Unreadable file → silently skipped, empty map, no throw.
    assertEquals(Object.keys(map).length, 0);
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("compileQrlModules emits a segment for a captureless global handler", async () => {
  const proj = await Deno.makeTempDir();
  const outDir = await Deno.makeTempDir();
  try {
    const file = join(proj, "c.tsx");
    await Deno.writeTextFile(
      file,
      [
        `export const resumable = true;`,
        `function C() { return <button onClick={() => window.scrollTo(0, 0)}>x</button>; }`,
      ].join("\n"),
    );
    const map = await compileQrlModules([file], { outDir });
    const url = toFileUrl(file).href;
    assert(url in map);
    const transformed = await Deno.readTextFile(new URL(map[url]));
    assertStringIncludes(transformed, "qrl(() => import(");
  } finally {
    await Deno.remove(proj, { recursive: true });
    await Deno.remove(outDir, { recursive: true });
  }
});
