// DevTools panel chrome over a bare context (tests/helpers/devtools-panel-ctx.ts): the component
// detail pane and its value rows, the tree, the page highlighter and element picker, the size
// toggle, and the shell's wiring (tabs, toolbar, keyboard, poller, live re-renders, console
// badge). The mounted panel is tests/devtools-panel.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { panelCtx } from "./helpers/devtools-panel-ctx.ts";
import type { FakeElement } from "./helpers/dom.ts";
import type { InspectNode, SerializedValue } from "../src/client/devtools-inspect.ts";
import { renderDetail } from "../src/client/devtools-panel/detail.ts";
import {
  editorFallbackUrl,
  prettySource,
  sourceLink,
} from "../src/client/devtools-panel/values.ts";
import { computeVisible, renderTree } from "../src/client/devtools-panel/tree.ts";
import { createHighlighter, createPicker } from "../src/client/devtools-panel/picker.ts";
import { syncSize, toggleSize } from "../src/client/devtools-panel/size.ts";
import { buildShell, TABS } from "../src/client/devtools-panel/shell.ts";
import {
  createDataPoller,
  wireConsole,
  wireInteractions,
  wireLiveUpdates,
} from "../src/client/devtools-panel/interactions.ts";
import { renderPanel } from "../src/client/devtools-panel/render.ts";
import { buildStyles } from "../src/client/devtools-panel/styles.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

