// DevTools named hooks (B3) + the source link (B1/B2).
//
// The inspector joins a component's build-time metadata (`registerComponentMeta`, emitted
// by the dev transforms) to its LIVE hook cells by walking both in lockstep: each recorded
// call consumes exactly the cells `HOOK_CELL_KINDS` says it does. These tests cover the
// naming rules, the custom-hook expansion (same module, and across a static relative import
// via `HookDevMeta.from`), every way the walk aborts — and the drift guard that keeps the
// table equal to what the dispatcher actually does.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { devRootFibers } from "../src/client/fiber/devtools-bridge.ts";
import type { Fiber } from "../src/client/fiber/fiber.ts";
import {
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useErrorBoundary,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useMemoCache,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "../src/runtime/hooks.ts";
import { useActionState, useFormState, useFormStatus } from "../src/runtime/actions.ts";
import { createContext } from "../src/runtime/context.ts";
import type { VNode } from "../src/jsx/types.ts";
import { FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  getInspectorTree,
  type InspectNode,
  installInspector,
  type SourceLocation,
} from "../src/client/devtools-inspect.ts";
import {
  clearComponentMeta,
  type ComponentDevMeta,
  HOOK_CELL_KINDS,
  registerComponentMeta,
} from "../src/client/devtools-meta.ts";
import { registerFamily } from "../src/client/refresh-runtime.ts";
import { mountPanel } from "../src/client/devtools-panel.ts";
import { buildStyles } from "../src/client/devtools-panel/styles.ts";
import type { PanelCtx, PanelState } from "../src/client/devtools-panel/ctx.ts";
import {
  editorFallbackUrl,
  prettySource,
  sourceLink,
} from "../src/client/devtools-panel/values.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

interface DevGlobals {
  __denextDev?: boolean;
  __denextDevtools?: unknown;
  requestAnimationFrame?: (cb: () => void) => number;
}
const g = globalThis as DevGlobals;

function withDev<T>(fn: () => T): T {
  const prev = g.__denextDev;
  g.__denextDev = true;
  try {
    return fn();
  } finally {
    g.__denextDev = prev;
    clearComponentMeta();
  }
}

const MODULE = "file:///app/named.tsx";

/** Register a declaration's metadata under `<MODULE>#<name>` (what the dev footer emits). */
function meta(name: string, hooks: ComponentDevMeta["hooks"], line = 10): void {
  registerComponentMeta(`${MODULE}#${name}`, { name, line, column: 1, hooks });
}

/** Register another module's declaration under `<url>#<key>` (its own footer's call). */
function metaAt(url: string, key: string, hooks: ComponentDevMeta["hooks"], name = key): void {
  registerComponentMeta(`${url}#${key}`, { name, line: 1, column: 1, hooks });
}

/** Render `Comp` (registered under `<MODULE>#<name>`) and return its inspector node. */
function renderNode(name: string, Comp: () => VNode): InspectNode {
  registerFamily(Comp, `${MODULE}#${name}`);
  const { doc, container } = makeDom();
  setDocument(asAny(doc));
  createRoot(asAny(container)).render(h(Comp, null));
  flushSync();
  const node = getInspectorTree().find((n) => n.name === name);
  assert(node, `${name} present in the tree`);
  return node!;
}

// ---- The naming rules ------------------------------------------------------

function Named(): VNode {
  const [count] = useState(0);
  const boxRef = useRef<number | null>(null);
  const total = useMemo(() => count + 1, [count]);
  useEffect(() => {}, []);
  return h("div", { "data-total": String(total), "data-ref": String(boxRef.current) });
}

const NAMED_META: ComponentDevMeta["hooks"] = [
  { hook: "useState", name: "count", line: 11 },
  { hook: "useRef", name: "boxRef", line: 12 },
  { hook: "useMemo", name: "total", line: 13 },
  { hook: "useEffect", name: "", line: 14 }, // unbound — falls back to the kind label
];

Deno.test("named hooks: each cell reads as its bound variable plus the hook that made it", () => {
  withDev(() => {
    meta("Named", NAMED_META);
    const node = renderNode("Named", Named);
    assertEquals(node.hooksNamed, true);
    assertEquals(node.hooks.map((hk) => hk.name), ["count", "boxRef", "total", undefined]);
    assertEquals(node.hooks.map((hk) => hk.hook), [
      "useState",
      "useRef",
      "useMemo",
      "useEffect",
    ]);
    // The kind label is still there for a row the panel cannot name.
    assertEquals(node.hooks[3].kind, "effect");
    // Naming never disturbs the live-edit verdict.
    assertEquals(node.hooks[0].editable, true);
  });
});

// A custom hook declared in the SAME module: the dev pass records its own metadata, so the
// runtime expands the call into the cells it really takes (the `const { data } = useApi()`
// destructure shape — `data` is the label the build pass recorded).
function useApiLike(): { data: number } {
  const [data] = useState(7);
  useEffect(() => {}, []);
  return { data };
}

function Destructured(): VNode {
  const { data } = useApiLike();
  const [label] = useState("x");
  return h("div", null, `${data}${label}`);
}

const DESTRUCTURED_META: ComponentDevMeta["hooks"] = [
  { hook: "useApiLike", name: "data", line: 21 },
  { hook: "useState", name: "label", line: 22 },
];

Deno.test("named hooks: a same-module custom hook expands with breadcrumbs", () => {
  withDev(() => {
    meta("Destructured", DESTRUCTURED_META);
    meta("useApiLike", [
      { hook: "useState", name: "data", line: 16 },
      { hook: "useEffect", name: "", line: 17 },
    ]);
    const node = renderNode("Destructured", Destructured);
    assertEquals(node.hooksNamed, true);
    assertEquals(node.hooks.map((hk) => hk.name), ["useApiLike › data", undefined, "label"]);
    assertEquals(node.hooks.map((hk) => hk.hook), [
      "useApiLike › useState",
      "useApiLike › useEffect",
      "useState",
    ]);
  });
});

// ---- Across a module boundary (`HookDevMeta.from`) -------------------------

const AUTH = "file:///app/lib/auth.ts";

/** `useAuth` in `lib/auth.ts` — the same cells `useApiLike` takes (a state, then an effect). */
const AUTH_HOOKS: ComponentDevMeta["hooks"] = [
  { hook: "useState", name: "user", line: 3 },
  { hook: "useEffect", name: "", line: 4 },
];

/** `Destructured`'s calls as recorded when its custom hook is imported from `from`. */
function importedMeta(hook: string, from: string): ComponentDevMeta["hooks"] {
  return [{ hook, name: "session", line: 21, from }, { hook: "useState", name: "label", line: 22 }];
}

Deno.test("named hooks: a custom hook names across a static relative import", () => {
  withDev(() => {
    meta("Destructured", importedMeta("useAuth", AUTH));
    metaAt(AUTH, "useAuth", AUTH_HOOKS);
    // A same-named hook in the CALLER's module is a decoy: `from` decides where to look.
    meta("useAuth", [{ hook: "useRef", name: "wrong", line: 30 }]);
    const node = renderNode("Destructured", Destructured);
    assertEquals(node.hooksNamed, true);
    assertEquals(node.hooks.map((hk) => hk.name), ["useAuth › user", undefined, "label"]);
    assertEquals(node.hooks.map((hk) => hk.hook), [
      "useAuth › useState",
      "useAuth › useEffect",
      "useState",
    ]);
  });
});

Deno.test("named hooks: a default import breadcrumbs under the hook's declared name", () => {
  withDev(() => {
    meta("Destructured", importedMeta("default", AUTH));
    metaAt(AUTH, "default", AUTH_HOOKS, "useSession"); // the importee's `#default` alias
    const node = renderNode("Destructured", Destructured);
    assertEquals(node.hooksNamed, true);
    assertEquals(node.hooks[0].name, "useSession › user");
  });
});

Deno.test("named hooks: an extensionless import resolves to the importee's real file", () => {
  withDev(() => {
    // `import { useAuth } from "./auth"` records `from: …/auth`; the importee is `auth.ts`.
    meta("Destructured", importedMeta("useAuth", "file:///app/lib/auth"));
    metaAt(AUTH, "useAuth", AUTH_HOOKS);
    assertEquals(renderNode("Destructured", Destructured).hooks[0].name, "useAuth › user");
    // …and a directory import lands on its `index.*`.
    clearComponentMeta();
    meta("Destructured", importedMeta("useAuth", "file:///app/hooks"));
    metaAt("file:///app/hooks/index.ts", "useAuth", AUTH_HOOKS);
    assertEquals(renderNode("Destructured", Destructured).hooks[0].name, "useAuth › user");
  });
});

Deno.test("named hooks: a bare-specifier custom hook stops naming for the component", () => {
  withDev(() => {
    // `useApiLike` came from a package (no `from`), and this module declares no such hook:
    // how many cells it took is unknowable, so every later name would be a guess.
    meta("Destructured", DESTRUCTURED_META);
    const node = renderNode("Destructured", Destructured);
    assertEquals(node.hooksNamed, false);
    assertEquals(node.hooks.map((hk) => hk.name), [undefined, undefined, undefined]);
    assertEquals(node.hooks.map((hk) => hk.kind), ["state", "effect", "state"]);
  });
});

Deno.test("named hooks: an importee that has not registered yet leaves kind labels, no throw", () => {
  withDev(() => {
    // The component's metadata points at `lib/auth.ts`, whose footer has not run (a
    // dynamic-import ordering, or a module the transform left uninstrumented): a clean miss.
    meta("Destructured", importedMeta("useAuth", AUTH));
    const node = renderNode("Destructured", Destructured);
    assertEquals(node.hooksNamed, false);
    assertEquals(node.hooks.map((hk) => hk.kind), ["state", "effect", "state"]);
    assert(node.hooks.every((hk) => hk.name === undefined && hk.hook === undefined));
  });
});

Deno.test("named hooks: a meta/cell mismatch falls back to kind labels", () => {
  withDev(() => {
    // A hook called conditionally is missing from the metadata (the build pass records the
    // source call, the live render skipped it): the kinds stop lining up at cell 1.
    meta("Named", NAMED_META.filter((hk) => hk.hook !== "useRef"));
    const node = renderNode("Named", Named);
    assertEquals(node.hooksNamed, false);
    assertEquals(node.hooks.map((hk) => hk.kind), ["state", "ref", "memo", "effect"]);
    assert(node.hooks.every((hk) => hk.name === undefined && hk.hook === undefined));
  });
});

Deno.test("named hooks: metadata that runs out before the cells do names nothing", () => {
  withDev(() => {
    meta("Named", NAMED_META.slice(0, 2)); // kinds match, but two cells are left over
    const node = renderNode("Named", Named);
    assertEquals(node.hooksNamed, false);
    assertEquals(node.hooks[0].name, undefined);
  });
});

function OneCell(): VNode {
  const [x] = useState(1);
  return h("div", null, String(x));
}

Deno.test("named hooks: custom-hook expansion is capped at three levels", () => {
  withDev(() => {
    // A → B → C → useState: three expansions, the deepest allowed.
    meta("OneCell", [{ hook: "useA", name: "a", line: 2 }]);
    meta("useA", [{ hook: "useB", name: "b", line: 3 }]);
    meta("useB", [{ hook: "useC", name: "c", line: 4 }]);
    meta("useC", [{ hook: "useState", name: "x", line: 5 }]);
    const ok = renderNode("OneCell", OneCell);
    assertEquals(ok.hooksNamed, true);
    assertEquals(ok.hooks[0].name, "useA › useB › useC › x");
    assertEquals(ok.hooks[0].hook, "useA › useB › useC › useState");

    // One level deeper (A → B → C → D → useState) is past the cap: naming gives up.
    clearComponentMeta();
    meta("OneCell", [{ hook: "useA", name: "a", line: 2 }]);
    meta("useA", [{ hook: "useB", name: "b", line: 3 }]);
    meta("useB", [{ hook: "useC", name: "c", line: 4 }]);
    meta("useC", [{ hook: "useD", name: "d", line: 5 }]);
    meta("useD", [{ hook: "useState", name: "x", line: 6 }]);
    const deep = renderNode("OneCell", OneCell);
    assertEquals(deep.hooksNamed, false);
  });
});

Deno.test("named hooks: the three-level cap spans modules, each resolving in its own", () => {
  withDev(() => {
    const B = "file:///app/lib/b.ts";
    const C = "file:///app/c.ts";
    // OneCell → useA (b.ts) → useB (b.ts, same module as useA) → useC (c.ts) → useState.
    meta("OneCell", [{ hook: "useA", name: "a", line: 2, from: B }]);
    metaAt(B, "useA", [{ hook: "useB", name: "b", line: 3 }]);
    metaAt(B, "useB", [{ hook: "useC", name: "c", line: 4, from: C }]);
    metaAt(C, "useC", [{ hook: "useState", name: "x", line: 5 }]);
    // Decoy: `useB` has no `from`, so it must resolve in b.ts, NOT the component's module.
    meta("useB", [{ hook: "useRef", name: "wrong", line: 9 }]);
    const ok = renderNode("OneCell", OneCell);
    assertEquals(ok.hooksNamed, true);
    assertEquals(ok.hooks[0].name, "useA › useB › useC › x");

    // A fourth expansion (useC → useD back in the component's module) is past the cap.
    metaAt(C, "useC", [{ hook: "useD", name: "d", line: 5, from: MODULE }]);
    meta("useD", [{ hook: "useState", name: "x", line: 6 }]);
    assertEquals(renderNode("OneCell", OneCell).hooksNamed, false);
  });
});

Deno.test("named hooks: an uninstrumented component reports no verdict at all", () => {
  withDev(() => {
    const node = renderNode("Named", Named); // family registered, no metadata
    assertEquals(node.hooksNamed, undefined);
    assertEquals(node.hooks[0].name, undefined);
    assertEquals(node.hooks[0].kind, "state");
  });
});

// ---- The table-drift guard -------------------------------------------------

const DriftContext = createContext("ctx");

/** The primitive hooks — one dispatcher cell each, in table order. */
function usePrimitiveHooks(): void {
  useState(0);
  useReducer((s: number) => s, 0);
  useEffect(() => {}, []);
  useMemo(() => 1, []);
  useRef<number | null>(null);
  useId();
  useSyncExternalStore(() => () => {}, () => 1, () => 1);
  useMemoCache(2);
  useDeferredValue(1);
  useLayoutEffect(() => {}, []);
  useInsertionEffect(() => {}, []);
}

/** The hooks that take no cell at all (they read the fiber, or nothing). */
function useCellFreeHooks(): void {
  useContext(DriftContext);
  useDebugValue(1);
  useErrorBoundary();
}

/** The composites, whose cell sequences are derived from their implementations. */
function useCompositeHooks(): void {
  useCallback(() => {}, []);
  useEffectEvent(() => {});
  useTransition();
  useOptimistic(0);
  useImperativeHandle(null, () => ({}), []);
  useActionState((s: number) => s, 0);
  useFormState((s: number) => s, 0);
  useFormStatus();
}

/**
 * Calls every hook in {@link HOOK_CELL_KINDS} exactly once, in `CALL_ORDER`. The cells it
 * leaves behind are compared to the table's concatenation, so a dispatcher change that
 * adds/removes/reorders a cell fails here instead of silently mis-naming hooks.
 */
function AllHooks(): VNode {
  usePrimitiveHooks();
  useCellFreeHooks();
  useCompositeHooks();
  return h("div", null, "all");
}

/** The hooks {@link AllHooks} calls, in call order — one row of the table each. */
const CALL_ORDER = [
  "useState",
  "useReducer",
  "useEffect",
  "useMemo",
  "useRef",
  "useId",
  "useSyncExternalStore",
  "useMemoCache",
  "useDeferredValue",
  "useLayoutEffect",
  "useInsertionEffect",
  "useContext",
  "useDebugValue",
  "useErrorBoundary",
  "useCallback",
  "useEffectEvent",
  "useTransition",
  "useOptimistic",
  "useImperativeHandle",
  "useActionState",
  "useFormState",
  "useFormStatus",
];

/**
 * The hook cells of the fiber rendering `type` — matched by component identity, since
 * earlier tests in this file leave their own roots mounted.
 */
function componentCells(type: unknown): Array<number | undefined> {
  const stack: Fiber[] = [...devRootFibers()];
  while (stack.length > 0) {
    const fiber = stack.shift()!;
    if (fiber.tag === "component" && fiber.vnode.type === type) {
      return (fiber.hooks ?? []).map((c) => c.kind);
    }
    for (let c = fiber.child; c !== null; c = c.sibling) stack.push(c);
  }
  return [];
}

Deno.test("HOOK_CELL_KINDS matches the cells the dispatcher actually takes", () => {
  withDev(() => {
    // Every table row is exercised, and nothing is exercised that isn't in the table.
    assertEquals([...CALL_ORDER].sort(), Object.keys(HOOK_CELL_KINDS).sort());

    const { doc, container } = makeDom();
    setDocument(asAny(doc));
    createRoot(asAny(container)).render(h(AllHooks, null));
    flushSync();

    const expected = CALL_ORDER.flatMap((hook) => [...HOOK_CELL_KINDS[hook]]);
    assertEquals(componentCells(AllHooks), expected);
  });
});

// ---- The source link (B1 + B2) ---------------------------------------------

const LOC: SourceLocation = { file: `${MODULE}`, line: 42, column: 5, export: "Named" };

/** A minimal panel context — enough for the source-link builder. */
function fakeCtx(doc: FakeDocument, state: Partial<PanelState> = {}): PanelCtx {
  return { doc, S: buildStyles().S, state } as unknown as PanelCtx;
}

/** Capture the URLs `openInEditor` fetches (it is fire-and-forget). */
function withFetchSpy(fn: (urls: string[]) => void): void {
  const urls: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = ((input: string | URL) => {
    urls.push(String(input));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  try {
    fn(urls);
  } finally {
    globalThis.fetch = prev;
  }
}

Deno.test("panel: a source location renders as `app/page.tsx:42`", () => {
  assertEquals(prettySource(LOC), "app/named.tsx:42");
  // No metadata (no line) ⇒ just the path.
  assertEquals(prettySource({ file: `${MODULE}` }), "app/named.tsx");
});

Deno.test("panel: clicking the source link opens the file through the dev server", () => {
  const doc = new FakeDocument();
  const link = sourceLink(fakeCtx(doc), LOC) as unknown as FakeElement;
  assertEquals(link.textContent, "app/named.tsx:42");
  assertEquals(asAny(link).title, "/app/named.tsx:42:5");
  assertEquals(asAny(link).href, "#"); // focusable, but the click does the work
  withFetchSpy((urls) => {
    link.dispatch("click");
    assertEquals(urls.length, 1);
    const url = new URL(urls[0], "http://localhost");
    assertEquals(url.pathname, "/_denext/open-in-editor");
    assertEquals(url.searchParams.get("file"), "/app/named.tsx");
    assertEquals(url.searchParams.get("line"), "42");
    assertEquals(url.searchParams.get("column"), "5");
  });
});

Deno.test("panel: the source link falls back to vscode:// once dev endpoints are absent", () => {
  const doc = new FakeDocument();
  // SPA dev serves no `/_denext/*` endpoints — a data tab has already recorded that.
  const link = sourceLink(fakeCtx(doc, { dataUnavailable: true }), LOC) as unknown as FakeElement;
  assertEquals(asAny(link).href, "vscode://file/app/named.tsx:42:5");
  withFetchSpy((urls) => {
    link.dispatch("click");
    assertEquals(urls, []); // the browser follows the href instead
  });
  assertEquals(editorFallbackUrl({ file: "https://example.com/app.tsx", line: 1 }), "");
});

Deno.test("panel: the detail pane shows the source row and named hook rows", () => {
  const prevRaf = g.requestAnimationFrame;
  g.requestAnimationFrame = (cb: () => void) => {
    cb();
    return 0;
  };
  withDev(() => {
    meta("Named", NAMED_META, 42);
    registerFamily(Named, `${MODULE}#Named`);
    const doc = new FakeDocument();
    setDocument(asAny(doc));
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    createRoot(asAny(container)).render(h(Named, null));
    flushSync();
    const api = installInspector()!;
    mountPanel(api, asAny(doc));
    doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "d" });
    try {
      const row = [...allElements(doc.body)].find((e) =>
        e.tagName === "DIV" && e.style.cssText.includes("cursor:pointer") &&
        e.textContent.includes("Named")
      );
      assert(row, "the tree has a row for Named");
      row!.dispatch("click");
      const text = doc.body.textContent;
      assert(text.includes("app/named.tsx:42"), text);
      assert(text.includes("0 count"), text);
      assert(text.includes("· useState"), text);
      assert(!text.includes("names unavailable"), text);
    } finally {
      doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "d" });
      delete g.__denextDevtools;
      if (prevRaf === undefined) delete g.requestAnimationFrame;
      else g.requestAnimationFrame = prevRaf;
    }
  });
});

