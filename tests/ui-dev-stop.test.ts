// Stopping a `denext dev` the UI may not have started (`src/ui/dev-stop.ts`).
//
// The platform matrix is pure, so it is asserted directly rather than by spawning anything. The
// behavioural tests drive the stop through its seams — a recording `kill`, a recording `run`, a
// scripted probe — so every signal that WOULD have been sent is observable, and the one hazard
// that matters is asserted from both sides: a `dev.json` whose pid is not the answering server's
// (stale, reused, planted, or the UI's own) is never signalled, and one that is gets the
// graceful signal, then the tree kill, in that order.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type DevIdentity,
  gracefulSignal,
  stopDevServer,
  type StopDevServerDeps,
  treeKillCommand,
} from "../src/ui/dev-stop.ts";

/** A pid this suite must never signal for real; every kill goes through the recorder. */
const PID = 2147483646;

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
  // The real probe against a port nothing listens on: the one path that needs no seam.
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const devJson = await publish(dir, { origin: `http://127.0.0.1:${port}`, port, pid: PID });
    const rec = recorder();

    assertEquals((await stopDevServer(dir, rec.deps)).status, "stale");
    assertEquals(await exists(devJson), false, "the stale dev.json must be cleared");
    assertEquals(rec.kills, [], "a pid nothing answers for is never signalled");
    assertEquals(rec.runs, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-stop: a dev.json naming -1, 0, 1, a float or a string is not a dev server at all", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    for (const pid of [-1, 0, 1, 1.5, "123", 2 ** 53, undefined]) {
      const devJson = await publish(dir, { origin: "http://127.0.0.1:3000", port: 3000, pid });
      const rec = recorder({ probe: () => Promise.resolve({ pid, projectDir: dir }) });
      const outcome = await stopDevServer(dir, rec.deps);
      assertEquals(outcome.status, "not-running", `pid ${String(pid)}`);
      assertEquals(rec.kills, [], `pid ${String(pid)} must never be signalled`);
      assertEquals(rec.runs, [], `no tree kill for pid ${String(pid)}`);
      assertEquals(rec.probes, 0, "the origin is not even probed");
      assert(await exists(devJson), "a planted file is left where it is");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-stop: a dev.json naming this process or its parent is refused, not signalled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    for (const pid of [Deno.pid, Deno.ppid]) {
      if (pid <= 1) continue; // a parent of 1 (a container's init) is refused by readDevInfo
      const devJson = await publish(dir, { origin: "http://127.0.0.1:3000", port: 3000, pid });
      // Even a probe that swears the server IS this pid changes nothing.
      const rec = recorder({ probe: () => Promise.resolve({ pid, projectDir: dir }) });
      const outcome = await stopDevServer(dir, rec.deps);
      assertEquals(outcome.status, "mismatch");
      assert(outcome.message.includes("not stopping"), outcome.message);
      assertEquals(rec.kills, [], `pid ${pid} is ours and must never be signalled`);
      assertEquals(rec.runs, []);
      assert(await exists(devJson), "the file is not the stop's to remove");
    }
    // The default `self` is exactly this process and its parent — a foreign pid is not refused
    // on that ground (it goes on to the probe, which here says nothing answers).
    await publish(dir, { origin: "http://127.0.0.1:3000", port: 3000, pid: PID });
    const gone = recorder({ probe: () => Promise.resolve(null) });
    assertEquals((await stopDevServer(dir, gone.deps)).status, "stale");
    assertEquals(gone.probes, 1, "a foreign pid reaches the probe");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-stop: a server that answers with another pid or project is not stopped, and dev.json is kept", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  const other = await Deno.makeTempDir({ prefix: "denext_dev_stop_other_" });
  try {
    const answers: DevIdentity[] = [
      { pid: PID - 1, projectDir: dir }, // pid reuse: the port is a new server's, the pid is not
      { pid: PID, projectDir: other }, // same pid, another project — not this project's server
      { pid: undefined, projectDir: undefined }, // a 200 with no identity (not denext at all)
      { pid: String(PID), projectDir: dir }, // a lookalike; the pid must be the number itself
    ];
    for (const identity of answers) {
      const devJson = await publish(dir, { origin: "http://127.0.0.1:3000", port: 3000, pid: PID });
      const rec = recorder({ probe: () => Promise.resolve(identity) });
      const outcome = await stopDevServer(dir, rec.deps);
      assertEquals(outcome.status, "mismatch", JSON.stringify(identity));
      assert(outcome.message.includes("different dev server"), outcome.message);
      assert(outcome.message.includes("not stopping"), outcome.message);
      assertEquals(rec.kills, [], `nothing is signalled for ${JSON.stringify(identity)}`);
      assertEquals(rec.runs, []);
      assert(await exists(devJson), "a mismatch never clears the file");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(other, { recursive: true });
  }
});

