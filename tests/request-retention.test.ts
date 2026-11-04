// Regression: a finished request must be collectable. The streaming renderers installed their hook
// dispatcher in the process-global slot and never took it out, so the last streamed render's
// renderer (and through its closures the page request, its state and the visitor's `Request`)
// stayed alive until the next render replaced it. The probe serves a request mix through
// examples/hello in a child process with --expose-gc and reports what survives a forced GC; the
// count must not depend on how many requests were served.

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const PROBE = fromFileUrl(new URL("./fixtures/request-retention/probe.ts", import.meta.url));
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

interface ProbeResult {
  served: number;
  requestsAlive: string[];
  responsesAlive: string[];
  statuses: number[];
}

async function runProbe(rounds: number): Promise<ProbeResult> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, "--v8-flags=--expose-gc", PROBE, String(rounds)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(stdout.split("\n").pop()!);
}

Deno.test("no finished request or response stays reachable, however many were served", async () => {
  for (const rounds of [10, 60]) {
    const r = await runProbe(rounds);
    assertEquals(r.served, rounds);
    assertEquals(r.statuses, [200, 404], "the mix served pages, a route handler and a 404");
    assertEquals(r.requestsAlive, [], `${rounds} requests: requests still reachable`);
    assertEquals(r.responsesAlive, [], `${rounds} requests: responses still reachable`);
  }
});
