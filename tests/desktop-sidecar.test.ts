// Deno Desktop sidecars (src/desktop/sidecar*.ts): the definition checks, the supervisor's state
// machine on a fake launcher and clock (ready, crash → backoff restart, maxAttempts, reset after a
// good run, ready timeout, shutdown grace, manual restart), the host's bridge capability, and the
// two real launchers (a worker in this runtime, a spawned program), including orphan safety.

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  mergeSidecars,
  type SidecarDefinition,
  sidecarDefinitionError,
  sidecarListError,
  sidecarModulePath,
  type SidecarStatus,
} from "../src/desktop/sidecar.ts";
import {
  createSidecarSupervisor,
  sidecarBackoffDelay,
  type SidecarClock,
  type SidecarInstance,
  type SidecarLaunchContext,
  type SidecarLauncher,
  type SidecarTimer,
} from "../src/desktop/sidecar-supervisor.ts";
import { createSidecarHost } from "../src/desktop/sidecar-host.ts";
import {
  execSidecarEnv,
  execSidecarLauncher,
  killExecSidecars,
  resolveSidecarProgram,
  sidecarArgs,
  workerSidecarLauncher,
} from "../src/desktop/sidecar-launch.ts";
import type { SidecarExit } from "../src/desktop/sidecar.ts";

// ── fakes ────────────────────────────────────────────────────────────────────────────────────

