// `installShutdown` (src/cli/shutdown.ts): the termination signals it traps abort the server's
// controller, and the uninstall it hands back stops trapping for a server that ended another way.
// Under the op sanitizer (on in deno.json) a listener left registered fails these tests: it keeps
// the event loop alive and swallows the next Ctrl-C.

import { assert, assertEquals } from "@std/assert";
import { installShutdown } from "../src/cli/shutdown.ts";

Deno.test("installShutdown: the returned uninstall removes every trapped signal's listener", () => {
  const controller = new AbortController();
  const uninstall = installShutdown(controller);
  uninstall();
  uninstall(); // twice is harmless
  assertEquals(controller.signal.aborted, false, "uninstalling never aborts the server");
});

Deno.test("installShutdown: the signal listener returns a promise that settles as the process ends", async () => {
  const added: Array<[Deno.Signal, () => unknown]> = [];
  const add = Deno.addSignalListener;
  const remove = Deno.removeSignalListener;
  Deno.addSignalListener = (sig: Deno.Signal, fn: () => void) => void added.push([sig, fn]);
  Deno.removeSignalListener = () => {};
  try {
    const controller = new AbortController();
    installShutdown(controller);
    assert(added.length > 0, "no signal trapped");
    const held = added[0][1]();
    assert(held instanceof Promise, "the listener returns its drain promise");
    assertEquals(controller.signal.aborted, true);
    let done = false;
    (held as Promise<void>).then(() => done = true);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(done, false, "held while the drain runs");
    globalThis.dispatchEvent(new Event("unload"));
    await held;
    assertEquals(done, true, "settled as the process ends");
  } finally {
    Deno.addSignalListener = add;
    Deno.removeSignalListener = remove;
  }
});
