// Regression: an unmounted component's state must be collectable. Three retention paths kept
// it alive after its subtree was deleted:
//   - the previous buffer of the parent (`parent.alternate`) still listed the deleted child
//     until the parent rendered again;
//   - only the deleted fiber was severed, not its alternate, whose `child` / `return` / hook
//     cells led back into the old subtree;
//   - the scheduler kept the last fiber that scheduled an update (for an error message).
// The probe runs in a child process with --expose-gc and reports what survives a forced GC.

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const PROBE = fromFileUrl(new URL("./fixtures/fiber-retention/probe.ts", import.meta.url));
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

interface ScenarioResult {
  name: string;
  payloads: number;
  alive: number;
  tags: string[];
}

async function runProbe(): Promise<ScenarioResult[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, "--v8-flags=--expose-gc", PROBE],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(stdout.split("\n").pop()!);
}

Deno.test("unmounted components' hook state is collectable", async () => {
  const results = await runProbe();
  assertEquals(results.map((r) => r.name), [
    "mount-unmount",
    "kept-detached-node",
    "setstate-then-unmount",
  ]);
  for (const r of results) {
    assertEquals(r.payloads, 15, `${r.name}: every round mounted three holders`);
    assertEquals(r.tags, [], `${r.name}: state of unmounted components still reachable`);
  }
});