/** Every element under `root`, in document order. */
function elements(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: FakeElement) => {
    for (const child of node.childNodes as unknown as FakeElement[]) {
      if (child.tagName === undefined) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** The first element under `root` whose text is exactly `text`. */
function byText(root: FakeElement, text: string): FakeElement {
  const hit = elements(root).find((e) => e.textContent === text);
  assert(hit, `no element reads ${JSON.stringify(text)} in ${root.textContent}`);
  return hit;
}

/** A serialized primitive. */
const prim = (raw: string | number | boolean | null, type?: SerializedValue["type"]) => ({
  preview: JSON.stringify(raw),
  type: type ?? (raw === null ? "null" : typeof raw as SerializedValue["type"]),
  raw,
});

/** A component node with `extra` over sensible defaults. */
function node(id: number, name: string, extra: Partial<InspectNode> = {}): InspectNode {
  return {
    id,
    name,
    kind: "component",
    key: null,
    props: { preview: "{}", type: "object", size: 0 },
    hooks: [],
    contexts: [],
    children: [],
    ...extra,
  } as InspectNode;
}

/** Run `fn` with `localStorage` replaced by `storage` (or a getter that throws, for `"throws"`). */
async function withStorage(
  storage: Record<string, unknown> | "throws",
  fn: () => void | Promise<void>,
): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(
    globalThis,
    "localStorage",
    storage === "throws"
      ? {
        configurable: true,
        get() {
          throw new Error("SecurityError");
        },
      }
      : { configurable: true, value: storage },
  );
  try {
    await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

/** A Map-backed `localStorage`. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

// ── Detail pane ──────────────────────────────────────────────────────────────────────────────

/** An inspector API for the detail pane, recording every call. */
function detailApi(reason: unknown = null, owners: Array<{ name: string }> = []) {
  const calls: unknown[][] = [];
  const api = {
    getRenderReason: () => reason,
    getOwnerStack: () => owners,
    clearPropOverrides: (id: number) => calls.push(["clearPropOverrides", id]),
    setPropOverride: (...a: unknown[]) => calls.push(["setPropOverride", ...a]),
    setHookState: (...a: unknown[]) => calls.push(["setHookState", ...a]),
    logValueAt: (...a: unknown[]) => calls.push(["logValueAt", ...a]),
    storeAsGlobal: (...a: unknown[]) => (calls.push(["storeAsGlobal", ...a]), "$d"),
    getValueAt: (_id: number, _ref: unknown, path: unknown[]) => ({
      preview: "{a}",
      type: "object",
      entries: path.length === 0 ? [{ key: "a", value: prim(1) }] : [],
    }),
  };
  return { api, calls };
}

Deno.test("detail: nothing selected asks for a selection", () => {
  const { ctx, detailPane } = panelCtx(detailApi().api);
  renderDetail(ctx, [node(1, "App")]);
  assertStringIncludes(detailPane.textContent, "Select a component");
});

Deno.test("detail: badges, the render count, source and owners, a props preview, no hooks", () => {
  const { ctx, detailPane } = panelCtx(
    detailApi({ count: 3, props: [], hooks: [], contexts: [] }, [{ name: "Page" }, {
      name: "Layout",
    }]).api,
  );
  ctx.state.selected = 2;
  renderDetail(ctx, [
    node(1, "App", {
      children: [
        node(2, "Card", {
          badges: ["memo"],
          source: { file: "file:///p/app/card.tsx", line: 4 },
          props: { preview: "{title}", type: "object", size: 1 },
        }),
      ],
    }),
  ]);
  const text = detailPane.textContent;
  assertStringIncludes(text, "Cardmemorendered ×3");
  assertStringIncludes(text, "app/card.tsx:4");
  assertStringIncludes(text, "Page ← Layout");
  assertStringIncludes(text, "{title}", "no prop entries: the preview");
  assertStringIncludes(text, "Hooksnone");
});

Deno.test("detail: editable props and hooks commit their edits; a reset clears the overrides", () => {
  const { api, calls } = detailApi({ count: 0, props: ["n"], hooks: [1], contexts: ["Theme"] });
  const { ctx, detailPane, calls: panel } = panelCtx(api);
  ctx.state.selected = 1;
  renderDetail(ctx, [
    node(1, "Form", {
      propEntries: [
        { key: "n", value: prim(2), editable: true },
        { key: "on", value: prim(true), editable: true },
        { key: "label", value: prim(null, "string"), editable: true },
        { key: "fn", value: { preview: "ƒ go", type: "function" }, editable: false },
      ],
      hooksNamed: false,
      hooks: [
        {
          index: 0,
          kind: "state",
          name: "count",
          hook: "useState",
          value: prim(5),
          editable: true,
        },
        {
          index: 1,
          kind: "effect",
          value: { preview: "undefined", type: "undefined" },
          editable: false,
          deps: [],
          hasCleanup: true,
          debug: {
            preview: "x",
            type: "string",
            entries: [{ key: "0", value: prim("a") }, { key: "1", value: prim("b") }],
          },
        },
        {
          index: 2,
          kind: "memo",
          hook: "useMemo",
          value: prim(9),
          editable: false,
          deps: [prim(1), prim("q")],
          debug: prim("label"),
        },
        { index: 3, kind: "state", value: prim(false), editable: true },
      ],
      contexts: [{ name: "Theme", value: prim("dark") }, { name: "Locale", value: prim("en") }],
    }),
  ]);
  const text = detailPane.textContent;
  assertStringIncludes(text, "names unavailable (hook metadata out of date)");
  assertStringIncludes(text, "0 count· useState");
  assertStringIncludes(text, "1 effect");
  assertStringIncludes(text, 'debug["a", "b"]');
  assertStringIncludes(text, "deps[] (once)");
  assertStringIncludes(text, "cleanupƒ");
  assertStringIncludes(text, 'deps[1, "q"]');
  assertStringIncludes(text, 'debug"label"');
  assertStringIncludes(text, "Context");
  // What changed is marked: the prop, the hook and the context named by the render reason.
  const changed = buildStyles().S.kChanged;
  const marked = elements(detailPane).filter((e) => e.style.cssText === changed).map((e) =>
    e.textContent
  );
  assertEquals(marked, ["n", "1 effect", "Theme"]);

  const inputs = elements(detailPane).filter((e) => e.tagName === "INPUT") as unknown as Array<
    FakeElement & { type: string; checked: boolean }
  >;
  const [num, box, textBox, hookNum, hookBox] = inputs;
  assertEquals([num.type, box.type, textBox.type, hookNum.type, hookBox.type], [
    "number",
    "checkbox",
    "text",
    "number",
    "checkbox",
  ]);
  assertEquals(textBox.value, "", "a null raw value seeds an empty box");
  num.value = "abc";
  num.dispatch("change"); // not a number: ignored
  num.value = "7";
  num.dispatch("change");
  box.checked = false;
  box.dispatch("change");
  textBox.value = "hi";
  textBox.dispatch("change");
  hookNum.value = "6";
  hookNum.dispatch("change");
  hookBox.checked = true;
  hookBox.dispatch("change");
  byText(detailPane, "reset props").dispatch("click");
  assertEquals(calls, [
    ["setPropOverride", 1, "n", 7],
    ["setPropOverride", 1, "on", false],
    ["setPropOverride", 1, "label", "hi"],
    ["setHookState", 1, 0, 6],
    ["setHookState", 1, 3, true],
    ["clearPropOverrides", 1],
  ]);
  assertEquals(panel.renders, 1);
});

Deno.test("values: an object row expands one level on demand; copy, log and $d act on the live value", async () => {
  const { api, calls } = detailApi();
  const { ctx, detailPane, calls: panel } = panelCtx(api);
  ctx.state.selected = 1;
  const tree = [
    node(1, "List", {
      propEntries: [{
        key: "items",
        value: { preview: "{a}", type: "object", size: 1 },
        editable: false,
      }],
    }),
  ];
  renderDetail(ctx, tree);
  const toggle = byText(detailPane, "▶ {a}");
  toggle.dispatch("click");
  assertEquals(panel.renders, 1);
  assert(ctx.state.expanded.size === 1, "the row is marked open");
  detailPane.replaceChildren();
  renderDetail(ctx, tree);
  assertStringIncludes(detailPane.textContent, "▼ {a}");
  assertStringIncludes(detailPane.textContent, "a1", "the child entry is drawn");
  byText(detailPane, "▼ {a}").dispatch("click");
  assertEquals(ctx.state.expanded.size, 0, "a second click closes it");

  const written: string[] = [];
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "clipboard");
  try {
    Object.defineProperty(nav, "clipboard", {
      configurable: true,
      value: { writeText: (t: string) => void written.push(t) },
    });
    const [copy] = elements(detailPane).filter((e) => e.textContent === "copy");
    copy.dispatch("click");
    assertEquals(written, ["{a}"]);
    Object.defineProperty(nav, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          throw new Error("no clipboard");
        },
      },
    });
    copy.dispatch("click"); // a throwing clipboard is ignored
  } finally {
    if (had) Object.defineProperty(nav, "clipboard", had);
    else delete nav.clipboard;
  }
  const log = elements(detailPane).find((e) => e.textContent === "log")!;
  const store = elements(detailPane).find((e) => e.textContent === "$d")!;
  log.dispatch("click");
  store.dispatch("click");
  assertEquals(store.textContent, "✓$d");
  ctx.state.selected = null; // nothing selected: the actions do nothing
  log.dispatch("click");
  store.dispatch("click");
  assertEquals(calls.map((c) => c[0]), ["logValueAt", "storeAsGlobal"]);
  await Promise.resolve();
});

