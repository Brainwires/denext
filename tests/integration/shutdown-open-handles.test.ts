// `denext start` exits by the drain deadline even when something the app opened stays open.
//
// An app-owned database pool (postgres.js with DENEXT_TEST_POSTGRES_URL, else a ref'd timer
// standing in for one) keeps the event loop alive after the server has drained, so the process
// used to outlive SIGTERM until the orchestrator SIGKILLed it. Now: the in-flight request
// finishes, the teardowns run, and the process exits at `DENEXT_SHUTDOWN_DRAIN_MS`, or as soon as
// `instrumentation.ts`'s `onShutdown()` closes the pool. The same `startProdServer` serves a
// `denext build --compile` binary (tests/integration/compile-app.test.ts checks it there).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { removeTempDir } from "../helpers/temp.ts";
import { spawnStoppable } from "../helpers/console-ctrl.ts";
import { boundedOutput } from "../helpers/bounded-command.ts";
import { boundPort, untilServes } from "../helpers/port.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FW_URL = toFileUrl(FW).href;
const PG_URL = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const DRAIN_MS = 3000;

/** What the slow route prints when its handler starts: the test signals only after it. */
const SLOW_STARTED = "fixture: slow handler started";

/** The fixture: a slow route and an instrumentation module that opens a pool at boot. */
const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({
    nodeModulesDir: "none",
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
    imports: {
      "denext": `${FW_URL}mod.ts`,
      "denext/": `${FW_URL}src/`,
      "denext/jsx-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
      "denext/jsx-dev-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
      "denext/server": `${FW_URL}src/server/mod.ts`,
    },
  }),
  "app/layout.tsx": `export default function Root({ children }: { children: unknown }) {
  return <html><body>{children}</body></html>;
}
`,
  "app/page.tsx": `export default function Home() {
  return <p>home</p>;
}
`,
  "app/api/slow/route.ts": `export async function GET(): Promise<Response> {
  console.log("${SLOW_STARTED}");
  await new Promise((r) => setTimeout(r, 1500));
  return new Response("slow done");
}
`,
  "instrumentation.ts": `let close: (() => Promise<void>) | undefined;
export async function register() {
  const url = Deno.env.get("DATABASE_URL");
  if (url) {
    const spec = ["npm:postgres", "3.4.7"].join("@");
    const postgres = (await import(spec)).default;
    const sql = postgres(url, { max: 2, onnotice: () => {} });
    await sql\`select 1\`; // an open connection in the pool
    close = () => sql.end({ timeout: 1 });
  } else {
    const timer = setInterval(() => {}, 1000); // stands in for a pool nothing closes
    close = () => Promise.resolve(clearInterval(timer));
  }
}
export async function onShutdown() {
  if (!Deno.env.get("FIXTURE_CLOSE_ON_SHUTDOWN")) return;
  await close?.();
  console.log("onShutdown closed the pool");
}
`,
};

/** Run the CLI to completion; fail with its output. */
async function cli(dir: string, args: string[]): Promise<void> {
  const r = await boundedOutput(Deno.execPath(), {
    args: ["run", "-A", "--config", join(dir, "deno.json"), join(FW, "cli.ts"), ...args],
    cwd: dir,
    env: { NO_COLOR: "1" },
  });
  const dec = new TextDecoder();
  assertEquals(r.code, 0, dec.decode(r.stdout) + dec.decode(r.stderr));
}

/**
 * `denext start`, then a stop while `/api/slow` is in flight — SIGTERM on POSIX, the console's
 * Ctrl-C (or, with `kind: "break"`, Ctrl-Break) on Windows: the request's body, how long the
 * process took to exit after the signal, and its output. Fails if it outlives the deadline by far.
 */
