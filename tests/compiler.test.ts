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

Deno.test("transform memoizes a module using dynamic import (absolutizing its specifier)", async () => {
  // A dynamic import no longer bails the whole module: the component is still
  // memoized, and the relative `import("./lazy.ts")` specifier is absolutized like
  // a static one (the transformed module lives in a temp dir).
  const src = `import Child from "./Child.tsx";
export function C() {
  const load = () => import("./lazy.ts");
  return <div><Child /></div>;
}
`;
  const { code, changed } = await transformModule(src, "file:///proj/app/C.tsx");
  assert(changed);
  assertStringIncludes(code, "_dnxMemo(_dnxC, 0, () => (<Child />), [])");
  assertStringIncludes(code, 'import("file:///proj/app/lazy.ts")');
  assert(!code.includes('import("./lazy.ts")'), "dynamic-import specifier absolutized");
});

Deno.test("transform memoizes a .map() list expression container as a whole", async () => {
  const src = `import Row from "./Row.tsx";
export function List({ items }) {
  return <ul>{items.map((it) => <Row key={it} label={it} />)}</ul>;
}
`;
  const { code, changed } = await transformModule(src, "file:///proj/app/List.tsx");
  assert(changed);
  // The whole container is wrapped, keyed on `items`; the inner <Row> is NOT
  // individually memoized (a list has a variable element count / no stable slot).
  assertStringIncludes(
    code,
    "{_dnxMemo(_dnxC, 0, () => (items.map((it) => <Row key={it} label={it} />)), [items])}",
  );
});

Deno.test("transform leaves a container verbatim when a free var is unclassifiable (soundness)", async () => {
  // `highlight` is a nested-block const the top-level binding scan can't see, so it
  // can't be proven a tracked dep — memoizing would risk a stale value, so the
  // container is left untouched. `compute`/`Row` are module-level (classifiable).
  const src = `import Row from "./Row.tsx";
function compute() { return 1; }
export function C({ items }) {
  if (items.length) {
    const highlight = compute();
    return <ul>{items.map((it) => <Row it={it} hl={highlight} />)}</ul>;
  }
  return null;
}
`;
  const { code } = await transformModule(src, "file:///proj/app/C.tsx");
  // The map container is NOT memoized (left verbatim) because of `highlight`.
  assert(
    !code.includes("_dnxMemo(_dnxC, 0, () => (items.map"),
    "unsound container must be left verbatim",
  );
  assertStringIncludes(code, "items.map((it) => <Row it={it} hl={highlight} />)");
});

Deno.test("transform does not memoize a host-only expression container", async () => {
  const src = `export function C({ show }) {
  return <div>{show ? <b>x</b> : <i>y</i>}</div>;
}
`;
  const { changed } = await transformModule(src, "file:///proj/app/C.tsx");
  // No component element inside the container, and no component element elsewhere,
  // so nothing is memoized — the module is left untouched.
  assert(!changed, "host-only container ⇒ no memoization");
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
    // items.map(...) sits inside a JSX expression container: the transform now
    // memoizes the whole container (keyed on `items`), so this proves that
    // container-level memoization is semantically transparent under SSR.
    const origPath = join(dir, "orig.tsx");
    const xformPath = join(dir, "xform.tsx");
    await Deno.writeTextFile(origPath, source);
    const { code } = await transformModule(source, toFileUrl(origPath).href);
    await Deno.writeTextFile(xformPath, code);
    assertStringIncludes(code, "_dnxMemo(_dnxC, 0, () => (items.map");

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

Deno.test("a compiled .map() list skips re-render when its deps are stable", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_compiler_" });
  try {
    // The list depends only on `items` (stable via useState); a counter button
    // re-renders the parent. Without the container memo, `items.map(...)` builds a
    // fresh element array each render and every Row re-renders; with it, the cached
    // array is reused and the whole list bails.
    const source = `import { useState } from "denext";
let RENDERS = 0;
export function rowRenders() { return RENDERS; }
function Row({ label }: { label: string }) { RENDERS++; return <li>{label}</li>; }
export function List() {
  const [n, setN] = useState(0);
  const [items] = useState(["a", "b", "c"]);
  return <div><button onClick={() => setN(n + 1)}>{n}</button><ul>{items.map((it) => <Row key={it} label={it} />)}</ul></div>;
}
`;
    const origPath = join(dir, "orig.tsx");
    const xformPath = join(dir, "xform.tsx");
    await Deno.writeTextFile(origPath, source);
    const { code, changed } = await transformModule(source, toFileUrl(origPath).href);
    assert(changed);
    assertStringIncludes(code, "_dnxMemo(_dnxC");
    await Deno.writeTextFile(xformPath, code);

    const xform = await import(toFileUrl(xformPath).href);
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    const root = createRoot(asEl(container));
    root.render(h(xform.List, {}));
    assertEquals(xform.rowRenders(), 3, "each Row renders once initially");
    for (let i = 0; i < 3; i++) {
      (find(container, "button") as FakeElement).dispatch("click");
      flushSync();
    }
    assertEquals(xform.rowRenders(), 3, "stable list skips re-render across parent updates");
    root.unmount();
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