Deno.test("prettySource: same-origin modules by their path, others by their tail, bad URLs too", () => {
  const g = globalThis as { location?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost:3000" },
  });
  try {
    assertEquals(
      prettySource({ file: "http://localhost:3000/app/page.tsx", line: 2 }),
      "app/page.tsx:2",
    );
    assertEquals(prettySource({ file: "http://cdn.example/x/y/z.js" }), "y/z.js");
    assertEquals(prettySource({ file: "file:///p/app/a.tsx" }), "app/a.tsx");
    assertEquals(prettySource({ file: "not a url/dir/f.tsx", line: 1 }), "dir/f.tsx:1");
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete g.location;
  }
});

Deno.test("sourceLink: the editor endpoint, or the vscode:// fallback once dev endpoints are unavailable", async () => {
  const { ctx } = panelCtx();
  const src = { file: "file:///p/a%20b.tsx", line: 3, column: 5 };
  const link = sourceLink(ctx, src) as unknown as FakeElement & { href: string; title: string };
  assertEquals(link.href, "#");
  assertEquals(link.title, "/p/a b.tsx:3:5");
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const urls: string[] = [];
  globalThis.fetch = (input) => (urls.push(String(input)), Promise.resolve(new Response("")));
  AbortSignal.timeout = () => new AbortController().signal;
  try {
    let prevented = false;
    link.dispatch("click", { preventDefault: () => void (prevented = true) });
    await new Promise((r) => setTimeout(r, 0));
    assert(prevented, "the endpoint path keeps the browser off #");
    assertEquals(new URL(urls[0], "http://x").searchParams.get("file"), "/p/a b.tsx");
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
  ctx.state.dataUnavailable = true;
  const fallback = sourceLink(ctx, { file: "file:///p/a.tsx" }) as unknown as { href: string };
  assertEquals(fallback.href, "vscode://file/p/a.tsx:1:1");
  let followed = true;
  (fallback as unknown as FakeElement).dispatch("click", {
    preventDefault: () => void (followed = false),
  });
  assert(followed, "the browser follows the vscode:// link");
  assertEquals(editorFallbackUrl({ file: "http://localhost/x.tsx" }), "");
  // A file URL that can't be decoded keeps its text.
  const odd = sourceLink(ctx, { file: "file:///p/%E0%A4%A.tsx" }) as unknown as { title: string };
  assertEquals(odd.title, "file:///p/%E0%A4%A.tsx:1:1");
});

// ── Tree pane ────────────────────────────────────────────────────────────────────────────────

Deno.test("tree: host rows only when asked, keys and badges, collapse, select and hover", () => {
  const hosts: number[] = [];
  const { ctx, treePane, calls } = panelCtx({
    getHostNode: (id: number) => (hosts.push(id), { id }),
  });
  const tree = [
    node(1, "App", {
      children: [
        node(2, "div", {
          kind: "host",
          children: [node(3, "Item", { key: "a", badges: ["memo"] }), node(4, "Leaf")],
        }),
      ],
    }),
  ];
  renderTree(ctx, tree, 0, null);
  assertEquals(treePane.textContent, "▼AppItem key=amemoLeaf", "the host row is skipped");
  treePane.replaceChildren();
  ctx.state.showHost = true;
  renderTree(ctx, tree, 0, null);
  assertStringIncludes(treePane.textContent, "▼div");
  const [appRow] = elements(treePane).filter((e) => e.tagName === "DIV");
  const twisty = byText(appRow, "▼");
  twisty.dispatch("click");
  assert(ctx.state.collapsed.has(1), "the twisty collapses");
  assertEquals(calls.selected, [], "the twisty does not select");
  treePane.replaceChildren();
  renderTree(ctx, tree, 0, null);
  assertEquals(treePane.textContent, "▶App", "a collapsed node hides its subtree");
  byText(treePane, "▶").dispatch("click");
  assert(!ctx.state.collapsed.has(1), "and expands again");
  const row = elements(treePane)[0];
  row.dispatch("click");
  row.dispatch("mouseenter");
  row.dispatch("mouseleave");
  ctx.state.picking = true; // the picker owns the highlight
  row.dispatch("mouseenter");
  row.dispatch("mouseleave");
  assertEquals(calls.selected, [1]);
  assertEquals(hosts, [1]);
  assertEquals(calls.highlighted.length, 1);
  assertEquals(calls.hidden, 1);
});

Deno.test("tree: the search keeps a match and its ancestors", () => {
  const tree = [
    node(1, "App", {
      children: [node(2, "Header"), node(3, "Body", { children: [node(4, "Btn")] })],
    }),
  ];
  assertEquals(computeVisible("", tree), null);
  assertEquals([...computeVisible("btn", tree)!].sort(), [1, 3, 4]);
  const { ctx, treePane } = panelCtx();
  renderTree(ctx, tree, 0, computeVisible("btn", tree));
  assertEquals(treePane.textContent, "▼App▼BodyBtn");
});

// ── Highlighter and picker ───────────────────────────────────────────────────────────────────

/** A page element with a layout box. */
const boxed = (top = 30, left = 10) => ({
  getBoundingClientRect: () => ({ top, left, width: -5, height: 20 }),
});

Deno.test("highlighter: hover with and without a label, a flash that restores itself, nothing for a non-element", async () => {
  const { doc } = panelCtx();
  const { S } = buildStyles();
  const hl = createHighlighter(asAny(doc), S);
  const overlay = hl.overlay as unknown as FakeElement & { style: Record<string, string> };
  const tip = hl.tip as unknown as FakeElement & { style: Record<string, string> };
  hl.highlight(asAny(boxed()), "Card");
  assertEquals([overlay.style.display, overlay.style.width, tip.style.display, tip.style.top], [
    "block",
    "0px",
    "block",
    "12px",
  ]);
  assertEquals(tip.textContent, "Card");
  hl.highlight(asAny(boxed(5)));
  assertEquals(tip.style.display, "none", "no label, no tip");
  hl.highlight(null);
  assertEquals(overlay.style.display, "none", "no node hides the overlay");
  hl.flash(null, "red", 0); // ignored
  hl.flash(asAny({}), "red", 0); // not an element: ignored
  assertEquals(overlay.style.display, "none");
  hl.flash(asAny(boxed()), "red", 0);
  assertEquals([overlay.style.display, overlay.style.borderColor], ["block", "red"]);
  hl.flash(asAny(boxed()), "yellow", 0); // supersedes the first
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(overlay.style.display, "none", "the flash ends by itself");
  assertEquals(overlay.style.borderColor, S.overlayBorder, "and puts the resting colours back");
  hl.flash(asAny(boxed()), "red", 60_000);
  hl.hideHighlight(); // cancels the pending restore (no timer left behind)
  assertEquals(overlay.style.background, S.overlayBg);
});

Deno.test("picker: hover highlights the owning component, a click selects it, Escape stops", () => {
  const { doc } = panelCtx();
  const { S } = buildStyles();
  const state = panelCtx().ctx.state;
  const seen: Array<[unknown, string | undefined]> = [];
  let hidden = 0;
  const hl = {
    overlay: asAny(null),
    tip: asAny(null),
    highlight: (n: unknown, label?: string) => void seen.push([n, label]),
    hideHighlight: () => void hidden++,
    flash: () => {},
  };
  const pickBtn = doc.createElement("button");
  const selected: number[] = [];
  const page = { name: "page" };
  const picker = createPicker(
    asAny(doc),
    asAny({
      getInspectorTree: () => [node(5, "Card")],
      getFiberIdForDom: (t: unknown) => t === page ? 5 : t === "orphan" ? 9 : null,
      getHostNode: (id: number) => ({ host: id }),
    }),
    S,
    state,
    asAny(pickBtn),
    hl,
    (id) => void selected.push(id),
  );
  picker.start();
  picker.start(); // already picking: no second set of listeners
  assert(state.picking);
  assertEquals(pickBtn.style.cssText, S.iconOn);
  doc.dispatch("pointermove", { target: page });
  doc.dispatch("pointermove", { target: "orphan" }); // a fiber the tree no longer has
  doc.dispatch("pointermove", {}); // no target
  assertEquals(seen, [[{ host: 5 }, "Card"], [{ host: 9 }, "?"]]);
  assertEquals(hidden, 1);
  doc.dispatch("keydown", { key: "a" });
  assert(state.picking, "another key keeps picking");
  doc.dispatch("click", { target: page });
  assertEquals(selected, [5]);
  assert(!state.picking, "a click ends the pick");
  picker.stop(); // not picking: nothing to undo
  picker.start();
  doc.dispatch("click", {}); // a click on nothing selects nothing
  assertEquals(selected, [5]);
  picker.start();
  doc.dispatch("keydown", { key: "Escape" });
  assert(!state.picking);
  assertEquals(pickBtn.style.cssText, S.icon);
});

// ── Size toggle ──────────────────────────────────────────────────────────────────────────────

Deno.test("size: toggles per tab and is remembered; junk or blocked storage falls back to half", async () => {
  const { ctx, doc, calls } = panelCtx();
  const shell = buildShell(asAny(doc), ctx.S);
  const storage = memoryStorage({ "denext:devtools:size": "junk{" });
  await withStorage(storage, () => {
    syncSize(ctx, shell);
    assertEquals(shell.sizeBtn.textContent, "⤢", "junk reads as half");
    toggleSize(ctx);
    assertEquals(JSON.parse(storage.map.get("denext:devtools:size")!), { components: "full" });
    ctx.state.open = true;
    syncSize(ctx, shell);
    assertEquals(shell.sizeBtn.textContent, "⤡");
    assertEquals(shell.sizeBtn.getAttribute("aria-label"), "Half screen");
    assertEquals((shell.panel.style as unknown as { display: string }).display, "flex");
    toggleSize(ctx);
    assertEquals(JSON.parse(storage.map.get("denext:devtools:size")!), { components: "half" });
    storage.map.set("denext:devtools:size", "5"); // valid JSON, not an object
    syncSize(ctx, shell);
    assertEquals(shell.sizeBtn.textContent, "⤢");
  });
  await withStorage("throws", () => {
    toggleSize(ctx); // nowhere to remember it: still re-renders
    syncSize(ctx, shell);
    assertEquals(shell.sizeBtn.textContent, "⤢");
  });
  await withStorage({
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceeded");
    },
  }, () => toggleSize(ctx));
  await withStorage(undefined as unknown as Record<string, unknown>, () => {
    syncSize(ctx, shell);
    assertEquals(shell.sizeBtn.textContent, "⤢", "no storage at all");
  });
  assertEquals(calls.renders, 4);
});

