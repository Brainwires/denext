// Client resume-and-replay: a delegated event on a plain handler inside a pending
// interaction island resumes the island (sync) and replays the event so the
// just-attached real handler fires — the first interaction is not lost.

// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
import { registerLazyIsland, resetLazyIslands } from "../src/client/lazy-hydrate.ts";
import { resumeEvent } from "../src/client/qrl-dispatch.ts";
import { qrl } from "../src/runtime/qrl.ts";

/** A minimal DOM node that records a re-dispatched event to its handler. */
function node(attr: string | null, parent: any = null): any {
  return {
    nodeType: 1,
    parentNode: parent,
    _handler: null as ((e: unknown) => void) | null,
    getAttribute: (n: string) => (n === "data-dnx-h" ? attr : null),
    dispatchEvent(e: unknown) {
      this._handler?.(e);
      return true;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("a plain handler resumes its island and the replayed event fires it", async () => {
  resetLazyIslands();
  const container = node("click"); // the island root also carries the marker
  const button = node("click", container);
  let ran = 0;

  // The island's hydrate wires the real handler (as the reconciler would on resume).
  registerLazyIsland({
    container,
    strategy: "interaction",
    hydrate: () => {
      button._handler = () => ran++;
    },
  });

  const event = { type: "click", target: button, constructor: Object };
  assertEquals(resumeEvent(button, "click", event as any), "resumed");
  // The replay is deferred until hydration settles (a microtask even for a sync hydrate),
  // so the handler is guaranteed attached before it fires — never a synchronous race.
  await tick();
  assertEquals(ran, 1); // replayed event fired the resumed handler
});

Deno.test("async hydration: the intent event replays AFTER the handler attaches", async () => {
  // The real bug this guards: island hydration is async (it imports the island's chunk
  // before `hydrateRoot`), but a browser click arrives as pointerdown → click. pointerdown
  // triggers the resume; the click — carrying the intent — must be buffered and replayed
  // after hydration, or it fires against a not-yet-attached handler and is silently dropped.
  resetLazyIslands();
  const container = node("click");
  const button = node("click", container);
  let clicks = 0;
  let finishHydration!: () => void;
  const gate = new Promise<void>((r) => (finishHydration = r));

  registerLazyIsland({
    container,
    strategy: "interaction",
    hydrate: async () => {
      await gate; // stand in for `await ensureFlightModules(...)` before hydrateRoot
      button._handler = (e: any) => {
        if (e.type === "click") clicks++;
      };
    },
  });

  // A constructible event whose replay preserves its `type` (the real MouseEvent does;
  // the plain-object mock used elsewhere here does not, which is fine for a type-agnostic
  // handler but not for asserting WHICH event replayed).
  class Evt {
    type: string;
    target: any;
    constructor(type: string, init: any = {}) {
      this.type = type;
      this.target = init.target ?? null;
    }
  }
  const pd = new Evt("pointerdown", { target: button });
  const clk = new Evt("click", { target: button });
  // pointerdown resumes; click (handler not attached yet) must buffer, not drop.
  assertEquals(resumeEvent(button, "pointerdown", pd as any), "resumed");
  assertEquals(resumeEvent(button, "click", clk as any), "resumed");
  await tick();
  assertEquals(clicks, 0); // nothing fired — hydration still pending

  finishHydration();
  await tick();
  assertEquals(clicks, 1); // the buffered click replayed exactly once to the live handler
});

Deno.test("a qrl handler dispatches without resuming any island", async () => {
  resetLazyIslands();
  let ran = 0;
  qrl(() => Promise.resolve(() => ran++), "r#go");
  const button = node("click:r#go");
  const event = { type: "click", target: button, constructor: Object };
  assertEquals(resumeEvent(button, "click", event as any), "qrl");
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(ran, 1);
});

Deno.test("an event outside any island or handler is a no-op", () => {
  resetLazyIslands();
  const stray = node(null);
  const event = { type: "click", target: stray, constructor: Object };
  assertEquals(resumeEvent(stray, "click", event as any), "none");
});

Deno.test("resume is idempotent — a later event does not re-resume", async () => {
  resetLazyIslands();
  const container = node("click");
  const button = node("click", container);
  let hydrations = 0;
  registerLazyIsland({
    container,
    strategy: "interaction",
    hydrate: () => {
      hydrations++;
      button._handler = () => {};
    },
  });
  const event = { type: "click", target: button, constructor: Object };
  assertEquals(resumeEvent(button, "click", event as any), "resumed");
  await tick(); // let the resume settle and the in-flight `resuming` entry clear
  // A later event (after the resume window): island hydrated, nothing pending → no-op.
  assertEquals(resumeEvent(button, "click", event as any), "none");
  assertEquals(hydrations, 1);
});
