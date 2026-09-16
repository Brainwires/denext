// Stopping a `denext dev` the UI may not have started (`src/ui/dev-stop.ts`).
//
// The platform matrix is pure, so it is asserted directly rather than by spawning anything. The
// behavioural test that matters is the stale one: a `dev.json` left behind by a server that
// died must be CLEARED, never acted on, because the pid it names may since have been handed to
// an unrelated process.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { gracefulSignal, stopDevServer, treeKillCommand } from "../src/ui/dev-stop.ts";

Deno.test("dev-stop: Windows has no graceful signal, every other platform uses SIGTERM", () => {
  assertEquals(gracefulSignal("windows"), null);
  assertEquals(gracefulSignal("darwin"), "SIGTERM");
  assertEquals(gracefulSignal("linux"), "SIGTERM");
});

Deno.test("dev-stop: the tree kill is platform-branched, and never a shell string", () => {
  assertEquals(treeKillCommand(4321, "windows"), ["taskkill", "/PID", "4321", "/T", "/F"]);
  assertEquals(treeKillCommand(4321, "darwin"), ["pkill", "-KILL", "-P", "4321"]);
  assertEquals(treeKillCommand(4321, "linux"), ["pkill", "-KILL", "-P", "4321"]);
  // A platform with no known tree kill refuses honestly rather than inventing a command.
  assertEquals(treeKillCommand(4321, "android"), null);
  // Every argument is a separate array element, so a pid can never become a shell fragment.
  for (const argv of [treeKillCommand(7, "windows"), treeKillCommand(7, "linux")]) {
    for (const part of argv ?? []) assertEquals(typeof part, "string");
  }
});

Deno.test("dev-stop: no dev.json means nothing is running", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    assertEquals((await stopDevServer(dir)).status, "not-running");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-stop: a dev.json whose server is gone is cleared, and its pid never signalled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    // A port nothing listens on: bind one to learn a free number, then give it straight back.
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();

    await Deno.mkdir(join(dir, ".denext"), { recursive: true });
    const devJson = join(dir, ".denext", "dev.json");
    await Deno.writeTextFile(
      devJson,
      JSON.stringify({
        origin: `http://127.0.0.1:${port}`,
        port,
        hostname: "127.0.0.1",
        // A pid this test must never signal. Reaching a kill on the stale path — where the
        // origin does not answer — is the exact bug this asserts cannot happen.
        pid: 2147483646,
        startedAt: Date.now(),
      }),
    );

    assertEquals((await stopDevServer(dir)).status, "stale");
    assertEquals(await exists(devJson), false, "the stale dev.json must be cleared");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