// ── Shell wiring ─────────────────────────────────────────────────────────────────────────────

/** A mounted shell with recording deps. */
function wired(api: Record<string, unknown> = {}) {
  const panel = panelCtx(api);
  const shell = buildShell(asAny(panel.doc), panel.ctx.S);
  const log: string[] = [];
  const deps = {
    picker: { start: () => void log.push("pick:start"), stop: () => void log.push("pick:stop") },
    setOpen: (open: boolean) => {
      panel.ctx.state.open = open;
      log.push(`open:${open}`);
    },
    poller: { sync: () => void log.push(`sync:${panel.ctx.state.tab}`), stop: () => {} },
    highlightUpdates: { setEnabled: (on: boolean) => void log.push(`hl:${on}`) },
  };
  wireInteractions(panel.ctx, shell, deps);
  return { ...panel, shell, log };
}

Deno.test("wiring: the launcher, close, badge, tab buttons and toolbar", async () => {
  const { ctx, shell, log, doc, calls } = wired();
  await withStorage(memoryStorage(), () => {
    (shell.launch as unknown as FakeElement).dispatch("click");
    (shell.closeBtn as unknown as FakeElement).dispatch("click");
    (shell.badge as unknown as FakeElement).dispatch("click");
    assertEquals(ctx.state.tab, "console");
    (shell.tabs.cache as unknown as FakeElement).dispatch("click");
    assertEquals(ctx.state.tab, "cache");
    (shell.sizeBtn as unknown as FakeElement).dispatch("click");
  });
  const pick = shell.pickBtn as unknown as FakeElement;
  pick.dispatch("click");
  ctx.state.picking = true;
  pick.dispatch("click");
  const search = shell.searchBox as unknown as FakeElement;
  search.value = "  CaRd ";
  search.dispatch("input");
  assertEquals(ctx.state.search, "card");
  const host = shell.hostBtn as unknown as FakeElement;
  host.dispatch("click");
  assertEquals([ctx.state.showHost, host.style.cssText], [true, ctx.S.iconOn]);
  host.dispatch("click");
  assertEquals([ctx.state.showHost, host.style.cssText], [false, ctx.S.icon]);
  const hlBtn = shell.hlBtn as unknown as FakeElement;
  hlBtn.dispatch("click");
  hlBtn.dispatch("click");
  assertEquals(log, [
    "open:true",
    "open:false",
    "open:true",
    "sync:cache",
    "pick:start",
    "pick:stop",
    "hl:true",
    "hl:false",
  ]);
  assert(calls.renders >= 6);
  assert(doc, "the document is the shell's");
});

