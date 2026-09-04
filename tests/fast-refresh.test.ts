// W7 — Fast Refresh (state-preserving HMR), core mechanism.
//
// The one blocker to preserving state across an edit is type identity: `sameType`
// is reference equality, so a re-imported module's NEW function ref forces a
// remount that discards `fiber.hooks`. The dev refresh runtime gives components a
// stable *family* id so the new ref reconciles onto the existing fiber. These
// tests exercise that substrate directly — no dev server needed — by registering
// two different function refs under one family and re-rendering.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useRef, useState } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import {
  enablePerModuleRefresh,
  performModuleRefresh,
  registerFamily,
  sameFamily,
} from "../src/client/refresh-runtime.ts";
import {
  setFamilyMatch,
  setFamilyResolve,
  setSignatureChangeHandler,
} from "../src/client/vnode-utils.ts";
import { generateFlightEntry, generateRouteEntry } from "../src/build/bundle.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import type { BoundaryManifest } from "../src/build/module-graph.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("family reconcile preserves hook state when a component's ref changes (edit)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  setFamilyMatch(sameFamily); // enable dev Fast Refresh matching for this test
  try {
    let bump: () => void = () => {};

    // v1: the pre-edit implementation.
    const AppV1 = (): VNode => {
      const [n, set] = useState(0);
      bump = () => set((x) => x + 1);
      return h("span", null, "v1:", String(n));
    };
    registerFamily(AppV1, "mod#App");

    // One retained root, rendered twice — mirrors the dev flow where a refresh
    // re-runs the route entry and calls the SAME root's .render() again.
    const root = createRoot(container as Any);
    root.render(h("div", null, h(AppV1, null)));
    flushSync();
    // Give the child some local state.
    bump();
    bump();
    flushSync();
    assertEquals(container.innerHTML, "<div><span>v1:2</span></div>");

    // v2: a DIFFERENT function ref (the "edited" module) under the SAME family.
    const AppV2 = (): VNode => {
      const [n, set] = useState(0);
      bump = () => set((x) => x + 1);
      return h("span", null, "v2:", String(n)); // edited output
    };
    registerFamily(AppV2, "mod#App");

    // Re-render with the new ref: reconciles in place, so state (2) survives and
    // the new render output ("v2:") shows — a remount would reset to "v2:0".
    root.render(h("div", null, h(AppV2, null)));
    flushSync();
    assertEquals(
      container.innerHTML,
      "<div><span>v2:2</span></div>",
      "hook state preserved AND new implementation rendered",
    );

    // The preserved state is still live: bump acts on the same fiber's hook.
    bump();
    flushSync();
    assertEquals(container.innerHTML, "<div><span>v2:3</span></div>");
  } finally {
    setFamilyMatch(null); // restore reference-equality sameType for other tests
  }
});

/** Live `bump` handles for the parent + child fibers (rebound on every render). */
type Bumps = { child: () => void; parent: () => void };

/**
 * Mount v1 of a LEAF component in its own "module" under the parent that renders it
 * by reference, wiring both fibers' state bumpers into `bumps`.
 */
function mountParentWithChildV1(container: Any, bumps: Bumps): void {
  // v1 of a LEAF component in its own "module". The parent renders it by reference.
  const ChildV1 = (): VNode => {
    const [n, set] = useState(0);
    bumps.child = () => set((x) => x + 1);
    return h("span", null, "childV1:", String(n));
  };
  registerFamily(ChildV1, "widget#Child");

  // The parent holds its OWN state and renders ChildV1 by the ref it captured. A
  // per-module edit re-imports ONLY the child module — the parent never re-runs, so
  // its vnode keeps the ChildV1 ref. The substitution must reach the child anyway.
  const Parent = (): VNode => {
    const [p, set] = useState(0);
    bumps.parent = () => set((x) => x + 1);
    return h("div", null, h("i", null, "p:", String(p)), h(ChildV1, null));
  };
  registerFamily(Parent, "page#Parent");

  const root = createRoot(container);
  root.render(h(Parent, null));
  flushSync();
}