Deno.test("dev-stop: the graceful path — SIGTERM to the matching pid, and nothing more once it drains", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    const devJson = await publish(dir, { origin: "http://127.0.0.1:3000", port: 3000, pid: PID });
    // The server answers as itself until the graceful signal lands, then drains (and, as the
    // real one does on drain, removes its own dev.json).
    const rec = recorder({
      probe: async () => {
        if (rec.kills.length === 0) return { pid: PID, projectDir: dir };
        await Deno.remove(devJson).catch(() => {});
        return null;
      },
    });
    const outcome = await stopDevServer(dir, rec.deps);
    assertEquals(outcome.status, "stopped");
    assertEquals(rec.kills, [[PID, "SIGTERM"]], "one graceful signal, to the file's pid, only");
    assertEquals(rec.runs, [], "the tree kill is a fallback, not a first resort");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-stop: the hard path — the tree kill then SIGKILL when SIGTERM does not drain it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    const devJson = await publish(dir, { origin: "http://127.0.0.1:3000", port: 3000, pid: PID });
    // Ignores SIGTERM; goes only once the tree kill has run.
    const rec = recorder({
      probe: () => Promise.resolve(rec.runs.length === 0 ? { pid: PID, projectDir: dir } : null),
      os: "linux",
    });
    const outcome = await stopDevServer(dir, rec.deps);
    assertEquals(outcome.status, "stopped");
    assertEquals(rec.kills, [[PID, "SIGTERM"], [PID, "SIGKILL"]], "graceful first, then hard");
    assertEquals(rec.runs, [["pkill", "-KILL", "-P", String(PID)]]);
    assertEquals(await exists(devJson), false, "a killed server never cleaned up; the stop does");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-stop: Windows goes straight to taskkill and says so", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  try {
    await publish(dir, { origin: "http://127.0.0.1:3000", port: 3000, pid: PID });
    const rec = recorder({
      probe: () => Promise.resolve(rec.runs.length === 0 ? { pid: PID, projectDir: dir } : null),
      os: "windows",
    });
    const outcome = await stopDevServer(dir, rec.deps);
    assertEquals(outcome.status, "stopped");
    assert(outcome.message.includes("killed"), outcome.message);
    assertEquals(rec.runs, [["taskkill", "/PID", String(PID), "/T", "/F"]]);
    assertEquals(rec.kills, [[PID, "SIGKILL"]], "no SIGTERM exists to try first");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-stop: the real probe reads the identity a dev-state endpoint publishes", async () => {
  // A stand-in dev server: answers `/_denext/dev-state` the way the real one does. Its pid is
  // the file's, its project is this one — so the stop proceeds to signal (through the
  // recorder). It ignores every signal, so the outcome is an honest "failed" and dev.json stays.
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_stop_" });
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const srv = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => resolve(port) },
    (req) =>
      new URL(req.url).pathname === "/_denext/dev-state"
        ? Response.json({ events: [], total: 0, pid: PID, projectDir: dir })
        : new Response("not found", { status: 404 }),
  );
  const port = await promise;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const devJson = await publish(dir, { origin, port, pid: PID });
    const rec = recorder({ graceMs: 200, os: "linux" });
    const outcome = await stopDevServer(dir, rec.deps);
    assertEquals(outcome.status, "failed");
    assertEquals(rec.kills, [[PID, "SIGTERM"], [PID, "SIGKILL"]]);
    assertEquals(rec.runs, [["pkill", "-KILL", "-P", String(PID)]]);
    assert(await exists(devJson), "a server still answering keeps its file");

    // The same server, a different pid in the file: pid reuse — nothing is signalled.
    await publish(dir, { origin, port, pid: PID - 1 });
    const reused = recorder({ graceMs: 200, os: "linux" });
    assertEquals((await stopDevServer(dir, reused.deps)).status, "mismatch");
    assertEquals(reused.kills, []);
    assertEquals(reused.runs, []);
  } finally {
    ac.abort();
    await srv.finished;
    await Deno.remove(dir, { recursive: true });
  }
});

/** The seams, with every signal and helper run recorded instead of delivered. */
function recorder(
  overrides: Partial<StopDevServerDeps> = {},
): {
  deps: StopDevServerDeps;
  kills: [number, Deno.Signal][];
  runs: string[][];
  probes: number;
} {
  const rec = {
    kills: [] as [number, Deno.Signal][],
    runs: [] as string[][],
    probes: 0,
    deps: {} as StopDevServerDeps,
  };
  // No stub means the module's real probe (the network one); a stub is counted.
  const probe = overrides.probe;
  rec.deps = {
    graceMs: 50,
    ...overrides,
    probe: probe === undefined ? undefined : (info) => {
      rec.probes++;
      return probe(info);
    },
    kill: (pid, signal) => {
      rec.kills.push([pid, signal]);
    },
    run: (argv) => {
      rec.runs.push(argv);
      return Promise.resolve();
    },
  };
  return rec;
}

/** Write `<dir>/.denext/dev.json` (the fields a dev server publishes, plus the given ones). */
async function publish(
  dir: string,
  info: { origin: string; port: number; pid: unknown },
): Promise<string> {
  await Deno.mkdir(join(dir, ".denext"), { recursive: true });
  const path = join(dir, ".denext", "dev.json");
  await Deno.writeTextFile(
    path,
    JSON.stringify({ hostname: "127.0.0.1", startedAt: Date.now(), ...info }),
  );
  return path;
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
