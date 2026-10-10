// `spa.shell` client runtime (src/client/shell-runtime.ts + src/client/shell-handoff.ts) on the
// real reconciler over the in-memory DOM: the app's `createRoot(getElementById("root"))` mounts
// into a hidden stage while the prerendered shell stays; `shellReady()`, the first settled commit
// or `maxHoldMs` swap it in at once; and the shell fields' state carries over (a controlled
// <textarea> gets the text through its onChange, the caret and the focus). The capture script that
// fills `__denextShell` in a browser is stood in for by a fake `c()` here; the real one is driven
// in Chromium and WebKit by tests/e2e/spa-shell.e2e.test.ts.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { installShellSupport } from "../src/client/shell-runtime.ts";
import {
  consumeShellHandoff,
  type ShellGlobal,
  shellReady,
  useShellHandoff,
} from "../src/client/shell-handoff.ts";
import type { VNode } from "../src/jsx/types.ts";
import { FakeDocument, FakeElement, type FakeNode } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** An element with what the shell runtime reads: selectors, clone, focus, selection, events. */
class ShellEl extends FakeElement {
  selectionStart = 0;
  selectionEnd = 0;
  scrollTop = 0;
  querySelector(selector: string): ShellEl | null {
    return find(this, selector);
  }
  cloneNode(): ShellEl {
    const copy = (this.ownerDocument as ShellDoc).createElement(this.tagName);
    for (const [k, v] of this.attributes) copy.setAttribute(k, v);
    const style = this.getAttribute("style");
    if (style !== null) copy.setAttribute("style", style);
    return copy;
  }
  override focus(): void {
    (this.ownerDocument as ShellDoc).activeElement = this;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  dispatchEvent(event: Event): boolean {
    this.dispatch(event.type);
    return true;
  }
}

class ShellDoc extends FakeDocument {
  activeElement: ShellEl | null = null;
  override createElement(tag: string): ShellEl {
    const el = new ShellEl(tag);
    el.ownerDocument = this;
    return el;
  }
  querySelector(selector: string): ShellEl | null {
    return find(this.documentElement, selector);
  }
  override getElementById(id: string): ShellEl | null {
    return find(this.documentElement, `[id="${id}"]`);
  }
}

/** The first element (document order) matching `[attr]` / `[attr="value"]`. */
function find(root: FakeNode, selector: string): ShellEl | null {
  const m = /^\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]$/.exec(selector);
  if (!m) throw new Error(`unsupported selector ${selector}`);
  const want = m[2]?.replace(/\\(.)/g, "$1");
  for (const child of root.childNodes) {
    if (!(child instanceof ShellEl)) continue;
    const v = child.getAttribute(m[1]);
    if (v !== null && (want === undefined || v === want)) return child;
    const hit = find(child, selector);
    if (hit) return hit;
  }
  return null;
}

/** Observers the runtime creates; `notify()` delivers one batch to each (as after a commit). */
const observers: Array<() => void> = [];
class FakeMutationObserver {
  constructor(private readonly cb: () => void) {}
  observe(): void {
    observers.push(this.cb);
  }
  disconnect(): void {
    const i = observers.indexOf(this.cb);
    if (i !== -1) observers.splice(i, 1);
  }
}
function notify(): void {
  for (const cb of [...observers]) cb();
}

interface Page {
  doc: ShellDoc;
  shell: ShellEl;
  shellField: ShellEl;
  g: ShellGlobal;
  done(): void;
}

/**
 * A page as the export serves it: `<div id="root" data-denext-shell>` holding a keyed textarea
 * the user typed `text` into (caret at `caret`, focused), and the capture global.
 */
function shellPage(text = "draft", caret = 2): Page {
  const doc = new ShellDoc();
  setDocument(doc as Any);
  const shell = doc.createElement("div");
  shell.setAttribute("id", "root");
  shell.setAttribute("class", "app");
  shell.setAttribute("data-denext-shell", "");
  const shellField = doc.createElement("textarea");
  shellField.setAttribute("data-denext-shell-key", "composer");
  shellField.value = text;
  shellField.setSelectionRange(caret, caret);
  shell.appendChild(shellField);
  doc.body.appendChild(shell);
  shellField.focus();
  const g: ShellGlobal = {
    s: {},
    t: {},
    c: () => {
      g.s.composer = {
        text: shellField.value,
        selectionStart: shellField.selectionStart,
        selectionEnd: shellField.selectionEnd,
        focused: doc.activeElement === shellField,
        scrollTop: 0,
      };
      return g.s;
    },
  };
  const saved = {
    document: (globalThis as Any).document,
    shell: (globalThis as Any).__denextShell,
    mo: (globalThis as Any).MutationObserver,
  };
  (globalThis as Any).document = doc;
  (globalThis as Any).__denextShell = g;
  (globalThis as Any).MutationObserver = FakeMutationObserver;
  return {
    doc,
    shell,
    shellField,
    g,
    done() {
      (globalThis as Any).document = saved.document;
      (globalThis as Any).__denextShell = saved.shell;
      (globalThis as Any).MutationObserver = saved.mo;
      observers.length = 0;
    },
  };
}

/** The app: a controlled textarea paired with the shell's, plus its state echoed. */
function Composer(): VNode {
  const [text, setText] = useState("");
  return h("div", null, [
    h("textarea", {
      "data-denext-shell-key": "composer",
      value: text,
      onChange: (e: Any) => setText(e.target.value),
    }),
    h("output", { "data-testid": "state" }, text),
  ]);
}

