// The qrl auto-wrap build transform (src/build/qrl-transform.ts): in a resumable
// module, inline event handlers are extracted into code-split segment modules and
// the usage site is rewritten to a `qrl(() => import(...), id, [captures])` ref.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compileQrlModules, transformQrl } from "../src/build/qrl-transform.ts";
import { swcParse } from "../src/build/swc-ast.ts";

const MOD = "file:///proj/counter.tsx";

/** Assert `code` re-parses cleanly (the transform never emits broken source). */
async function assertParses(code: string): Promise<void> {
  const parse = await swcParse();
  await parse("0;\n" + code);
}

Deno.test("non-resumable module is left untouched", async () => {
  const src = `function C() { return <button onClick={() => go()}>x</button>; }`;
  const r = await transformQrl(src, MOD);
  assertEquals(r.changed, false);
  assertEquals(r.code, src);
  assertEquals(r.segments.length, 0);
});

Deno.test("resumable: inline arrow capturing a component-local is extracted", async () => {
  const src = [
    `export const resumable = true;`,
    `function Counter() {`,
    `  const count = useSignal(0);`,
    `  return <button onClick={() => count.value++}>+</button>;`,
    `}`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  await assertParses(r.code);
  // Usage site rewritten with the capture passed positionally.
  assertStringIncludes(r.code, "onClick={qrl(() => import(");
  assertStringIncludes(r.code, ", [count])}");
  assertStringIncludes(r.code, `import { qrl } from`);
  // One segment, reading the capture via capturedScope.
  assertEquals(r.segments.length, 1);
  const seg = r.segments[0].code;
  await assertParses(seg);
  assertStringIncludes(seg, "const [count] = capturedScope();");
  assertStringIncludes(seg, "capturedScope } from");
  assertStringIncludes(seg, "count.value++");
});

Deno.test("resumable: handler using an imported helper copies the import into the segment", async () => {
  const src = [
    `export const resumable = true;`,
    `import { track } from "./analytics.ts";`,
    `function Row() {`,
    `  const id = useSignal("a");`,
    `  return <div onClick={() => track(id.value)}>row</div>;`,
    `}`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  await assertParses(r.code);
  const seg = r.segments[0].code;
  await assertParses(seg);
  // The relative import is resolved to absolute and re-imported in the segment.
  assertStringIncludes(seg, `import { track } from "file:///proj/analytics.ts";`);
  assertStringIncludes(seg, "const [id] = capturedScope();");
});

Deno.test("resumable: bare reference to an imported handler re-exports it (no capture)", async () => {
  const src = [
    `export const resumable = true;`,
    `import { onInc } from "./handlers.ts";`,
    `function C() { return <button onClick={onInc}>+</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  await assertParses(r.code);
  assertStringIncludes(r.code, "onClick={qrl(() => import(");
  // No capture array for a closure-free reference.
  assert(!r.code.includes(", []"));
  const seg = r.segments[0].code;
  assertStringIncludes(seg, `export { onInc as default } from "file:///proj/handlers.ts";`);
});

Deno.test("resumable: handler referencing a module-scope non-import bails (correctness)", async () => {
  const src = [
    `export const resumable = true;`,
    `const CONFIG = { n: 1 };`,
    `function C() { return <button onClick={() => use(CONFIG)}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  // CONFIG is a module-scope non-import — cannot be provided to the segment → bail.
  assertEquals(r.changed, false);
  assertEquals(r.segments.length, 0);
});

Deno.test("resumable: handler containing JSX bails", async () => {
  const src = [
    `export const resumable = true;`,
    `function C() { return <button onClick={() => render(<b/>)}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assertEquals(r.changed, false);
});

Deno.test("resumable: global-only handler needs no capture and no import", async () => {
  const src = [
    `export const resumable = true;`,
    `function C() { return <button onClick={() => console.log("hi")}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  await assertParses(r.code);
  const seg = r.segments[0].code;
  await assertParses(seg);
  assert(!seg.includes("capturedScope();")); // no captures
  assertStringIncludes(seg, `console.log("hi")`);
});

Deno.test("resumable: handler param is not treated as a capture", async () => {
  const src = [
    `export const resumable = true;`,
    `function C() {`,
    `  const s = useSignal(0);`,
    `  return <input onInput={(e) => { s.value = e.target.value; }}/>;`,
    `}`,
  ].join("\n");
  const r = await transformQrl(src, MOD);
  assert(r.changed);
  await assertParses(r.code);
  const seg = r.segments[0].code;
  // `s` is captured; `e` is the handler param, not a capture.
  assertStringIncludes(seg, "const [s] = capturedScope();");
  assert(!seg.includes("[s, e]") && !seg.includes("[e"));
});

Deno.test("compileQrlModules writes module + segments and maps the original URL", async () => {
  const proj = await Deno.makeTempDir();
  const outDir = await Deno.makeTempDir();
  try {
    const file = join(proj, "counter.tsx");
    await Deno.writeTextFile(
      file,
      [
        `export const resumable = true;`,
        `function Counter() {`,
        `  const count = useSignal(0);`,
        `  return <button onClick={() => count.value++}>+</button>;`,
        `}`,
      ].join("\n"),
    );
    // A non-resumable sibling must be omitted from the map.
    const plain = join(proj, "plain.tsx");
    await Deno.writeTextFile(plain, `function P() { return <b onClick={() => x()}>x</b>; }`);

    const map = await compileQrlModules([file, plain], { outDir });
    const url = toFileUrl(file).href;
    assert(url in map, "resumable module is redirected");
    assert(!(toFileUrl(plain).href in map), "non-resumable module is not redirected");

    const transformed = await Deno.readTextFile(new URL(map[url]));
    assertStringIncludes(transformed, "qrl(() => import(");
    // The segment lives beside the transformed module (relative import resolves).
    const segMatch = transformed.match(/import\("(\.\/qseg_[^"]+\.tsx)"\)/);
    assert(segMatch, "module imports its segment relatively");
    const segPath = new URL(segMatch![1], map[url]);
    const segCode = await Deno.readTextFile(segPath);
    assertStringIncludes(segCode, "capturedScope");
  } finally {
    await Deno.remove(proj, { recursive: true });
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("segmentSpecifier maps the import to the written location", async () => {
  const src = [
    `export const resumable = true;`,
    `function C() { return <button onClick={() => console.log(1)}>x</button>; }`,
  ].join("\n");
  const r = await transformQrl(src, MOD, {
    segmentSpecifier: (stem) => `file:///out/${stem}.tsx`,
  });
  assert(r.changed);
  assertStringIncludes(r.code, `import("file:///out/qseg_`);
});