Deno.test("wiring: the keyboard map — toggle, tab chords and steps both ways, Escape, Cmd ignored", () => {
  const { ctx, doc, log } = wired();
  const key = (key: string, mods: Record<string, boolean> = {}) => {
    let prevented = false;
    doc.dispatch("keydown", { key, ...mods, preventDefault: () => void (prevented = true) });
    return prevented;
  };
  assertEquals(key("3", { altKey: true }), false, "tab chords need the panel open");
  assertEquals(
    key("d", { ctrlKey: true, shiftKey: true, metaKey: true }),
    false,
    "Cmd is the OS's",
  );
  assert(key("D", { ctrlKey: true, shiftKey: true }));
  assert(ctx.state.open);
  assert(key("3", { altKey: true }));
  assertEquals(ctx.state.tab, TABS[2].id);
  for (const k of ["{", "["]) key(k, { ctrlKey: true, shiftKey: true });
  assertEquals(ctx.state.tab, TABS[0].id);
  key("[", { ctrlKey: true, shiftKey: true }); // wraps to the last tab
  assertEquals(ctx.state.tab, TABS.at(-1)!.id);
  for (const k of ["}", "]"]) key(k, { ctrlKey: true, shiftKey: true });
  assertEquals(ctx.state.tab, TABS[1].id);
  assertEquals(key("x"), false, "an unmapped key is left alone");
  ctx.state.picking = true;
  key("Escape");
  assert(ctx.state.open, "Escape stops the picker first");
  ctx.state.picking = false;
  key("Escape");
  assert(!ctx.state.open, "then closes the panel");
  assertEquals(log.filter((l) => l.startsWith("pick") || l.startsWith("open")), [
    "open:true",
    "pick:stop",
    "open:false",
  ]);
});

