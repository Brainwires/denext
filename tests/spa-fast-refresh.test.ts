// Phase C — SPA-mode Fast Refresh.
//
// A SPA's own `main.tsx` calls `createRoot(el).render(<App/>)`; denext never
// authored it, so there is no generated entry to hang `registerFamily` calls on.
// Two pieces close that gap:
//   1. a build transform (`spa-refresh-plugin.ts`) that appends a family
//      registration for every component-shaped declaration in each app module, and
//   2. `createRoot` retaining its root per container under Fast Refresh, so a
//      cache-busted re-import's fresh refs reconcile onto the live fiber tree.
// These tests exercise both, plus the dev entry generation and edit classification.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { registerFamily, sameFamily } from "../src/client/refresh-runtime.ts";
import { setFamilyMatch } from "../src/client/vnode-utils.ts";
import { classifySpaChange, generateSpaEntry } from "../src/build/spa.ts";
import { collectComponentNames, refreshFooter } from "../src/build/spa-refresh-plugin.ts";
import { swcParse } from "../src/build/swc-ast.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- the transform's component detection -----------------------------------

async function names(src: string): Promise<string[]> {
  const parse = await swcParse();
  return collectComponentNames(await parse(src));
}

Deno.test("collectComponentNames: PascalCase functions/consts/classes, exported or not", async () => {
  const src = [
    `function Counter() { return null; }`,
    `export function Panel() { return null; }`,
    `const Card = () => null;`,
    `export const Badge = function () { return null; };`,
    `class Widget { render() {} }`,
    `export default function App() { return null; }`,
  ].join("\n");
  const found = await names(src);
  for (const n of ["Counter", "Panel", "Card", "Badge", "Widget", "App"]) {
    assert(found.includes(n), `expected ${n} to be detected`);
  }
});

Deno.test("collectComponentNames: excludes hooks, helpers, and value consts", async () => {
  const src = [
    `function useThing() { return 1; }`, // a hook (lowercase) — not a component
    `const helper = () => 1;`, // lowercase helper
    `const Config = { a: 1 };`, // PascalCase but a value, not a callable
    `const MAX = 10;`, // PascalCase-ish constant value
    `function Real() { return null; }`, // the only component
  ].join("\n");
  const found = await names(src);
  assertEquals(found, ["Real"]);
});

Deno.test("refreshFooter: emits an aliased import + one registration per component", () => {
  const footer = refreshFooter("file:///app/Counter.tsx", ["Counter", "Card"]);
  assertStringIncludes(
    footer,
    `import { registerFamily as __dnxRegisterFamily } from "denext/client-runtime";`,
  );
  assertStringIncludes(footer, `__dnxRegisterFamily(Counter, "file:///app/Counter.tsx#Counter");`);
  assertStringIncludes(footer, `__dnxRegisterFamily(Card, "file:///app/Counter.tsx#Card");`);
  // Nothing to register → no footer at all (module untouched).
  assertEquals(refreshFooter("file:///app/x.tsx", []), "");
});

// ---- the generated dev entry ------------------------------------------------

Deno.test("generateSpaEntry: prod is a bare side-effect import (no refresh runtime)", () => {
  const src = generateSpaEntry("file:///app/src/main.tsx");
  assertStringIncludes(src, 'import "file:///app/src/main.tsx";');
  assert(!src.includes("enableFastRefresh"), "prod entry ships no refresh runtime");
});

Deno.test("generateSpaEntry(dev): installs Fast Refresh before the app mounts", () => {
  const src = generateSpaEntry("file:///app/src/main.tsx", true);
  // enableFastRefresh() must run as inline code (before the app), and the user entry
  // is pulled in with a DYNAMIC import so its createRoot runs with the seam active
  // (a static import would hoist ahead of the inline enable call).
  assertStringIncludes(src, 'import { enableFastRefresh } from "denext/client-runtime";');
  assertStringIncludes(src, "enableFastRefresh();");
  assertStringIncludes(src, 'await import("file:///app/src/main.tsx");');
  const enableAt = src.indexOf("enableFastRefresh();");
  const importAt = src.indexOf("await import(");
  assert(enableAt !== -1 && enableAt < importAt, "enable must precede the app import");
});

// ---- edit classification (watcher → SSE action) -----------------------------

Deno.test("classifySpaChange: component edits refresh; entry/public edits reload", () => {
  const entry = "/proj/src/main.tsx";
  const pub = "/proj/public";
  // An ordinary component edit → Fast Refresh.
  assertEquals(classifySpaChange(["/proj/src/Counter.tsx"], entry, pub), "refresh");
  assertEquals(
    classifySpaChange(["/proj/src/a.tsx", "/proj/src/b.ts"], entry, pub),
    "refresh",
  );
  // The entry module itself → full reload (its mount call may have changed).
  assertEquals(classifySpaChange([entry], entry, pub), "reload");
  // A public/ asset → full reload (not part of the module graph).
  assertEquals(classifySpaChange(["/proj/public/logo.svg"], entry, pub), "reload");
  // A mixed batch is conservative: any reload-class path forces a reload.
  assertEquals(
    classifySpaChange(["/proj/src/Counter.tsx", entry], entry, pub),
    "reload",
  );
});

// ---- the retained-root mechanism (the crux) --------------------------------

Deno.test("SPA re-import: a second createRoot on the container reconciles in place under refresh", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  setFamilyMatch(sameFamily); // enable Fast Refresh (as the dev entry's enableFastRefresh does)
  try {
    let bump: () => void = () => {};

    // First load: the user's main.tsx runs createRoot(el).render(app).
    const AppV1 = (): VNode => {
      const [n, set] = useState(0);
      bump = () => set((x) => x + 1);
      return h("span", null, "v1:", String(n));
    };
    registerFamily(AppV1, "file:///app/App.tsx#App");
    const r1 = createRoot(container as Any);
    r1.render(h(AppV1, null));
    flushSync();
    bump();
    bump();
    flushSync();
    assertEquals(container.innerHTML, "<span>v1:2</span>");

    // Refresh: the cache-busted entry re-runs main.tsx → createRoot(el) AGAIN. Under
    // Fast Refresh that returns the SAME retained root, so rendering the edited ref
    // reconciles onto the live fiber tree — state (2) survives, new code ("v2:") shows.
    const AppV2 = (): VNode => {
      const [n, set] = useState(0);
      bump = () => set((x) => x + 1);
      return h("span", null, "v2:", String(n));
    };
    registerFamily(AppV2, "file:///app/App.tsx#App");
    const r2 = createRoot(container as Any);
    assert(r2 === r1, "createRoot returns the container's retained root under Fast Refresh");
    r2.render(h(AppV2, null));
    flushSync();
    assertEquals(
      container.innerHTML,
      "<span>v2:2</span>",
      "hook state preserved AND the edited implementation rendered",
    );
  } finally {
    setFamilyMatch(null);
  }
});

Deno.test("production: createRoot always makes a fresh root (no retained-root reuse)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  // No setFamilyMatch → familyMatchActive() is false, i.e. production semantics.
  const r1 = createRoot(container as Any);
  const r2 = createRoot(container as Any);
  assert(r1 !== r2, "without Fast Refresh, each createRoot is an independent root");
});