/** Let pending promise callbacks and zero-delay real timers run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A clock that only moves when told to. */
function fakeClock() {
  let now = 1_000_000;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: SidecarClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++next, { at: now + ms, fn });
      return next as unknown as SidecarTimer;
    },
    clearTimeout: (id) => void timers.delete(id as unknown as number),
  };
  return {
    clock,
    pending: () => timers.size,
    /** Move time forward, firing due timers in order and letting their work settle. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await settle();
        const due = [...timers.entries()].filter(([, t]) =>
          t.at <= end
        ).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      await settle();
    },
  };
}

/** One run the fake launcher started. */
interface FakeRun {
  readonly ctx: SidecarLaunchContext;
  /** End the run as the sidecar would. */
  exit(exit: SidecarExit): void;
  /** The grace periods `stop` was called with. */
  readonly stops: number[];
}

/** A launcher whose runs the test ends by hand; `stubborn` runs ignore `stop` until killed. */
function fakeLauncher(opts: { failStart?: boolean; stubborn?: boolean } = {}) {
  const runs: FakeRun[] = [];
  const launch: SidecarLauncher = (ctx) => {
    if (opts.failStart) return Promise.reject(new Error("spawn failed"));
    let resolve!: (e: SidecarExit) => void;
    const exited = new Promise<SidecarExit>((r) => resolve = r);
    let done = false;
    const exit = (e: SidecarExit) => {
      if (!done) {
        done = true;
        resolve(e);
      }
    };
    const stops: number[] = [];
    const instance: SidecarInstance = {
      pid: 4000 + runs.length,
      exited,
      stop: (grace) => {
        stops.push(grace);
        if (!opts.stubborn) exit({ code: 0 });
        return exited.then(() => {});
      },
    };
    runs.push({ ctx, exit, stops });
    return Promise.resolve(instance);
  };
  return { launch, runs };
}

/** A definition with test defaults. */
function def(extra: Partial<SidecarDefinition> = {}): SidecarDefinition {
  return { name: "api", run: { module: "./server.ts" }, ...extra } as SidecarDefinition;
}

/** Record every state the supervisor goes through. */
function states(s: { onStatus(l: (st: SidecarStatus) => void): () => void }): string[] {
  const seen: string[] = [];
  s.onStatus((st) => seen.push(st.state));
  return seen;
}

// ── definitions ──────────────────────────────────────────────────────────────────────────────

Deno.test("sidecarDefinitionError: accepts the documented shapes", () => {
  assertEquals(sidecarDefinitionError(def()), null);
  assertEquals(
    sidecarDefinitionError({
      name: "server",
      run: { module: "apps/server/dist/bin.mjs", nodeModules: "apps/server/node_modules" },
      args: ["--port", "{port}"],
      env: { T3CODE_HOME: "/tmp/x" },
      port: "auto",
      secrets: { TOKEN: "$random" },
      expose: { token: "$secret:TOKEN", mode: "desktop" },
      ready: { http: "/health", timeoutMs: 20_000 },
      restart: { on: "crash", backoffMs: 100, maxAttempts: 3, resetAfterMs: 1000 },
      shutdown: { graceMs: 2000 },
      logs: "both",
      proxy: true,
      permissions: { ffi: ["*"], run: ["git"] },
    }),
    null,
  );
  assertEquals(
    sidecarDefinitionError({ name: "go", run: { exec: "./bin/server" }, cwd: "w" }),
    null,
  );
});

Deno.test("sidecarDefinitionError: names the bad field", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ name: "API", run: { module: "x" } }, /^name /],
    [{ name: "a", run: {} }, /exactly one of module and exec/],
    [{ name: "a", run: { module: "x", exec: "y" } }, /exactly one/],
    [{ name: "a", run: { module: "x", external: ["p"] } }, /need run.nodeModules/],
    [{ name: "a", run: { exec: "x", nodeModules: "n" } }, /not an option of an exec sidecar/],
    [{ name: "a", run: { module: "x" }, cwd: "w" }, /cwd applies to an exec sidecar/],
    [{ name: "a", run: { module: "x" }, ready: { http: "/h" } }, /ready.http needs a port/],
    [{ name: "a", run: { module: "x" }, ready: { stdout: "(" } }, /not a valid regular/],
    [{ name: "a", run: { module: "x" }, port: 70000 }, /port must be/],
    [{ name: "a", run: { module: "x" }, proxy: true }, /proxy needs a port/],
    [{ name: "a", run: { module: "x" }, restart: { on: "sometimes" } }, /restart.on/],
    [{ name: "a", run: { module: "x" }, restart: { maxAttempts: 0 } }, /maxAttempts/],
    [{ name: "a", run: { module: "x" }, logs: "loud" }, /logs must be/],
    [{ name: "a", run: { module: "x" }, env: { "1X": "v" } }, /not a variable name/],
    [{ name: "a", run: { module: "x" }, expose: { t: "$secret:NOPE" } }, /not in secrets/],
    [{ name: "a", run: { module: "x" }, permissions: { root: ["*"] } }, /not a permission kind/],
    [{ name: "a", run: { module: "x" }, colour: "red" }, /colour is not a sidecar option/],
  ];
  for (const [value, re] of cases) assertMatch(String(sidecarDefinitionError(value)), re);
});

Deno.test("sidecarListError: unique names, one proxy", () => {
  assertEquals(sidecarListError([def(), def({ name: "b" })]), null);
  assertMatch(String(sidecarListError([def(), def()])), /^\[1\] name "api" is used twice/);
  assertMatch(
    String(sidecarListError([
      def({ port: "auto", proxy: true }),
      def({ name: "b", port: 4000, proxy: true }),
    ])),
    /only one sidecar may set proxy/,
  );
  assertMatch(String(sidecarListError({})), /must be an array/);
});

Deno.test("mergeSidecars: code fields replace the config's by name, new names are added", () => {
  const probe = () => true;
  const merged = mergeSidecars(
    [def({ port: "auto", ready: { http: "/health" } })],
    [{ name: "api", run: { module: "./server.ts" }, ready: { probe } }, def({ name: "b" })],
  );
  assertEquals(merged.map((d) => d.name), ["api", "b"]);
  assertEquals(merged[0].port, "auto");
  assertEquals(merged[0].ready, { probe });
});

