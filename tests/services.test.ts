// The `services/` convention and supervision's plumbing: the shared backoff helper (and that the
// sidecar and job backoffs are the same numbers through it), `services/` discovery, the boot (the
// status snapshot, the health check, the failure hook), `onServiceError` loading, and the drain:
// the dev server stops its services only after in-flight requests finished, in reverse order.
//
// Every test that starts a supervisor lives in this one file, so they run one after another: the
// supervisor registry is process-wide, and `stopServices` stops every tree in it.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  backoffDelay,
  LIVE_RESTART_DEFAULTS,
  resolveBackoff,
  resolveRestart,
  RestartWindow,
} from "../src/runtime/restart.ts";
import { sidecarBackoffDelay } from "../src/desktop/sidecar-supervisor.ts";
import {
  bootServices,
  discoverServices,
  SERVICES_SNAPSHOT,
  type ServicesSnapshot,
  stopServices,
} from "../src/server/service-loader.ts";
import { supervisionStatus } from "../src/server/supervise.ts";
import { runHealthChecks } from "../src/server/health.ts";
import { loadInstrumentation } from "../src/server/instrumentation.ts";
import { startDevServer } from "../src/build/dev-server.ts";
import { resolveProject } from "../src/build/paths.ts";
import { removeTempDir } from "./helpers/temp.ts";

const SUPERVISE = new URL("../src/server/supervise.ts", import.meta.url).href;
const EXACT = { initialMs: 100, maxMs: 1_000, factor: 2, jitter: 0 };

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-services-" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

/** Resolve once `cond()` holds, polling; reject after `ms`. Waits on the event, not a guess. */
async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---- backoff ------------------------------------------------------------------

Deno.test("backoffDelay: exponential, capped, with jitter taking up to its share off", () => {
  assertEquals([1, 2, 3, 4, 5].map((n) => backoffDelay(n, EXACT)), [100, 200, 400, 800, 1000]);
  assertEquals(backoffDelay(0, EXACT), 100, "an attempt below 1 counts as the first");
  const jittered = { ...EXACT, jitter: 0.5 };
  assertEquals(backoffDelay(1, jittered, () => 0), 100);
  assertEquals(backoffDelay(1, jittered, () => 0.999), 50);
  assertEquals(backoffDelay(3, { ...EXACT, factor: 1 }), 100, "factor 1 is a fixed delay");
  assertEquals(backoffDelay(60, { ...EXACT, maxMs: 2 ** 40 }), 2 ** 31 - 1, "a timer's limit");
});

Deno.test("backoffDelay is the sidecar backoff (no jitter): the same numbers as before", () => {
  for (
    const [attempt, base, max] of [[1, 500, 3000], [2, 500, 3000], [5, 500, 3000], [3, 250, 30_000]]
  ) {
    assertEquals(
      sidecarBackoffDelay(attempt, base, max),
      Math.min(max, base * 2 ** Math.max(0, attempt - 1)),
    );
  }
});

Deno.test("resolveBackoff / resolveRestart validate and fill defaults", () => {
  const d = { initialMs: 1, maxMs: 2, factor: 2, jitter: 0 };
  assertEquals(resolveBackoff(undefined, d, "x"), d);
  assertEquals(resolveBackoff({ maxMs: 2 ** 40 }, d, "x").maxMs, 2 ** 31 - 1);
  assertThrows(() => resolveBackoff({ jitter: 2 }, d, "x"), TypeError, "jitter");
  assertThrows(() => resolveBackoff({ factor: 0.5 }, d, "x"), TypeError, "factor");
  assertThrows(() => resolveBackoff({ initialMs: -1 }, d, "x"), TypeError, "initialMs");
  assertEquals(resolveRestart(undefined, LIVE_RESTART_DEFAULTS, "r"), null);
  assertEquals(resolveRestart(false, LIVE_RESTART_DEFAULTS, "r"), null);
  assertEquals(resolveRestart(true, LIVE_RESTART_DEFAULTS, "r"), LIVE_RESTART_DEFAULTS);
  assertEquals(resolveRestart({ maxRestarts: 1 }, LIVE_RESTART_DEFAULTS, "r")?.maxRestarts, 1);
  assertThrows(() => resolveRestart({ maxRestarts: 1.5 }, LIVE_RESTART_DEFAULTS, "r"), TypeError);
  assertThrows(() => resolveRestart({ period: 0 }, LIVE_RESTART_DEFAULTS, "r"), TypeError);
});

Deno.test("RestartWindow counts the restarts within its period", () => {
  const w = new RestartWindow(1_000);
  assertEquals(w.record(0), 1);
  assertEquals(w.record(500), 2);
  assertEquals(w.record(1_000), 2, "the one at 0 left the window");
  assertEquals(w.record(5_000), 1);
  w.reset();
  assertEquals(w.record(5_001), 1);
});

// ---- services/ ------------------------------------------------------------------

const HOLDING = (extra = "") =>
  `import { defineService } from "${SUPERVISE}";\n` +
  `export default defineService({ ${extra} async start(ctx) { await ctx.stopped; } });\n`;

Deno.test("discoverServices names each services/ file by its path, skipping _private and non-services", async () => {
  const dir = await fixture({
    "services/queue.ts": HOLDING(),
    "services/feeds/tail.ts": HOLDING(),
    "services/_helper.ts": HOLDING(),
    "services/notaservice.ts": "export const x = 1;\n",
    "services/named.ts": HOLDING('name: "explicit",'),
    "services/tree.ts": `import { defineService, supervise } from "${SUPERVISE}";\n` +
      `export default supervise({ strategy: "one_for_all", children: [defineService({ name: "a", start() {} })] });\n`,
  });
  const errors = console.error;
  console.error = () => {};
  try {
    const found = await discoverServices(join(dir, "services"));
    assertEquals(found.map((f) => f.name), ["feeds/tail", "named", "queue", "tree"]);
    assertEquals(found.map((f) => f.child.name), ["feeds/tail", "explicit", "queue", "tree"]);
    assertEquals(await discoverServices(join(dir, "missing")), []);
  } finally {
    console.error = errors;
    await removeTempDir(dir);
  }
});