Deno.test("per-module refresh: family-current substitution swaps an edited module in place", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  // The unbundled dev loop installs family-current substitution + the root-refresh hook.
  enablePerModuleRefresh();
  try {
    const bumps: Bumps = { child: () => {}, parent: () => {} };
    mountParentWithChildV1(container as Any, bumps);
    // Give BOTH fibers live state.
    bumps.parent();
    bumps.child();
    bumps.child();
    flushSync();
    assertEquals(container.innerHTML, "<div><i>p:1</i><span>childV1:2</span></div>");

    // Simulate the re-import of ONLY the child module: a new ref under the SAME family,
    // and NO re-render of the parent (the parent still holds ChildV1). Then the HMR
    // runtime triggers performModuleRefresh().
    const ChildV2 = (): VNode => {
      const [n, set] = useState(0);
      bumps.child = () => set((x) => x + 1);
      return h("span", null, "childV2:", String(n)); // edited output
    };
    registerFamily(ChildV2, "widget#Child");
    performModuleRefresh();
    flushSync();

    // The edited child rendered its new output on the live fiber; BOTH the child's own
    // state (2) and the untouched parent's state (1) survived — no remount.
    assertEquals(
      container.innerHTML,
      "<div><i>p:1</i><span>childV2:2</span></div>",
      "single-module swap: new child impl, child + parent state preserved",
    );

    // State is still live post-swap.
    bumps.child();
    flushSync();
    assertEquals(container.innerHTML, "<div><i>p:1</i><span>childV2:3</span></div>");
  } finally {
    setFamilyResolve(null);
    setFamilyMatch(null);
    setSignatureChangeHandler(null);
  }
});

Deno.test("unrelated components in different families still remount (no false match)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  setFamilyMatch(sameFamily);
  try {
    let bump: () => void = () => {};
    const Alpha = (): VNode => {
      const [n, set] = useState(0);
      bump = () => set((x) => x + 1);
      return h("span", null, "A:", String(n));
    };
    const Beta = (): VNode => {
      const [n] = useState(0);
      return h("span", null, "B:", String(n));
    };
    registerFamily(Alpha, "mod#Alpha");
    registerFamily(Beta, "mod#Beta");

    createRoot(container as Any).render(h("div", null, h(Alpha, null)));
    flushSync();
    bump();
    flushSync();
    assertEquals(container.innerHTML, "<div><span>A:1</span></div>");

    // Swapping to a different family at the same position replaces the subtree —
    // Beta mounts fresh (state 0), Alpha's state does not bleed across.
    createRoot(container as Any).render(h("div", null, h(Beta, null)));
    flushSync();
    assertEquals(container.innerHTML, "<div><span>B:0</span></div>");
  } finally {
    setFamilyMatch(null);
  }
});

Deno.test("hook-signature guard fires when a refresh swap changes hook count", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  setFamilyMatch(sameFamily);
  let sigChanges = 0;
  setSignatureChangeHandler(() => sigChanges++);
  try {
    // v1: one hook.
    const OneHook = (): VNode => {
      const [n] = useState(0);
      return h("span", null, String(n));
    };
    registerFamily(OneHook, "mod#H");
    const root = createRoot(container as Any);
    root.render(h("div", null, h(OneHook, null)));
    flushSync();
    assertEquals(sigChanges, 0, "no signature change on first mount");

    // v2: same family, but TWO hooks — an unsafe reconcile.
    const TwoHooks = (): VNode => {
      const [a] = useState(0);
      const [b] = useState(1);
      return h("span", null, String(a), String(b));
    };
    registerFamily(TwoHooks, "mod#H");
    root.render(h("div", null, h(TwoHooks, null)));
    flushSync();
    assert(sigChanges > 0, "hook-count change signals an unsafe refresh (full reload)");
  } finally {
    setFamilyMatch(null);
    setSignatureChangeHandler(null);
  }
});

