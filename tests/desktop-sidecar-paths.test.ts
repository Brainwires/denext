// Sidecars, the paths tests/desktop-sidecar.test.ts does not walk: every definition error, the
// supervisor's less common transitions (a probe, a throwing check or listener, a stop while
// launching, the real clock), the worker launcher's message protocol on a fake Worker, a program
// that ignores SIGTERM, the host's own launchers (a real worker and a real program, "auto" ports,
// log files and their rotation), and the registry the updater and `unload` reach.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  defineSidecar,
  type SidecarDefinition,
  sidecarDefinitionError,
  type SidecarExit,
} from "../src/desktop/sidecar.ts";
import {
  createSidecarSupervisor,
  type SidecarInstance,
  type SidecarLauncher,
} from "../src/desktop/sidecar-supervisor.ts";
import {
  execSidecarLauncher,
  resolveSidecarProgram,
  workerSidecarLauncher,
} from "../src/desktop/sidecar-launch.ts";
import { createSidecarHost } from "../src/desktop/sidecar-host.ts";
import {
  killSidecarsNow,
  registerSidecarStopper,
  stopSidecars,
} from "../src/desktop/sidecar-registry.ts";

/** Wait until `check` holds (real time, bounded). */
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A launcher whose runs end by hand (real clock). */
function manualLauncher() {
  const runs: Array<{ exit: (e: SidecarExit) => void; stops: number[] }> = [];
  const launch: SidecarLauncher = () => {
    let resolve!: (e: SidecarExit) => void;
    const exited = new Promise<SidecarExit>((r) => resolve = r);
    const stops: number[] = [];
    runs.push({ exit: resolve, stops });
    const inst: SidecarInstance = {
      exited,
      stop: (g) => {
        stops.push(g);
        resolve({ code: 0 });
        return exited.then(() => {});
      },
    };
    return Promise.resolve(inst);
  };
  return { launch, runs };
}

const base = (extra: Partial<SidecarDefinition> = {}): SidecarDefinition =>
  ({ name: "a", run: { module: "./a.ts" }, ...extra }) as SidecarDefinition;

// ── definitions ──────────────────────────────────────────────────────────────────────────────

Deno.test("sidecarDefinitionError: every field's problem is named", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [{ name: "a", run: "x" }, /run must be \{ module \} or \{ exec \}/],
    [{ name: "a", run: { exec: "" } }, /run.exec must be a program path/],
    [{ name: "a", run: { module: "" } }, /run.module must be a path/],
    [{ name: "a", run: { module: "x", other: 1 } }, /run.other is not an option/],
    [{ name: "a", run: { module: "x", nodeModules: "" } }, /run.nodeModules must be a folder/],
    [{ name: "a", run: { module: "x", nodeModules: "n", external: [1] } }, /run.external must/],
    [{ name: "a", run: { module: "x", nodeModules: "n", entries: "e" } }, /run.entries must/],
    [{ name: "a", run: { module: "x" }, args: [1] }, /args must be a string array/],
    [{ name: "a", run: { exec: "x" }, cwd: "" }, /cwd must be a folder path/],
    [{ name: "a", run: { module: "x" }, portEnv: "1A" }, /portEnv must be/],
    [{ name: "a", run: { module: "x" }, proxy: "yes" }, /proxy must be a boolean/],
    [{ name: "a", run: { module: "x" }, ready: 1 }, /ready must be an object/],
    [{ name: "a", run: { module: "x" }, ready: { foo: 1 } }, /ready.foo is not an option/],
    [{ name: "a", run: { module: "x" }, port: 1, ready: { http: "health" } }, /ready.http must/],
    [{ name: "a", run: { module: "x" }, ready: { stdout: 1 } }, /ready.stdout must be a regular/],
    [{ name: "a", run: { module: "x" }, ready: { signal: "y" } }, /ready.signal must be/],
    [{ name: "a", run: { module: "x" }, ready: { probe: 1 } }, /ready.probe must be a function/],
    [{ name: "a", run: { module: "x" }, ready: { timeoutMs: -1 } }, /ready.timeoutMs must be/],
    [{ name: "a", run: { module: "x" }, restart: 1 }, /restart must be an object/],
    [{ name: "a", run: { module: "x" }, restart: { x: 1 } }, /restart.x is not an option/],
    [{ name: "a", run: { module: "x" }, restart: { backoffMs: 1.5 } }, /restart.backoffMs/],
    [{ name: "a", run: { module: "x" }, shutdown: 1 }, /shutdown must be an object/],
    [{ name: "a", run: { module: "x" }, shutdown: { x: 1 } }, /shutdown.x is not an option/],
    [{ name: "a", run: { module: "x" }, shutdown: { graceMs: "1" } }, /shutdown.graceMs must/],
    [{ name: "a", run: { module: "x" }, env: [] }, /env must be an object of strings/],
    [{ name: "a", run: { module: "x" }, env: { A: 1 } }, /env.A must be a string/],
    [{ name: "a", run: { module: "x" }, secrets: 1 }, /secrets must be an object/],
    [{ name: "a", run: { module: "x" }, secrets: { T: 1 } }, /secrets.T must be a string/],
    [{ name: "a", run: { module: "x" }, expose: 1 }, /expose must be an object/],
    [{ name: "a", run: { module: "x" }, expose: { v: {} } }, /expose.v must be a string/],
    [{ name: "a", run: { module: "x" }, permissions: 1 }, /permissions must be an object/],
    [{ name: "a", run: { module: "x" }, permissions: { run: "git" } }, /permissions.run must/],
  ];
  for (const [value, re] of cases) assertMatch(String(sidecarDefinitionError(value)), re);
  // A computed `secrets` can't be checked against `expose`; scalars and null pass.
  assertEquals(
    sidecarDefinitionError({
      name: "a",
      run: { module: "x" },
      secrets: () => ({}),
      expose: { t: "$secret:ANY", n: 1, b: true, z: null },
    }),
    null,
  );
  const def = base({ port: 4000 });
  assert(defineSidecar(def) === def);
});

