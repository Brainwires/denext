// Events before an isomorphic island hydrates (src/client/iso-island.ts), as React's selective
// hydration handles them: a user event on a kept island's server DOM wakes the island at once,
// whatever its strategy, so it runs through the page once (capture handlers included); a split
// island whose chunk is still loading holds the events and replays them in order once it has
// hydrated; an island nested in a kept one wakes with it.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { installIsoIslands, isoIslandChunk } from "../src/client/iso-island.ts";
import { resetLazyIslands, setLazyScheduler } from "../src/client/lazy-hydrate.ts";
import { setIslandRender } from "../src/client/fiber/render-component.ts";
import { setIslandHydration } from "../src/client/fiber/hydration.ts";
import { type DomEl, fireEventOn } from "../src/testing/dom.ts";
import type { VNode } from "../src/jsx/types.ts";
import { serverDom } from "./helpers/server-dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** What the handlers saw, in order. */
let log: string[] = [];

/** The island: a field and a button, logging what reaches them. */
function Form({ name }: { name: string }): VNode {
  return h(
    "form",
    { onClickCapture: () => log.push(`${name} capture click`) },
    h("textarea", {
      onInput: () => log.push(`${name} input`),
      onKeyDown: () => log.push(`${name} keydown`),
    }),
    h("button", { type: "button", onClick: () => log.push(`${name} click`) }, "go"),
  );
}

/** An island holding another island (`client:idle`, a trigger the test never fires). */
function Outer(): VNode {
  return h(
    "section",
    { onClick: () => log.push("outer click") },
    h(Form, {
      "client:idle": true,
      name: "inner",
    }),
  );
}

/** The page: a capture and a bubble handler above the island. */
function Page({ C, strategy }: { C: unknown; strategy: string }): VNode {
  return h(
    "main",
    {
      onClickCapture: () => log.push("page capture click"),
      onClick: () => log.push("page click"),
    },
    h(C as never, { [`client:${strategy}`]: true, name: "island" }),
  );
}

/** A scheduler whose triggers never fire: only an event wakes an island. */
function noTriggers(): void {
  setLazyScheduler({
    idle: () => {},
    visible: () => () => {},
    media: () => () => {},
  });
}

/** The testing DOM's event, with a constructor the replay can copy it through. */
class Evt {
  constructor(readonly type: string) {}
}

/** Dispatch a copy (the replay) through the same propagation as a fresh event. */
function replayable(el: DomEl): void {
  (el as Any).dispatchEvent = (e: Evt) => (fireEventOn(el, e.type, { constructor: Evt }), true);
}

const fire = (el: DomEl, type: string) => fireEventOn(el, type, { constructor: Evt });

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Hydrate the server render of `Page` (with `Comp`), `C` standing in for it on the client. */
async function hydrated(Comp: unknown, C: unknown, strategy: string) {
  const html = await renderToString(h(Page, { C: Comp, strategy }));
  const { doc, container } = serverDom(html);
  // The page's container sits in a document: the early listener goes above it.
  doc.createElement("body").appendChild(container as never);
  setDocument(doc as Any);
  installIsoIslands();
  const mismatches: unknown[] = [];
  hydrateRoot(container as Any, h(Page, { C, strategy }), {
    onRecoverableError: (e: unknown) => mismatches.push(e),
  } as Any);
  flushSync();
  log = [];
  return { container, mismatches };
}

/** The elements of the (first) form under `root`. */
function formIn(root: DomEl): { input: DomEl; button: DomEl } {
  const queue = [root];
  while (queue.length) {
    const el = queue.shift()!;
    if (el.tagName === "FORM") {
      const [input, button] = el.children;
      replayable(input);
      replayable(button);
      return { input, button };
    }
    queue.push(...el.children);
  }
  throw new Error("no form");
}

function teardown() {
  setIslandRender(null);
  setIslandHydration(null);
  resetLazyIslands();
  setLazyScheduler();
}

Deno.test("an event on a kept client:visible island hydrates it at once and reaches its handlers once", async () => {
  noTriggers();
  try {
    const { container, mismatches } = await hydrated(Form, Form, "visible");
    const { button } = formIn(container);
    fire(button, "click");
    assertEquals(log, [
      "page capture click",
      "island capture click",
      "island click",
      "page click",
    ]);
    assertEquals(mismatches, []);
  } finally {
    teardown();
  }
});

Deno.test("an on*Capture handler in a client:interaction island sees the event that woke it", async () => {
  noTriggers();
  try {
    const { container } = await hydrated(Form, Form, "interaction");
    const { button } = formIn(container);
    fire(button, "click");
    assertEquals(log, [
      "page capture click",
      "island capture click",
      "island click",
      "page click",
    ]);
  } finally {
    teardown();
  }
});

/** A stand-in whose chunk the test resolves. */
function chunk(component: unknown) {
  let land: () => void = () => {};
  const loaded = new Promise((r) => (land = () => r(component)));
  return { C: isoIslandChunk(() => loaded), land };
}

for (const strategy of ["visible", "interaction"]) {
  Deno.test(`a split client:${strategy} island holds events while its chunk loads, then replays them in order, once each`, async () => {
    noTriggers();
    const { C, land } = chunk(Form);
    try {
      const { container, mismatches } = await hydrated(Form, C, strategy);
      const { input, button } = formIn(container);
      fire(input, "keydown");
      fire(input, "input");
      fire(button, "click");
      fire(button, "click");
      assertEquals(log, [], "held: nothing above or in the island saw them yet");
      land();
      await tick();
      assertEquals(log, [
        "island keydown",
        "island input",
        "page capture click",
        "island capture click",
        "island click",
        "page click",
        "page capture click",
        "island capture click",
        "island click",
        "page click",
      ]);
      log = [];
      fire(button, "click");
      assertEquals(log.length, 4, "live: no longer held");
      assertEquals(mismatches, []);
    } finally {
      teardown();
    }
  });
}

Deno.test("a held click has its default action cancelled (the replay performs it)", async () => {
  noTriggers();
  const { C, land } = chunk(Form);
  try {
    const { container } = await hydrated(Form, C, "visible");
    const { button } = formIn(container);
    let prevented = false;
    fireEventOn(button, "click", {
      constructor: Evt,
      preventDefault: () => void (prevented = true),
    });
    assertEquals(prevented, true);
    land();
    await tick();
    assertEquals(log.includes("island click"), true);
  } finally {
    teardown();
  }
});

Deno.test("an event on an island nested in a kept island wakes both, and reaches the inner one", async () => {
  noTriggers();
  try {
    const { container, mismatches } = await hydrated(Outer, Outer, "visible");
    const { button } = formIn(container);
    fire(button, "click");
    assertEquals(log, [
      "page capture click",
      "inner capture click",
      "inner click",
      "outer click",
      "page click",
    ]);
    assertEquals(mismatches, []);
  } finally {
    teardown();
  }
});