Deno.test("poller: polls only an open data tab, once; Routes reads once; closing stops it", async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const realInterval = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const urls: string[] = [];
  let intervals = 0;
  let cleared = 0;
  globalThis.fetch = (input) => (urls.push(String(input)), Promise.resolve(Response.json({})));
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.setInterval = (() => ++intervals) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => void cleared++) as typeof clearInterval;
  try {
    const { ctx } = panelCtx();
    const poller = createDataPoller(ctx);
    poller.sync(); // closed: nothing
    ctx.state.open = true;
    ctx.state.tab = "cache";
    poller.sync();
    poller.sync(); // already polling: no second interval
    assertEquals(intervals, 1);
    ctx.state.tab = "routes";
    poller.sync(); // one-shot read, the interval stopped
    ctx.state.tab = "components";
    poller.sync(); // no endpoint: nothing read
    ctx.state.open = false;
    poller.sync();
    poller.stop();
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(cleared, 1);
    assertEquals(urls.map((u) => new URL(u, "http://x").pathname), [
      "/_denext/dev-cache",
      "/_denext/dev-routes",
    ]);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    globalThis.setInterval = realInterval;
    globalThis.clearInterval = realClear;
  }
});

Deno.test("live updates: commits and reveals re-render once per frame, only while open (and reveals only on Render modes)", async () => {
  let commit = () => {};
  let reveal = () => {};
  const { ctx, calls } = panelCtx({
    subscribe: (fn: () => void) => void (commit = fn),
    subscribeBoundaries: (fn: () => void) => void (reveal = fn),
  });
  const g = globalThis as { requestAnimationFrame?: unknown };
  const hadRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const frames: Array<() => void> = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (cb: () => void) => frames.push(cb),
  });
  try {
    wireLiveUpdates(ctx);
    commit(); // closed: nothing
    ctx.state.open = true;
    commit();
    commit(); // coalesced into the queued frame
    reveal(); // not on the Render-modes tab
    assertEquals(frames.length, 1);
    frames.shift()!();
    assertEquals(calls.renders, 1);
    ctx.state.tab = "render";
    reveal();
    ctx.state.open = false; // closed before the frame: no render
    frames.shift()!();
    assertEquals(calls.renders, 1);
  } finally {
    if (hadRaf) Object.defineProperty(globalThis, "requestAnimationFrame", hadRaf);
    else delete g.requestAnimationFrame;
  }
  // No requestAnimationFrame (a worker): a 16 ms timer stands in.
  ctx.state.open = true;
  ctx.state.tab = "components";
  commit();
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(calls.renders, 2);
});