Deno.test("bootServices: a root `services` supervisor, a status snapshot, a health check; stopServices undoes it", async () => {
  const dir = await fixture({ "services/a.ts": HOLDING(), "services/b.ts": HOLDING() });
  const outDir = join(dir, ".denext");
  try {
    const root = await bootServices(dir, { outDir });
    assert(root);
    assertEquals(root.status().children.map((c) => [c.path, c.state]), [
      ["services/a", "running"],
      ["services/b", "running"],
    ]);
    assertEquals(supervisionStatus().map((s) => s.name), ["services"]);
    assertEquals((await runHealthChecks()).checks.services, "ok");
    const snapshotPath = join(outDir, SERVICES_SNAPSHOT);
    const read = async () => JSON.parse(await Deno.readTextFile(snapshotPath)) as ServicesSnapshot;
    await until(async () => {
      try {
        return (await read()).supervisors[0]?.state === "running";
      } catch {
        return false;
      }
    });
    assertEquals((await read()).pid, Deno.pid);
    await stopServices();
    const last = await read();
    assertEquals(last.supervisors, [], "the stopped tree left the registry");
    assertEquals((await runHealthChecks()).checks.services, undefined, "the check is gone");
    assertEquals(await bootServices(await fixture({}), { outDir }), null, "no services/: nothing");
  } finally {
    await stopServices();
    await removeTempDir(dir);
  }
});

Deno.test("bootServices: a tree that gives up fails the health check and calls onServiceError", async () => {
  const dir = await fixture({
    "services/crashy.ts": `import { defineService } from "${SUPERVISE}";\n` +
      `export default defineService({ start() { throw new Error("no upstream"); } });\n`,
  });
  const seen: { error: unknown; path: string }[] = [];
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    const root = await bootServices(dir, {
      outDir: join(dir, ".denext"),
      onServiceError: (e, ctx) => void seen.push({ error: e, path: ctx.path }),
    });
    assert(root);
    await root.done.catch(() => {}); // 4 crashes within 5 s: 100 + 200 + 400 ms of backoff
    assertEquals(root.status().state, "failed");
    assertEquals(seen.length, 1);
    assertEquals(seen[0].path, "services");
    assertEquals((seen[0].error as Error).name, "SupervisorError");
    const health = await runHealthChecks();
    assertEquals([health.ok, health.checks.services], [false, "down"]);
  } finally {
    console.error = error;
    console.warn = warn;
    await stopServices();
    await removeTempDir(dir);
  }
  assertEquals((await runHealthChecks()).checks.services, undefined);
});

Deno.test("loadInstrumentation reads an onServiceError export", async () => {
  const dir = await fixture({ "instrumentation.ts": "export function onServiceError() {}\n" });
  try {
    const instr = await loadInstrumentation(join(dir, "instrumentation.ts"));
    assertEquals(typeof instr.onServiceError, "function");
  } finally {
    await removeTempDir(dir);
  }
});

// ---- the drain ------------------------------------------------------------------

Deno.test("dev server drain: services keep running through in-flight requests, then stop", async () => {
  const g = globalThis as { __svcLog?: string[]; __svcGate?: Promise<void> };
  g.__svcLog = [];
  let release!: () => void;
  g.__svcGate = new Promise<void>((r) => release = r);
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  const dir = await fixture({
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
      },
    }),
    "services/first.ts": `import { defineService } from "${SUPERVISE}";\n` +
      `export default defineService({ async start(ctx) { globalThis.__svcLog.push("start first");` +
      ` await ctx.stopped; globalThis.__svcLog.push("stop first"); } });\n`,
    "services/second.ts": `import { defineService } from "${SUPERVISE}";\n` +
      `export default defineService({ async start(ctx) { globalThis.__svcLog.push("start second");` +
      ` await ctx.stopped; globalThis.__svcLog.push("stop second"); } });\n`,
    "app/api/slow/route.ts": `export async function GET() { globalThis.__svcLog.push("request");` +
      ` await globalThis.__svcGate; globalThis.__svcLog.push("respond"); return new Response("ok"); }\n`,
  });
  const controller = new AbortController();
  try {
    const paths = await resolveProject(dir);
    let server!: Deno.HttpServer;
    const port = await new Promise<number>((resolve) => {
      server = startDevServer({
        paths,
        port: 0,
        hostname: "127.0.0.1",
        signal: controller.signal,
        onListen: ({ port }) => resolve(port),
      });
    });
    await until(() => g.__svcLog!.includes("start second"));
    assertEquals(g.__svcLog, ["start first", "start second"]);
    const response = fetch(`http://127.0.0.1:${port}/api/slow`).then((r) => r.text());
    await until(() => g.__svcLog!.includes("request"));
    controller.abort(); // shutdown begins with the request in flight
    await new Promise((r) => setTimeout(r, 50));
    assert(!g.__svcLog.includes("stop first"), "services outlive an in-flight request");
    release();
    assertEquals(await response, "ok");
    await server.finished;
    await until(() => g.__svcLog!.includes("stop first"));
    assertEquals(g.__svcLog, [
      "start first",
      "start second",
      "request",
      "respond",
      "stop second", // reverse start order
      "stop first",
    ]);
  } finally {
    controller.abort();
    await stopServices();
    delete g.__svcLog;
    delete g.__svcGate;
    await removeTempDir(dir);
  }
});