Deno.test("hook-signature guard fires on a SAME-COUNT hook reorder (L1)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  setFamilyMatch(sameFamily);
  let sigChanges = 0;
  setSignatureChangeHandler(() => sigChanges++);
  try {
    // v1: useState then useRef — two hooks.
    const V1 = (): VNode => {
      const [n] = useState(0);
      useRef(0);
      return h("span", null, String(n));
    };
    registerFamily(V1, "mod#R");
    const root = createRoot(container as Any);
    root.render(h("div", null, h(V1, null)));
    flushSync();
    assertEquals(sigChanges, 0, "no signature change on first mount");

    // v2: SAME count (two hooks) but REORDERED (useRef then useState). A count-only
    // guard would miss this; the per-kind signature catches it.
    const V2 = (): VNode => {
      useRef(0);
      const [n] = useState(0);
      return h("span", null, String(n));
    };
    registerFamily(V2, "mod#R");
    root.render(h("div", null, h(V2, null)));
    flushSync();
    assert(sigChanges > 0, "a same-count hook reorder signals an unsafe refresh");
  } finally {
    setFamilyMatch(null);
    setSignatureChangeHandler(null);
  }
});

Deno.test("hook-signature guard stays silent when the hook sequence is unchanged", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  setFamilyMatch(sameFamily);
  let sigChanges = 0;
  setSignatureChangeHandler(() => sigChanges++);
  try {
    // Two edits with an IDENTICAL hook sequence (useState, useState) — only the
    // rendered output differs. The guard must NOT fire (state is safely preserved).
    const Va = (): VNode => {
      const [a] = useState(0);
      const [b] = useState(1);
      return h("span", null, "a", String(a), String(b));
    };
    registerFamily(Va, "mod#S");
    const root = createRoot(container as Any);
    root.render(h("div", null, h(Va, null)));
    flushSync();

    const Vb = (): VNode => {
      const [a] = useState(0);
      const [b] = useState(1);
      return h("span", null, "b", String(a), String(b)); // only output changed
    };
    registerFamily(Vb, "mod#S");
    root.render(h("div", null, h(Vb, null)));
    flushSync();
    assertEquals(sigChanges, 0, "an unchanged hook sequence does not trip the guard");
  } finally {
    setFamilyMatch(null);
    setSignatureChangeHandler(null);
  }
});

// A minimal PageRoute for entry-generation assertions.
const devRoute: PageRoute = {
  kind: "page",
  pattern: parsePattern("about"),
  routePath: "/about",
  filePath: "/app/about/page.tsx",
  layoutChain: ["/app/layout.tsx"],
  templateChain: [],
  loading: null,
  error: null,
  notFound: null,
  forbidden: null,
  unauthorized: null,
};

Deno.test("generateRouteEntry emits Fast Refresh registration only in dev", () => {
  const dev = generateRouteEntry(devRoute, true);
  assertStringIncludes(dev, "enableFastRefresh()");
  assertStringIncludes(dev, "registerFamily(Page,");
  assertStringIncludes(dev, "registerFamily(Layout0,");
  assertStringIncludes(dev, "__denextRefreshing"); // reload fallback wired

  const prod = generateRouteEntry(devRoute); // default: not dev
  assert(!prod.includes("enableFastRefresh"), "prod entry has no refresh runtime");
  assert(!prod.includes("registerFamily"), "prod entry registers no families");
});

Deno.test("generateFlightEntry emits Fast Refresh registration only in dev", () => {
  const boundary: BoundaryManifest = {
    client: new Map([["c_w", { url: "file:///app/widget.tsx", exports: ["Widget"] }]]),
    server: new Map(),
  };
  const dev = generateFlightEntry(boundary, true);
  assertStringIncludes(dev, "enableFastRefresh()");
  assertStringIncludes(dev, "registerFamily(mod[k]");

  const prod = generateFlightEntry(boundary);
  assert(!prod.includes("enableFastRefresh"), "prod flight entry has no refresh runtime");
  assert(!prod.includes("registerFamily"), "prod flight entry registers no families");
});

Deno.test("sameFamily: only same-id registrations match", () => {
  const A1 = () => h("i", null);
  const A2 = () => h("i", null);
  const B = () => h("i", null);
  registerFamily(A1, "m#A");
  registerFamily(A2, "m#A"); // same family as A1
  registerFamily(B, "m#B");
  assertEquals(sameFamily(A1, A2), true);
  assertEquals(sameFamily(A1, B), false);
  assertEquals(sameFamily(A1, () => null), false); // unregistered
});