Deno.test("sidecarModulePath: a Node backend runs from its bundle, a module as written", () => {
  assertEquals(
    sidecarModulePath(def({ run: { module: "dist/bin.mjs", nodeModules: "node_modules" } })),
    "./.deno-desktop/sidecars/api/main.mjs",
  );
  assertEquals(sidecarModulePath(def({ run: { module: "server/main.ts" } })), "./server/main.ts");
  assertEquals(sidecarModulePath(def({ run: { module: "jsr:@x/y" } })), "jsr:@x/y");
});

Deno.test("sidecarArgs / execSidecarEnv: {port} substituted, the runtime's variables dropped", () => {
  assertEquals(sidecarArgs(["--port", "{port}", "x{port}"], 4100), ["--port", "4100", "x4100"]);
  assertEquals(sidecarArgs(["{port}"]), ["{port}"]);
  assertEquals(
    execSidecarEnv(
      {
        PATH: "/bin",
        DENO_SERVE_ADDRESS: "memory:deno-desktop",
        DENO_DESKTOP_WS_URL: "ws://127.0.0.1:1/.relay/tok",
        DENO_DESKTOP_APP_ORIGIN: "app://localhost",
      },
      { PORT: "4100" },
    ),
    { PATH: "/bin", PORT: "4100" },
  );
});

// ── supervisor ───────────────────────────────────────────────────────────────────────────────

Deno.test("supervisor: without ready checks it is ready once started", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const s = createSidecarSupervisor({ definition: def(), launch, clock, port: 4100 });
  const seen = states(s);
  s.start();
  await advance(0);
  assertEquals(s.status.state, "ready");
  assertEquals(s.status.port, 4100);
  assertEquals(s.status.pid, 4000);
  assertEquals(seen, ["starting", "starting", "ready"]);
  assertEquals(runs[0].ctx.port, 4100);
});

Deno.test("supervisor: ready.http polls the port until 2xx", async () => {
  const { clock, advance } = fakeClock();
  const { launch } = fakeLauncher();
  const urls: string[] = [];
  let up = false;
  const fetchFn = ((url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(null, { status: up ? 204 : 503 }));
  }) as unknown as typeof fetch;
  const s = createSidecarSupervisor({
    definition: def({ port: 4100, ready: { http: "/health", intervalMs: 50 } }),
    launch,
    clock,
    port: 4100,
    fetch: fetchFn,
  });
  s.start();
  await advance(120);
  assertEquals(s.status.state, "starting");
  up = true;
  await advance(60);
  assertEquals(s.status.state, "ready");
  assertEquals(urls[0], "http://127.0.0.1:4100/health");
  assert(urls.length >= 3);
});

Deno.test("supervisor: ready.stdout and ready.signal must both pass", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const lines: string[] = [];
  const s = createSidecarSupervisor({
    definition: def({ ready: { stdout: "listening on \\d+", signal: true } }),
    launch,
    clock,
    onLine: (_s, l) => lines.push(l),
  });
  s.start();
  await advance(0);
  runs[0].ctx.onLine("stdout", "booting");
  runs[0].ctx.onLine("stdout", "listening on 4100");
  await advance(0);
  assertEquals(s.status.state, "starting");
  runs[0].ctx.onReadySignal();
  await advance(0);
  assertEquals(s.status.state, "ready");
  assertEquals(lines, ["booting", "listening on 4100"]);
});

Deno.test("supervisor: a crash restarts with doubling backoff, then gives up after maxAttempts", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const s = createSidecarSupervisor({
    definition: def({ restart: { backoffMs: 100, maxBackoffMs: 250, maxAttempts: 3 } }),
    launch,
    clock,
  });
  s.start();
  await advance(0);
  assertEquals(s.status.state, "ready");
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    runs[runs.length - 1].exit({ error: "boom" });
    await advance(0);
    assertEquals(s.status.state, "backoff");
    assertEquals(s.status.attempts, i + 1);
    delays.push(s.status.retryAt! - clock.now());
    assertEquals(s.status.lastExit, { error: "boom" });
    await advance(delays[i]);
    assertEquals(s.status.state, "ready");
  }
  assertEquals(delays, [100, 200, 250]);
  assertEquals(s.status.restarts, 3);
  runs[runs.length - 1].exit({ code: 1 });
  await advance(0);
  assertEquals(s.status.state, "failed");
  assertEquals(s.status.attempts, 4);
  assertEquals(runs.length, 4);
});