/** Every element under `root`, depth-first. */
function* allElements(root: FakeElement): Generator<FakeElement> {
  for (const child of root.childNodes) {
    if ((child as FakeElement).tagName === undefined) continue;
    yield child as FakeElement;
    yield* allElements(child as FakeElement);
  }
}

Deno.test("named hooks: a `.js` specifier resolves to the importee's `.ts` file", () => {
  withDev(() => {
    // `import { useAuth } from "./auth.js"` — the TypeScript convention — names `auth.ts`.
    meta("Destructured", importedMeta("useAuth", "file:///app/lib/auth.js"));
    metaAt(AUTH, "useAuth", AUTH_HOOKS);
    assertEquals(renderNode("Destructured", Destructured).hooks[0].name, "useAuth › user");
  });
});

Deno.test("named hooks: a hook re-exported through a barrel breadcrumbs from its declaring module", () => {
  withDev(() => {
    const barrel = "file:///app/lib/index.ts";
    const alias = (to: string) => ({ name: "useAuth", line: 0, column: 0, hooks: [], aliasOf: to });
    meta("Destructured", importedMeta("useAuth", barrel));
    registerComponentMeta(`${barrel}#useAuth`, alias(`${AUTH}#useAuth`));
    metaAt(AUTH, "useAuth", AUTH_HOOKS);
    assertEquals(renderNode("Destructured", Destructured).hooks[0].name, "useAuth › user");
    // One hop only: a barrel that re-exports another barrel's re-export stays opaque.
    clearComponentMeta();
    meta("Destructured", importedMeta("useAuth", barrel));
    registerComponentMeta(`${barrel}#useAuth`, alias("file:///app/lib/inner.ts#useAuth"));
    registerComponentMeta("file:///app/lib/inner.ts#useAuth", alias(`${AUTH}#useAuth`));
    metaAt(AUTH, "useAuth", AUTH_HOOKS);
    assertEquals(renderNode("Destructured", Destructured).hooksNamed, false);
  });
});