async function startThenStop(
  dir: string,
  env: Record<string, string>,
  kind: "c" | "break" = "c",
): Promise<{ text: string; exitMs: number; output: string }> {
  const server = spawnStoppable(
    Deno.execPath(),
    [
      "run",
      "-A",
      "--config",
      join(dir, "deno.json"),
      join(FW, "cli.ts"),
      "start",
      "--port",
      "0", // the port the OS picks, which the server prints: nothing another process can take
      dir,
    ],
    { cwd: dir, env: { NO_COLOR: "1", DENEXT_SHUTDOWN_DRAIN_MS: String(DRAIN_MS), ...env } },
  );
  const child = server.child;
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const d = new TextDecoder();
    for await (const chunk of stream) output += d.decode(chunk, { stream: true });
  };
  const reading = Promise.all([read(child.stdout), read(child.stderr)]);
  let exited = false;
  child.status.then(() => exited = true);
  try {
    const port = await boundPort(() => output, () => exited);
    const origin = `http://127.0.0.1:${port}`;
    const up = port === undefined ? undefined : await untilServes(`${origin}/`, () => exited);
    await up?.body?.cancel();
    assert(!exited, `start exited early:\n${output}`);
    const inFlight = fetch(`${origin}/api/slow`).then((r) => r.text());
    // Signal once the handler is running (it says so), not after a fixed wait a loaded machine
    // may not have reached it by.
    for (let i = 0; i < 600 && !output.includes(SLOW_STARTED) && !exited; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertStringIncludes(output, SLOW_STARTED, "the slow handler never started");
    const signalled = performance.now();
    await server.stop(kind);
    const text = await inFlight;
    let hung = false;
    const guard = setTimeout(() => {
      hung = !exited;
      if (hung) child.kill("SIGKILL");
    }, DRAIN_MS + 10_000);
    await child.status;
    clearTimeout(guard);
    await reading;
    assert(!hung, `still running ${DRAIN_MS + 10_000} ms after SIGTERM:\n${output}`);
    return { text, exitMs: performance.now() - signalled, output };
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await child.status;
    }
  }
}

Deno.test({
  name: "denext start: an open pool no longer holds the process past the drain deadline",
  // On Windows the stop is the console's Ctrl-C / Ctrl-Break (tests/helpers/console-ctrl.ts):
  // Windows has no SIGTERM, and `kill("SIGTERM")` there is `TerminateProcess`.
  fn: async (t) => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_shutdown_" }));
    const env: Record<string, string> = PG_URL ? { DATABASE_URL: PG_URL } : {};
    try {
      for (const [rel, content] of Object.entries(FILES)) {
        await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
        await Deno.writeTextFile(join(dir, rel), content);
      }
      await cli(dir, ["build", dir]);

      await t.step(
        "the in-flight request finishes, then the deadline ends the process",
        async () => {
          const r = await startThenStop(dir, env);
          assertEquals(r.text, "slow done");
          assert(r.exitMs >= 1000, `exited ${r.exitMs} ms after SIGTERM, before the request`);
          assert(r.exitMs < DRAIN_MS + 3000, `exited ${r.exitMs} ms after SIGTERM:\n${r.output}`);
          assertStringIncludes(r.output, "open handle");
        },
      );

      await t.step(
        "onShutdown closes the pool, and the process exits without waiting",
        async () => {
          const r = await startThenStop(dir, { ...env, FIXTURE_CLOSE_ON_SHUTDOWN: "1" });
          assertEquals(r.text, "slow done");
          assertStringIncludes(r.output, "onShutdown closed the pool");
          assert(!r.output.includes("open handle"), r.output);
          assert(r.exitMs < DRAIN_MS, `exited ${r.exitMs} ms after SIGTERM:\n${r.output}`);
        },
      );

      // Windows: Ctrl-Break (what a service wrapper may send instead) drains the same way.
      await t.step({
        name: "Ctrl-Break drains and runs onShutdown too",
        ignore: Deno.build.os !== "windows",
        fn: async () => {
          const r = await startThenStop(dir, { ...env, FIXTURE_CLOSE_ON_SHUTDOWN: "1" }, "break");
          assertEquals(r.text, "slow done");
          assertStringIncludes(r.output, "onShutdown closed the pool");
          assert(r.exitMs < DRAIN_MS, `exited ${r.exitMs} ms after Ctrl-Break:\n${r.output}`);
        },
      });
    } finally {
      await removeTempDir(dir);
    }
  },
});