Deno.test("supervisor: a run that stays ready resetAfterMs resets the attempt count", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const s = createSidecarSupervisor({
    definition: def({ restart: { backoffMs: 10, maxAttempts: 2, resetAfterMs: 1000 } }),
    launch,
    clock,
  });
  s.start();
  await advance(0);
  for (let i = 0; i < 5; i++) {
    await advance(1000); // a good run
    assertEquals(s.status.attempts, 0);
    runs[runs.length - 1].exit({ code: 2 });
    await advance(0);
    assertEquals(s.status.attempts, 1);
    await advance(10);
    assertEquals(s.status.state, "ready");
  }
  assertEquals(runs.length, 6);
});

Deno.test("supervisor: restart.on decides what a clean exit and a crash do", async () => {
  for (
    const [on, exit, expected] of [
      ["crash", { code: 0 }, "stopped"],
      ["crash", { code: 3 }, "backoff"],
      ["crash", { signal: "SIGKILL" }, "backoff"],
      ["always", { code: 0 }, "backoff"],
      ["never", { code: 0 }, "stopped"],
      ["never", { error: "x" }, "failed"],
    ] as const
  ) {
    const { clock, advance } = fakeClock();
    const { launch, runs } = fakeLauncher();
    const s = createSidecarSupervisor({ definition: def({ restart: { on } }), launch, clock });
    s.start();
    await advance(0);
    runs[0].exit(exit);
    await advance(0);
    assertEquals(s.status.state, expected, `${on} ${JSON.stringify(exit)}`);
  }
});

Deno.test("supervisor: a start that never gets ready is stopped and counts as a failure", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const s = createSidecarSupervisor({
    definition: def({
      ready: { signal: true, timeoutMs: 500 },
      restart: { maxAttempts: 1, backoffMs: 10 },
      shutdown: { graceMs: 70 },
    }),
    launch,
    clock,
  });
  s.start();
  await advance(500);
  assertEquals(runs[0].stops, [70]);
  assertEquals(s.status.state, "backoff");
  assertMatch(String(s.status.lastExit?.error), /not ready within 500 ms/);
  await advance(510);
  assertEquals(s.status.state, "failed");
});

Deno.test("supervisor: a launcher that throws is a failed start", async () => {
  const { clock, advance } = fakeClock();
  const { launch } = fakeLauncher({ failStart: true });
  const s = createSidecarSupervisor({
    definition: def({ restart: { maxAttempts: 2, backoffMs: 5 } }),
    launch,
    clock,
  });
  s.start();
  await advance(100);
  assertEquals(s.status.state, "failed");
  assertEquals(s.status.lastExit, { error: "spawn failed" });
  assertEquals(s.status.attempts, 3);
});

Deno.test("supervisor: stop uses the grace period and stays stopped; restart starts fresh", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const s = createSidecarSupervisor({
    definition: def({ shutdown: { graceMs: 1234 } }),
    launch,
    clock,
  });
  s.start();
  await advance(0);
  const seen = states(s);
  await s.stop();
  assertEquals(runs[0].stops, [1234]);
  assertEquals(s.status.state, "stopped");
  assertEquals(seen, ["stopping", "stopped"]);
  await advance(60_000);
  assertEquals(runs.length, 1, "a stopped sidecar is not restarted");
  await s.restart();
  await advance(0);
  assertEquals(s.status.state, "ready");
  assertEquals(s.status.attempts, 0);
  assertEquals(runs.length, 2);
});