Deno.test("console badge: the error count beside the launcher, 99+, and a live Console tab", async () => {
  const { ctx, doc, calls } = panelCtx();
  const shell = buildShell(asAny(doc), ctx.S);
  const g = globalThis as { __denextConsole?: unknown };
  const prev = g.__denextConsole;
  // No capture: an always-hidden badge.
  delete g.__denextConsole;
  const none = wireConsole(ctx, shell);
  none();
  assertEquals((shell.badge.style as unknown as { display: string }).display, "none");

  let notify = () => {};
  const store = {
    entries: [],
    errorCount: 3,
    subscribe: (fn: () => void) => void (notify = fn),
  };
  g.__denextConsole = store;
  const realSetTimeout = globalThis.setTimeout;
  const later: Array<() => void> = [];
  try {
    const sync = wireConsole(ctx, shell);
    assertEquals(shell.badge.textContent, "3");
    assertEquals((shell.badge.style as unknown as { display: string }).display, "");
    store.errorCount = 150;
    sync();
    assertEquals(shell.badge.textContent, "99+");
    globalThis.setTimeout = ((fn: () => void) => (later.push(fn), 0)) as typeof setTimeout;
    notify(); // closed: the badge only
    ctx.state.open = true;
    ctx.state.tab = "console";
    notify();
    notify(); // coalesced
    assertEquals(later.length, 1);
    assertEquals(
      (shell.badge.style as unknown as { display: string }).display,
      "none",
      "hidden while open",
    );
    later.shift()!();
    assertEquals(calls.renders, 1, "the open Console tab re-renders");
    ctx.state.tab = "components";
    notify(); // another tab: no re-render queued
    assertEquals(later.length, 0);
    ctx.state.tab = "console";
    notify();
    ctx.state.open = false; // closed before the timer: no render
    later.shift()!();
    assertEquals(calls.renders, 1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (prev === undefined) delete g.__denextConsole;
    else g.__denextConsole = prev;
  }
  await Promise.resolve();
});

// ── Whole-panel render ───────────────────────────────────────────────────────────────────────

Deno.test("renderPanel: each tab's renderer draws into a cleared pane; the tree only on Components", async () => {
  const { ctx, doc, detailPane, treePane } = panelCtx({
    getInspectorTree: () => [],
    getRenderReason: () => null,
    getOwnerStack: () => [],
  });
  const shell = buildShell(asAny(doc), ctx.S);
  await withStorage(memoryStorage(), () => {
    renderPanel(ctx, shell);
    assertStringIncludes(treePane.textContent, "nothing mounted");
    assertEquals(shell.tabs.components.getAttribute("aria-selected"), "true");
    ctx.state.tab = "mvu";
    renderPanel(ctx, shell);
    assertEquals(treePane.textContent, "", "the tree pane is cleared");
    assertStringIncludes(detailPane.textContent, "No Model–View–Update program is running");
    assertEquals((shell.leftPane.style as unknown as { display: string }).display, "none");
    assertEquals(shell.tabs.mvu.getAttribute("tabindex"), "0");
    assertEquals(shell.tabs.components.getAttribute("tabindex"), "-1");
  });
});
