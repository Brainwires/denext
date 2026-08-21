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

Deno.test("a plain handler resumes its island and the replayed event fires it", () => {
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
  assertEquals(ran, 1); // replayed event fired the resumed handler
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

Deno.test("resume is idempotent — a second event does not re-resume", () => {
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
  // Second time: the island is already hydrated (removed from pending) → no-op.
  assertEquals(resumeEvent(button, "click", event as any), "none");
  assertEquals(hydrations, 1);
});