Deno.test("supervisor: stop during backoff cancels the retry", async () => {
  const { clock, advance, pending } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const s = createSidecarSupervisor({
    definition: def({ restart: { backoffMs: 100 } }),
    launch,
    clock,
  });
  s.start();
  await advance(0);
  runs[0].exit({ code: 1 });
  await advance(0);
  assertEquals(s.status.state, "backoff");
  await s.stop();
  assertEquals(s.status.state, "stopped");
  await advance(1000);
  assertEquals(runs.length, 1);
  assertEquals(pending(), 0);
});

Deno.test("supervisor: whenReady resolves on ready, on failure, or at its timeout", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  const s = createSidecarSupervisor({
    definition: def({ ready: { signal: true }, restart: { on: "never" } }),
    launch,
    clock,
  });
  s.start();
  await advance(0);
  const early = s.whenReady(100);
  await advance(100);
  assertEquals((await early).state, "starting");
  const ready = s.whenReady();
  runs[0].ctx.onReadySignal();
  await advance(0);
  assertEquals((await ready).state, "ready");
  runs[0].exit({ code: 9 });
  await advance(0);
  assertEquals((await s.whenReady()).state, "failed");
});

Deno.test("supervisor: bootstrap functions are called per start with the info", async () => {
  const { clock, advance } = fakeClock();
  const { launch, runs } = fakeLauncher();
  let n = 0;
  const s = createSidecarSupervisor({
    definition: def({
      port: 4100,
      bootstrap: (info: { port?: number }) => ({ n: ++n, port: info.port }),
      restart: { backoffMs: 1 },
    }),
    launch,
    clock,
    port: 4100,
    secrets: { TOKEN: "t" },
  });
  s.start();
  await advance(0);
  runs[0].exit({ code: 1 });
  await advance(5);
  assertEquals(runs.map((r) => r.ctx.bootstrap), [{ n: 1, port: 4100 }, { n: 2, port: 4100 }]);
  assertEquals(runs[1].ctx.secrets, { TOKEN: "t" });
});

Deno.test("sidecarBackoffDelay: doubles from the base, capped", () => {
  assertEquals([1, 2, 3, 4, 5].map((a) => sidecarBackoffDelay(a, 500, 3000)), [
    500,
    1000,
    2000,
    3000,
    3000,
  ]);
});

// ── host ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("host: ports, secrets and exposed values; the bridge capability answers the page", async () => {
  const { clock, advance } = fakeClock();
  const fake = fakeLauncher();
  const events: unknown[] = [];
  const host = await createSidecarHost({
    sidecars: [
      def({
        port: "auto",
        proxy: true,
        secrets: { TOKEN: "$random", FIXED: "f" },
        expose: { token: "$secret:TOKEN", mode: "desktop" },
      }),
      { name: "worker", run: { exec: "true" } },
    ],
    launcher: () => fake.launch,
    pickPort: () => 45678,
    clock,
    emit: (cap, event, data) => events.push([cap, event, (data as SidecarStatus).state]),
  });
  assertEquals(host.names, ["api", "worker"]);
  assertEquals(host.proxied, { name: "api", port: 45678 });
  host.startAll();
  await advance(0);
  const call = async (method: string, args?: unknown): Promise<unknown> =>
    await host.capability.methods[method].handler(args, {} as never);
  const info = await call("info", { name: "api" }) as {
    port: number;
    url: string;
    values: Record<string, string>;
  };
  assertEquals(info.port, 45678);
  assertEquals(info.url, "http://127.0.0.1:45678");
  assertEquals(info.values.mode, "desktop");
  assertMatch(info.values.token, /^[A-Za-z0-9_-]{43}$/);
  assertEquals(fake.runs[0].ctx.secrets.TOKEN, info.values.token);
  assertEquals(fake.runs[0].ctx.secrets.FIXED, "f");
  assertEquals(((await call("list")) as SidecarStatus[]).map((s) => s.state), ["ready", "ready"]);
  assertEquals(((await call("status", { name: "worker" })) as SidecarStatus).name, "worker");
  await assertRejects(() => call("status", { name: "nope" }), Error, 'no sidecar named "nope"');
  await assertRejects(() => call("status", {}), Error, "name must be");
  const restarted = await call("restart", { name: "api" }) as SidecarStatus;
  assertEquals(restarted.restarts, 1);
  assert(events.some((e) => JSON.stringify(e) === '["sidecars","status","ready"]'));
  await host.stopAll();
  assertEquals(host.handle("api").status.state, "stopped");
});

