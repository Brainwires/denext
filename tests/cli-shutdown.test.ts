// `installShutdown` (src/cli/shutdown.ts): the termination signals it traps abort the server's
// controller, and the uninstall it hands back stops trapping for a server that ended another way.
// Under the op sanitizer (on in deno.json) a listener left registered fails these tests: it keeps
// the event loop alive and swallows the next Ctrl-C.

import { assertEquals } from "@std/assert";
import { installShutdown } from "../src/cli/shutdown.ts";

Deno.test("installShutdown: the returned uninstall removes every trapped signal's listener", () => {
  const controller = new AbortController();
  const uninstall = installShutdown(controller);
  uninstall();
  uninstall(); // twice is harmless
  assertEquals(controller.signal.aborted, false, "uninstalling never aborts the server");
});
