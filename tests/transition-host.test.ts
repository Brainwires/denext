// The transition engine (src/runtime/hooks/transition.ts) drives the client scheduler through the
// controls it installs (`TransitionHost`), not an import, so the engine ships only with the
// transition hooks. These tests drive it against a recording host; the real scheduler's behaviour
// is covered by the transition / async-transition suites.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { getTransitionHost, setTransitionHost, type TransitionHost } from "../src/runtime/hooks.ts";
import { startTransition } from "../src/runtime/hooks/transition.ts";

/** A host that records what the engine asked of it. */
function recordingHost(
  pending = false,
): TransitionHost & { log: string[]; flushed: Array<() => void> } {
  const log: string[] = [];
  const flushed: Array<() => void> = [];
  let depth = 0;
  return {
    log,
    flushed,
    begin: () => void (depth++, log.push("begin")),
    end: () => void (depth--, log.push("end")),
    scope: () => null,
    beginAsync: () => {
      log.push("beginAsync");
      return () => log.push("disarm");
    },
    endAsync: () => void log.push("endAsync"),
    active: () => depth > 0,
    inFlight: () => pending,
    pending: () => pending,
    flush: () => void log.push("flush"),
    whenFlushed: (cb) => void flushed.push(cb),
  };
}

/** Run `body` with `host` installed, restoring the previous host after. */
async function withHost(host: TransitionHost | null, body: () => Promise<void> | void) {
  const previous = getTransitionHost();
  setTransitionHost(host);
  try {
    await body();
  } finally {
    setTransitionHost(previous);
  }
}

Deno.test("startTransition with no scheduler installed runs the callback at once", async () => {
  await withHost(null, () => {
    let ran = false;
    startTransition(() => {
      ran = true;
    });
    assert(ran);
  });
});

Deno.test("a synchronous transition enters and leaves the transition lane", async () => {
  const host = recordingHost();
  await withHost(host, async () => {
    let inside = false;
    startTransition(() => {
      inside = host.active();
    });
    assert(inside, "the callback runs inside the transition");
    assertEquals(host.log, ["begin", "end"]);
    await Promise.resolve(); // nothing in flight: completion is a microtask
  });
});

Deno.test("an in-flight transition defers completion until the flush lands", async () => {
  const host = recordingHost(true);
  await withHost(host, () => {
    startTransition(() => {});
    assertEquals(host.flushed.length, 1, "completion waits for the transition flush");
  });
});

Deno.test("an async transition holds the window until its promise settles", async () => {
  const host = recordingHost(true);
  await withHost(host, async () => {
    let resolve!: () => void;
    startTransition((() => new Promise<void>((r) => (resolve = r))) as unknown as () => void);
    assertEquals(host.log, ["begin", "end", "beginAsync"]);
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(host.log, ["begin", "end", "beginAsync", "endAsync", "disarm", "flush"]);
    assertEquals(host.flushed.length, 1);
  });
});

Deno.test("a throwing transition still completes and rethrows", async () => {
  const host = recordingHost(true);
  await withHost(host, () => {
    assertThrows(
      () =>
        startTransition(() => {
          throw new Error("boom");
        }),
      Error,
      "boom",
    );
    assertEquals(host.log, ["begin", "flush", "end"]);
    assertEquals(host.flushed.length, 1, "isPending still clears");
  });
});