Deno.test("host: an invalid list fails before anything starts", async () => {
  await assertRejects(
    () => createSidecarHost({ sidecars: [def(), def()] }),
    Error,
    "desktop: sidecars[1]",
  );
});

// ── real launchers ───────────────────────────────────────────────────────────────────────────

/** Write a module sidecar to a temp dir. */
async function sidecarModule(source: string): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-" });
  const path = join(dir, "server.mjs");
  await Deno.writeTextFile(path, source);
  return { dir, entry: toFileUrl(path).href };
}

/** A worker launch context for a real launcher. */
function realCtx(
  definition: SidecarDefinition,
  extra: Partial<SidecarLaunchContext> = {},
): SidecarLaunchContext & { lines: string[]; readySignals: number } {
  const ctx = {
    definition,
    bootstrap: { hello: "world" },
    secrets: { TOKEN: "s3cret" },
    lines: [] as string[],
    readySignals: 0,
    onLine(stream: "stdout" | "stderr", line: string) {
      ctx.lines.push(`${stream}:${line}`);
    },
    onReadySignal() {
      ctx.readySignals++;
    },
    ...extra,
  };
  return ctx;
}

const NODE_SERVER = `
import http from "node:http";
const sc = globalThis.denextSidecar;
const server = http.createServer((req, res) => {
  if (req.url === "/crash") { res.end("bye"); setTimeout(() => { throw new Error("boom"); }, 5); return; }
  if (req.url === "/exit") { res.end("bye"); setTimeout(() => process.exit(7), 5); return; }
  res.end(JSON.stringify({ argv: process.argv.slice(2), env: process.env.MODE, port: process.env.PORT,
    bootstrap: sc.bootstrap, secret: sc.secrets.TOKEN }));
});
sc.onShutdown(async () => { console.log("shutting down"); await new Promise((r) => server.close(r)); });
server.listen(Number(process.env.PORT), "127.0.0.1", () => { console.log("listening", process.env.PORT); sc.ready(); });
`;