// ── supervisor ───────────────────────────────────────────────────────────────────────────────

Deno.test("supervisor (real clock): a probe that throws, then fails, then passes", async () => {
  const { launch } = manualLauncher();
  let calls = 0;
  const s = createSidecarSupervisor({
    definition: base({
      ready: {
        intervalMs: 5,
        probe: () => {
          calls++;
          if (calls === 1) throw new Error("not yet");
          return calls >= 3;
        },
      },
    }),
    launch,
  });
  s.start();
  assertEquals((await s.whenReady(5000)).state, "ready");
  assertEquals(calls, 3);
  s.start(); // already running: nothing happens
  await s.stop();
  await s.stop(); // a second stop is a no-op
  assertEquals(s.status.state, "stopped");
});

Deno.test("supervisor: an http check whose fetch throws keeps polling; an exit before ready restarts", async () => {
  const { launch, runs } = manualLauncher();
  const s = createSidecarSupervisor({
    definition: base({ port: 1, ready: { http: "/h", intervalMs: 5 }, restart: { backoffMs: 1 } }),
    launch,
    port: 1,
    fetch: () => Promise.reject(new Error("refused")),
  });
  const states: string[] = [];
  s.onStatus((st) => states.push(st.state));
  s.onStatus(() => {
    throw new Error("a listener that throws is reported, not fatal");
  });
  s.start();
  await until(() => runs.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  runs[0].exit({ code: 4 });
  await until(() => runs.length === 2);
  assert(states.includes("backoff"));
  assertEquals(s.status.state, "starting");
  await s.stop();
});

Deno.test("supervisor: a launcher that throws a non-Error, and a stop while it is launching", async () => {
  const s = createSidecarSupervisor({
    definition: base({ restart: { on: "never" } }),
    launch: () => Promise.reject("plain string"),
  });
  s.start();
  assertEquals((await s.whenReady(2000)).lastExit, { error: "plain string" });

  let release!: (i: SidecarInstance) => void;
  const stops: number[] = [];
  const late = createSidecarSupervisor({
    definition: base(),
    launch: () =>
      new Promise<SidecarInstance>((r) => {
        release = r;
      }),
  });
  late.start();
  await until(() => release !== undefined);
  await late.stop();
  assertEquals(late.status.state, "stopped");
  release({
    exited: Promise.resolve({ code: 0 }),
    stop: (g) => {
      stops.push(g);
      return Promise.resolve();
    },
  });
  await until(() => stops.length === 1);
  assertEquals(stops, [0], "the late instance is ended at once");
  late.start(); // from stopped
  await until(() => late.status.restarts === 1);
});

Deno.test("supervisor: whenReady sees a start through backoff to ready", async () => {
  const { launch, runs } = manualLauncher();
  const s = createSidecarSupervisor({
    definition: base({ ready: { signal: true }, restart: { backoffMs: 5 } }),
    launch,
  });
  s.start();
  await until(() => runs.length === 1);
  const waiting = s.whenReady(5000);
  runs[0].exit({ code: 1 });
  await until(() => runs.length === 2);
  // The second run never signals: whenReady settles at its own timeout with the live state.
  const st = await waiting;
  assert(st.state === "starting" || st.state === "backoff", st.state);
  await s.stop();
});

// ── worker launcher protocol ─────────────────────────────────────────────────────────────────

/** A stand-in Worker the test drives. */
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminated = 0;
  throwOnPost = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown) {
    if (this.throwOnPost) throw new Error("closed");
    this.posted.push(m);
  }
  terminate() {
    this.terminated++;
  }
  send(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

/** A worker launch on {@linkcode FakeWorker}. */
async function fakeLaunch(def: SidecarDefinition = base()) {
  const lines: string[] = [];
  let ready = 0;
  const inst = await workerSidecarLauncher({
    entry: "https://example.com/a.mjs",
    Worker: FakeWorker as unknown as typeof Worker,
  })({
    definition: def,
    bootstrap: null,
    secrets: {},
    onLine: (s, l) => lines.push(`${s}:${l}`),
    onReadySignal: () => ready++,
  });
  return { inst, worker: FakeWorker.last, lines, ready: () => ready };
}

Deno.test("worker launcher: lines, ready, exit without a code, and the init message", async () => {
  const { inst, worker, lines, ready } = await fakeLaunch(base({ portEnv: "APP_PORT" }));
  const init = worker.posted[0] as { path: string; env: Record<string, string>; t: string };
  assertEquals(init.t, "init");
  assertEquals(init.path, "https://example.com/a.mjs", "a non-file entry is its own path");
  worker.send({ t: "line", s: "stderr", l: "oops" });
  worker.send({ t: "line" });
  worker.send({ t: "ready" });
  worker.send({ t: "unknown" });
  worker.send({ t: "exit" });
  assertEquals(await inst.exited, { code: 0 });
  assertEquals(lines, ["stderr:oops", "stdout:"]);
  assertEquals(ready(), 1);
  await inst.stop(10); // already ended
  assertEquals(worker.terminated, 1);
});

Deno.test("worker launcher: an error event, an unreadable message, and a module error", async () => {
  const a = await fakeLaunch();
  let prevented = false;
  a.worker.onerror?.(
    { message: "", preventDefault: () => prevented = true } as unknown as ErrorEvent,
  );
  assertEquals(await a.inst.exited, { error: "uncaught error" });
  assert(prevented);
  const b = await fakeLaunch();
  b.worker.onmessageerror?.();
  assertMatch(String((await b.inst.exited).error), /could not be read/);
  const c = await fakeLaunch();
  c.worker.send({ t: "error", message: "SyntaxError" });
  assertEquals(await c.inst.exited, { error: "SyntaxError" });
});

Deno.test("worker launcher: stop waits for done, else ends at the grace; a closed worker ends at once", async () => {
  const a = await fakeLaunch();
  const stopping = a.inst.stop(5000);
  assertEquals(a.worker.posted.at(-1), { t: "shutdown" });
  a.worker.send({ t: "done" });
  await stopping;
  assertEquals(await a.inst.exited, { code: 0 });

  const b = await fakeLaunch();
  const t0 = Date.now();
  await b.inst.stop(30); // never answers
  assert(Date.now() - t0 >= 25);

  const c = await fakeLaunch();
  c.worker.throwOnPost = true;
  await c.inst.stop(5000);
  assertEquals(c.worker.terminated, 1);
});

// ── exec launcher ────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "exec launcher: a program that ignores SIGTERM is killed at the grace; output without a newline",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-term-" });
    try {
      const lines: string[] = [];
      const inst = await execSidecarLauncher({ program: "sh", cwd: join(dir, "work") })({
        definition: {
          name: "t",
          run: { exec: "sh" },
          args: ["-c", 'trap "" TERM; pwd; printf partial; sleep 30'],
        },
        bootstrap: undefined,
        secrets: {},
        onLine: (_s, l) => lines.push(l),
        onReadySignal: () => {},
      });
      await until(() => lines.length >= 1);
      await inst.stop(200);
      assertEquals((await inst.exited).signal, "SIGKILL");
      assertEquals(lines[0], join(dir, "work"));
      assertEquals(lines.at(-1), "partial");
      await inst.stop(10); // already gone
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("resolveSidecarProgram: the copy is reused while unchanged and replaced when it changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-copy-" });
  try {
    await Deno.mkdir(join(dir, "bin"));
    const src = join(dir, "bin", "srv");
    await Deno.writeTextFile(src, "one");
    const baseUrl = toFileUrl(join(dir, "desktop.ts")).href;
    const cache = join(dir, "cache");
    const target = await resolveSidecarProgram("./bin/srv", "s", baseUrl, cache, true);
    const first = (await Deno.stat(target)).mtime;
    await new Promise((r) => setTimeout(r, 20));
    await resolveSidecarProgram("./bin/srv", "s", baseUrl, cache, true);
    assertEquals((await Deno.stat(target)).mtime?.getTime(), first?.getTime(), "unchanged: kept");
    await Deno.writeTextFile(src, "two!");
    await resolveSidecarProgram("./bin/srv", "s", baseUrl, cache, true);
    assertEquals(await Deno.readTextFile(target), "two!");
    assertEquals(
      await resolveSidecarProgram("./bin/srv", "s", undefined, cache, true),
      "./bin/srv",
    );
    assertEquals(await resolveSidecarProgram("./bin/srv", "s", baseUrl, undefined, true), src);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── host with its own launchers ──────────────────────────────────────────────────────────────

Deno.test("host: a real worker on an auto port and a real program, logs to a rotated file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-host-" });
  try {
    await Deno.writeTextFile(
      join(dir, "server.mjs"),
      `import http from "node:http";
const s = http.createServer((q, r) => r.end("ok"));
s.listen(Number(process.env.PORT), "127.0.0.1", () => {
  for (let i = 0; i < 20; i++) console.log("line " + i + " " + "x".repeat(40));
  globalThis.denextSidecar.ready();
});
globalThis.denextSidecar.onShutdown(() => new Promise((r) => s.close(r)));
`,
    );
    const host = await createSidecarHost({
      sidecars: [
        {
          name: "api",
          run: { module: "./server.mjs" },
          port: "auto",
          ready: { signal: true },
          logs: "file",
          secrets: () => ({ K: "v" }),
          expose: { k: "$secret:K", missing: "$secret:NOPE" },
        },
        {
          name: "prog",
          run: { exec: Deno.execPath() },
          args: ["eval", "console.log('prog up'); await new Promise((r) => setTimeout(r, 60000));"],
          cwd: "work",
          logs: "both",
          ready: { stdout: "prog up" },
        },
      ],
      importMetaUrl: toFileUrl(join(dir, "desktop.ts")).href,
      dataDir: dir,
      logRotateBytes: 300,
    });
    host.startAll();
    const api = host.handle("api");
    assertEquals((await api.whenReady(15_000)).state, "ready");
    assertEquals((await host.handle("prog").whenReady(15_000)).state, "ready");
    assertEquals((await fetch(api.info.url!)).status, 200);
    assertEquals(api.info.values, { k: "v", missing: null });
    const log = join(dir, "logs", "sidecar-api.log");
    await until(async () =>
      (await Deno.stat(`${log}.1`).then(() => true, () => false)) &&
      (await Deno.readTextFile(log).then((t) => t.includes("line 19"), () => false))
    );
    assert((await Deno.stat(join(dir, "work"))).isDirectory, "a relative cwd is in the data dir");
    host.killAll();
    await host.stopAll();
    assertEquals(api.status.state, "stopped");
    let threw = false;
    try {
      host.handle("nope");
    } catch {
      threw = true;
    }
    assert(threw);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("host: a log file that cannot be written is reported, not fatal", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-log-" });
  try {
    await Deno.writeTextFile(join(dir, "logs"), "a file where the folder should be");
    let launched!: (s: "stdout" | "stderr", l: string) => void;
    const host = await createSidecarHost({
      sidecars: [{ name: "a", run: { module: "./a.ts" }, logs: "file" }],
      dataDir: dir,
      launcher: () => (ctx) => {
        launched = ctx.onLine;
        let end!: (e: SidecarExit) => void;
        const exited = new Promise<SidecarExit>((r) => end = r);
        return Promise.resolve({
          exited,
          stop: () => {
            end({ code: 0 });
            return Promise.resolve();
          },
        });
      },
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      host.startAll();
      await until(() => launched !== undefined);
      launched("stdout", "hello");
      await until(() => errors.some((e) => e.includes("cannot write")));
    } finally {
      console.error = orig;
    }
    await host.stopAll();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── registry ─────────────────────────────────────────────────────────────────────────────────

Deno.test("registry: kill and graceful stop reach every registered host; a failing one is skipped", async () => {
  const seen: string[] = [];
  const offA = registerSidecarStopper({
    kill: () => {
      throw new Error("kill failed");
    },
    stop: () => Promise.reject(new Error("stop failed")),
  });
  const offB = registerSidecarStopper({
    kill: () => seen.push("kill b"),
    stop: () => {
      seen.push("stop b");
      return Promise.resolve();
    },
  });
  try {
    killSidecarsNow();
    await stopSidecars();
    assertEquals(seen, ["kill b", "stop b"]);
  } finally {
    offA();
    offB();
  }
  killSidecarsNow();
  assertEquals(seen.length, 2, "unregistered hosts are not reached");
});