Deno.test("spa.shell: the app renders into a hidden stage and the shell stays until shellReady()", async () => {
  const page = shellPage();
  try {
    installShellSupport({ readyOn: "shellReady", maxHoldMs: 60_000 });
    const stage = page.doc.getElementById("root")!;
    assert(stage !== page.shell, "getElementById reaches the stage first");
    assertEquals(stage.getAttribute("class"), "app", "the stage carries the mount's attributes");
    assertEquals(stage.getAttribute("data-denext-shell"), null);
    assert(stage.getAttribute("style")!.includes("visibility:hidden"));
    assertEquals(stage.getAttribute("inert"), "");
    createRoot(stage as Any).render(h(Composer, null));
    notify(); // a commit: under readyOn "shellReady" nothing swaps
    assert(page.shell.parentNode === page.doc.body, "the shell is still painted");
    assertEquals(page.doc.activeElement, page.shellField, "the user's field keeps focus");

    await shellReady();
    assertEquals(page.shell.parentNode, null, "the shell is gone");
    assertEquals(stage.parentNode, page.doc.body);
    assertEquals(stage.getAttribute("style"), null, "the stage's own style is back");
    assertEquals(stage.getAttribute("inert"), null);
    assertEquals(stage.getAttribute("aria-hidden"), null);
    const field = stage.querySelector('[data-denext-shell-key="composer"]')!;
    assert(field !== page.shellField);
    assertEquals(field.value, "draft");
    flushSync();
    assertEquals(
      stage.querySelector('[data-testid="state"]')!.textContent,
      "draft",
      "the controlled field's onChange adopted the text",
    );
    assertEquals([field.selectionStart, field.selectionEnd], [2, 2]);
    assertEquals(page.doc.activeElement, field, "focus moved to the app's field");
    assertEquals(page.g.d, 1);
    assertEquals(consumeShellHandoff("composer"), null, "denext took the composer's state");
    await shellReady(); // after the swap: resolves at once
  } finally {
    page.done();
  }
});

Deno.test("spa.shell: first-settled-commit waits until no Suspense fallback is showing", async () => {
  const page = shellPage();
  try {
    installShellSupport({ maxHoldMs: 60_000 });
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    let ready = false;
    const Data = (): VNode => {
      if (!ready) throw gate;
      return h("p", null, "data");
    };
    const stage = page.doc.getElementById("root")!;
    createRoot(stage as Any).render(
      h(Suspense, { fallback: h("span", null, "loading"), children: h(Data, null) }),
    );
    notify();
    assert(page.shell.parentNode !== null, "a fallback is showing: the shell stays");
    ready = true;
    resolve();
    await gate;
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    notify();
    assertEquals(page.shell.parentNode, null, "the settled commit swapped the shell out");
    assertEquals(stage.textContent, "data");
  } finally {
    page.done();
  }
});

Deno.test("spa.shell: maxHoldMs swaps without a ready signal", async () => {
  const page = shellPage();
  try {
    installShellSupport({ readyOn: "shellReady", maxHoldMs: 0 });
    createRoot(page.doc.getElementById("root") as Any).render(h(Composer, null));
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(page.shell.parentNode, null);
    assertEquals(page.g.d, 1);
  } finally {
    page.done();
  }
});

Deno.test("spa.shell: a key the app consumed is not filled in, but its field still gets focus", async () => {
  const page = shellPage("typed", 5);
  try {
    installShellSupport({ readyOn: "shellReady", maxHoldMs: 60_000 });
    let seen: unknown = undefined;
    const Taker = (): VNode => {
      seen = useShellHandoff("composer");
      return h(Composer, null);
    };
    const stage = page.doc.getElementById("root")!;
    createRoot(stage as Any).render(h(Taker, null));
    assertEquals(seen, {
      text: "typed",
      selectionStart: 5,
      selectionEnd: 5,
      focused: true,
      scrollTop: 0,
    });
    assertEquals(consumeShellHandoff("composer"), null, "once");
    await shellReady();
    const field = stage.querySelector('[data-denext-shell-key="composer"]')!;
    assertEquals(field.value, "", "the app owns a consumed key's value");
    assertEquals(page.doc.activeElement, field);
  } finally {
    page.done();
  }
});

Deno.test("spa.shell: shellReady() before the install swaps once the app has mounted", async () => {
  const page = shellPage();
  try {
    const ready = shellReady();
    assertEquals(page.g.r, 1);
    installShellSupport({ readyOn: "shellReady", maxHoldMs: 60_000 });
    createRoot(page.doc.getElementById("root") as Any).render(h(Composer, null));
    await ready;
    assertEquals(page.shell.parentNode, null);
  } finally {
    page.done();
  }
});

Deno.test("spa.shell: without a shell the API is inert and the install does nothing", async () => {
  const doc = new ShellDoc();
  const saved = (globalThis as Any).document;
  (globalThis as Any).document = doc;
  try {
    assertEquals((globalThis as Any).__denextShell, undefined);
    await shellReady();
    assertEquals(consumeShellHandoff("composer"), null);
    installShellSupport();
    assertEquals(doc.body.childNodes.length, 0);
  } finally {
    (globalThis as Any).document = saved;
  }
});