/** A free loopback port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Wait until `check` holds (real time, bounded). */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test("worker launcher: a node:http backend runs in a worker with its own argv/env/bootstrap", async () => {
  const { dir, entry } = await sidecarModule(NODE_SERVER);
  const port = freePort();
  const definition = def({ args: ["--port", "{port}"], env: { MODE: "desktop" }, port });
  const ctx = realCtx(definition, { port });
  const inst = await workerSidecarLauncher({ entry })(ctx);
  try {
    await until(() => ctx.readySignals === 1);
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    assertEquals(body, {
      argv: ["--port", String(port)],
      env: "desktop",
      port: String(port),
      bootstrap: { hello: "world" },
      secret: "s3cret",
    });
    assert(ctx.lines.includes(`stdout:listening ${port}`));
    // The app's own environment is untouched by the sidecar's.
    assertEquals(Deno.env.get("MODE"), undefined);
    await inst.stop(2000);
    assertEquals(await inst.exited, { code: 0 });
    assert(ctx.lines.includes("stdout:shutting down"), "the onShutdown handler ran");
  } finally {
    await inst.stop(0);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("worker launcher: an uncaught error and process.exit end the worker, not the app", async () => {
  const { dir, entry } = await sidecarModule(NODE_SERVER);
  try {
    for (const [path, expected] of [["/crash", /boom/], ["/exit", /^7$/]] as const) {
      const port = freePort();
      const ctx = realCtx(def({ port }), { port });
      const inst = await workerSidecarLauncher({ entry })(ctx);
      await until(() => ctx.readySignals === 1);
      await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
      const exit = await inst.exited;
      assertMatch(String(exit.error ?? exit.code), expected);
      await assertRejects(() =>
        fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("worker launcher: a module that fails to load reports the error", async () => {
  const { dir, entry } = await sidecarModule('import "./missing.mjs";\n');
  try {
    const inst = await workerSidecarLauncher({ entry })(realCtx(def()));
    assertMatch(String((await inst.exited).error), /missing\.mjs/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A program sidecar: echoes its first stdin line, then exits when stdin closes (or on SIGTERM). */
const PROGRAM = `
const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
let greeted = false;
console.log("port " + Deno.env.get("PORT"));
for (;;) {
  const { value, done } = await reader.read();
  if (done) { console.log("stdin closed"); Deno.exit(0); }
  buf += value;
  if (!greeted && buf.includes("\\n")) { greeted = true; console.log("hello " + buf.split("\\n")[0]); }
}
`;

Deno.test("exec launcher: the program gets PORT, the hello line on stdin, and ends with the app's stop", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-exec-" });
  const script = join(dir, "prog.ts");
  await Deno.writeTextFile(script, PROGRAM);
  try {
    const definition: SidecarDefinition = {
      name: "prog",
      run: { exec: Deno.execPath() },
      args: ["run", "-A", script],
    };
    const ctx = realCtx(definition, { port: 4321 });
    const inst = await execSidecarLauncher({ program: Deno.execPath() })(ctx);
    assert(typeof inst.pid === "number");
    await until(() => ctx.lines.some((l) => l.startsWith("stdout:hello ")));
    assertEquals(ctx.lines[0], "stdout:port 4321");
    const hello = JSON.parse(ctx.lines[1].slice("stdout:hello ".length));
    assertEquals(hello, {
      name: "prog",
      port: 4321,
      bootstrap: { hello: "world" },
      secrets: { TOKEN: "s3cret" },
    });
    await inst.stop(5000);
    const exit = await inst.exited;
    assert(exit.code !== undefined || exit.signal !== undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec launcher: killExecSidecars ends every running program at once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-exec-" });
  const script = join(dir, "sleep.ts");
  await Deno.writeTextFile(script, "await new Promise(() => {}); setInterval(() => {}, 1000);\n");
  try {
    const ctx = realCtx({ name: "s", run: { exec: Deno.execPath() }, args: ["run", script] });
    const inst = await execSidecarLauncher({ program: Deno.execPath() })(ctx);
    killExecSidecars();
    const exit = await inst.exited;
    assert(exit.signal !== undefined || exit.code !== 0, JSON.stringify(exit));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveSidecarProgram: as written, the project's file, or copied out of a packaged app", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-prog-" });
  try {
    await Deno.mkdir(join(dir, "bin"));
    await Deno.writeTextFile(join(dir, "bin", "server"), "#!/bin/sh\necho hi\n");
    const base = toFileUrl(join(dir, "desktop.ts")).href;
    assertEquals(
      await resolveSidecarProgram("/usr/bin/env", "s", base, undefined, false),
      "/usr/bin/env",
    );
    assertEquals(await resolveSidecarProgram("git", "s", base, undefined, false), "git");
    assertEquals(
      await resolveSidecarProgram("./bin/server", "s", base, join(dir, "cache"), false),
      join(dir, "bin", "server"),
    );
    const copied = await resolveSidecarProgram("./bin/server", "s", base, join(dir, "cache"), true);
    assertEquals(copied, join(dir, "cache", "sidecars", "s", "server"));
    assertEquals(await Deno.readTextFile(copied), "#!/bin/sh\necho hi\n");
    if (Deno.build.os !== "windows") assertEquals((await Deno.stat(copied)).mode! & 0o111, 0o111);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
