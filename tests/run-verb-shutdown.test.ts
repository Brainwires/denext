// The re-exec parent's shutdown forwarding: on Unix a shutdown signal is relayed to the child as
// SIGTERM; on Windows the console event already reached the child (one console), so the first
// one leaves it draining and only a second one stops it outright.

import { assertEquals } from "@std/assert";
import { shutdownForwarder } from "../src/cli/run-verb.ts";

function fakeChild() {
  const kills: (Deno.Signal | undefined)[] = [];
  return {
    kills,
    child: {
      kill(sig?: Deno.Signal) {
        kills.push(sig);
      },
    },
  };
}

Deno.test("shutdown forwarding: Unix relays every signal as SIGTERM", () => {
  const { kills, child } = fakeChild();
  const forward = shutdownForwarder(child, "linux");
  forward();
  forward();
  assertEquals(kills, ["SIGTERM", "SIGTERM"]);
});

Deno.test("shutdown forwarding: Windows leaves the first console event to the draining child", () => {
  const { kills, child } = fakeChild();
  const forward = shutdownForwarder(child, "windows");
  forward();
  assertEquals(kills, [], "the child got the same Ctrl-C and is draining: no TerminateProcess");
  forward();
  assertEquals(kills, [undefined], "a second event stops it outright");
});

Deno.test("shutdown forwarding: a child that already exited is ignored", () => {
  const forward = shutdownForwarder({
    kill() {
      throw new Deno.errors.NotFound("gone");
    },
  }, "darwin");
  forward(); // does not throw
});
