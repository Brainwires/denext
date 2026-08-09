// The experimental auto-memo compiler: the transform itself (golden + bail
// cases), semantic equivalence (SSR output is unchanged), and a render-count
// proof that a compiled component's stable children skip re-render.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compileModules, transformModule } from "../src/build/compiler.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function find(root: FakeElement, tag: string): FakeElement {
  const up = tag.toUpperCase();
  // deno-lint-ignore no-explicit-any
  const stack: any[] = [...root.childNodes];
  while (stack.length) {
    const n = stack.shift();
    if (n && n.tagName === up) return n as FakeElement;
    if (n && n.childNodes) stack.unshift(...n.childNodes);
  }
  throw new Error(`no <${tag}> found`);
}

Deno.test("transform wraps component elements and injects the cache + runtime import", async () => {
  const src = `import { useState } from "denext";
function Child({ v }) { return <b>{v}</b>; }
export function C({ id }) {
  const [n] = useState(0);
  const label = id + n;
  return <div><Child v={label} /><span>{n}</span></div>;
}
`;
  const { code, changed } = await transformModule(src, "file:///proj/app/C.tsx");
  assert(changed);
  assertStringIncludes(code, "_dnxUseMemoCache(");
  assertStringIncludes(code, "compiler-runtime.ts");
  // The <Child> element is memoized with its reactive deps; the <span> host is not.
  assertStringIncludes(code, "_dnxMemo(_dnxC, 0, () => (<Child v={label} />), [label])");
  assertStringIncludes(code, "<span>{n}</span>");
});

Deno.test("transform places edits correctly despite leading comments and multi-byte chars", async () => {
  // swc reports byte offsets against a base that skips leading comments; these
  // trip a naive implementation. The cache decl must land right after the `{`, and
  // the memoized element must be intact — even with an emoji before it.
  const src = `// a leading comment
// another line
export function C() {
  return <div>{"héllo 👋"}<Child a="x" /></div>;
}
`;
  const { code, changed } = await transformModule(src, "file:///proj/app/C.tsx");
  assert(changed);
  assertStringIncludes(code, "export function C() {\n  const _dnxC = _dnxUseMemoCache(");
  assertStringIncludes(code, '_dnxMemo(_dnxC, 0, () => (<Child a="x" />), [])');
  assertStringIncludes(code, "héllo 👋"); // multi-byte content preserved intact
});

Deno.test("transform bails (identity) on modules with no components", async () => {
  const src = `export const add = (a: number, b: number) => a + b;\n`;
  const { changed } = await transformModule(src, "file:///proj/util.ts");
  assert(!changed);
});

Deno.test("transform bails on modules using dynamic import", async () => {
  const src = `export async function C() {
  const m = await import("./x.ts");
  return <div>{m.default}</div>;
}
`;
  const { changed } = await transformModule(src, "file:///proj/app/C.tsx");
  assert(!changed, "dynamic import ⇒ leave the module untouched");
});

Deno.test("transform rewrites relative imports to absolute URLs", async () => {
  const src = `import Child from "./Child.tsx";
export function C() { return <div><Child /></div>; }
`;
  const { code } = await transformModule(src, "file:///proj/app/C.tsx");
  assertStringIncludes(code, 'from "file:///proj/app/Child.tsx"');
  assert(!code.includes('from "./Child.tsx"'), "relative specifier rewritten");
});

Deno.test("compiled output is semantically identical when server-rendered", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_compiler_" });
  try {
    const source = `import { useState } from "denext";
function Row({ label }: { label: string }) { return <li>{label}</li>; }
export default function List() {
  const [items] = useState(["a", "b", "c"]);
  return <ul>{items.map((it) => <Row key={it} label={it} />)}</ul>;
}
`;
    // Note: items.map(...) sits inside a JSX expression container, which the
    // transform leaves verbatim — so this exercises the "recurse but don't touch
    // {…}" path while still memoizing nothing unsafe.
    const origPath = join(dir, "orig.tsx");
    const xformPath = join(dir, "xform.tsx");
    await Deno.writeTextFile(origPath, source);
    const { code } = await transformModule(source, toFileUrl(origPath).href);
    await Deno.writeTextFile(xformPath, code);

    const orig = await import(toFileUrl(origPath).href);
    const xform = await import(toFileUrl(xformPath).href);
    const a = await renderToString(h(orig.default, {}));
    const b = await renderToString(h(xform.default, {}));
    assertEquals(a, b);
    assertStringIncludes(a, "<li>a</li>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a compiled parent skips re-rendering a child with stable deps", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_compiler_" });
  try {
    // Child receives a NEW object literal each render — without the compiler its
    // props differ every time and it re-renders; the compiler stabilizes it.
    const source = `import { useState } from "denext";
let RENDERS = 0;
export function childRenders() { return RENDERS; }
function Child({ data }: { data: { name: string } }) { RENDERS++; return <b>{data.name}</b>; }
export function Parent() {
  const [n, setN] = useState(0);
  const name = "fixed";
  return <div><button onClick={() => setN(n + 1)}>{n}</button><Child data={{ name }} /></div>;
}
`;
    const origPath = join(dir, "orig.tsx");
    const xformPath = join(dir, "xform.tsx");
    await Deno.writeTextFile(origPath, source);
    const { code, changed } = await transformModule(source, toFileUrl(origPath).href);
    assert(changed);
    await Deno.writeTextFile(xformPath, code);

    // --- uncompiled: the child re-renders on every parent update ---
    {
      const orig = await import(toFileUrl(origPath).href);
      const { doc, container } = makeDom();
      setDocument(asDoc(doc));
      const root = createRoot(asEl(container));
      root.render(h(orig.Parent, {}));
      assertEquals(orig.childRenders(), 1);
      for (let i = 0; i < 3; i++) {
        (find(container, "button") as FakeElement).dispatch("click");
        flushSync();
      }
      assert(orig.childRenders() > 1, "uncompiled child re-renders on each update");
      root.unmount();
    }

    // --- compiled: the child renders once and then bails ---
    {
      const xform = await import(toFileUrl(xformPath).href);
      const { doc, container } = makeDom();
      setDocument(asDoc(doc));
      const root = createRoot(asEl(container));
      root.render(h(xform.Parent, {}));
      assertEquals(xform.childRenders(), 1);
      for (let i = 0; i < 3; i++) {
        (find(container, "button") as FakeElement).dispatch("click");
        flushSync();
      }
      assertEquals(xform.childRenders(), 1, "compiled child skips re-render (stable deps)");
      assertEquals(find(container, "b").innerHTML, "fixed");
      root.unmount();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compileModules writes changed modules and maps their URLs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_compiler_" });
  try {
    const comp = join(dir, "C.tsx");
    const util = join(dir, "util.ts");
    await Deno.writeTextFile(
      comp,
      `function Child() { return <b/>; }\nexport function C() { return <div><Child/></div>; }\n`,
    );
    await Deno.writeTextFile(util, `export const x = 1;\n`);
    const map = await compileModules([comp, util], { outDir: join(dir, ".denext") });
    assert(toFileUrl(comp).href in map, "component module is redirected");
    assert(!(toFileUrl(util).href in map), "plain module is not redirected");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
