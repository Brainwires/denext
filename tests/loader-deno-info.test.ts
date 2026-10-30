// The esbuild loader's own `deno info` children are bounded (src/build/loader-deno-info.ts). The
// loader runs `new Deno.Command(Deno.execPath(), ["info", "--json", …]).output()` with no
// deadline; a `deno info` that never exits (seen on Windows CI beside other Deno children) hung
// the whole build. Here the stand-in for that child is a real `deno info` of a module served by a
// local socket that accepts and never answers: unbounded, the build waits forever (this file's
// bound fails it); bounded, it is killed at a short deadline and retried once.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { denoLoaderPlugins } from "../src/build/deno-loader-plugins.ts";
import { DENO_CHILD_LOG } from "../src/build/child-probe.ts";
import { withBoundedDenoInfo } from "../src/build/loader-deno-info.ts";
import { ChildStallError, serialChildTurns } from "../src/build/serial-child.ts";

/** Each `deno info` attempt's deadline here: well past a warm `deno info`, short for a test. */
const DEADLINE_MS = 4_000;

/** How long a case may take before it counts as a hang (two attempts plus slack). */
const TEST_BOUND_MS = 60_000;

const BODY = 'export const served = "SERVED_ON_RETRY";\n';

/**
 * A loopback HTTP server that holds the first `hangFirst` connections open without answering
 * (every connection when `Infinity`) and serves {@linkcode BODY} on the rest.
 */
function silentServer(hangFirst: number) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const held: Deno.Conn[] = [];
  const serving: Promise<void>[] = [];
  let connections = 0;
  const serve = async (conn: Deno.Conn) => {
    try {
      const buf = new Uint8Array(16_384);
      let head = "";
      while (!head.includes("\r\n\r\n")) {
        const n = await conn.read(buf);
        if (n === null) return;
        head += new TextDecoder().decode(buf.subarray(0, n));
      }
      const body = new TextEncoder().encode(BODY);
      await conn.write(new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\ncontent-type: application/typescript\r\n" +
          `content-length: ${body.length}\r\nconnection: close\r\n\r\n`,
      ));
      await conn.write(body);
    } catch {
      /* the client went away */
    } finally {
      try {
        conn.close();
      } catch { /* closed */ }
    }
  };
  const accepting = (async () => {
    try {
      for await (const conn of listener) {
        connections++;
        if (connections <= hangFirst) held.push(conn);
        else serving.push(serve(conn));
      }
    } catch { /* listener closed */ }
  })();
  return {
    port: (listener.addr as Deno.NetAddr).port,
    connections: () => connections,
    async close() {
      for (const conn of held) {
        try {
          conn.close();
        } catch { /* closed */ }
      }
      listener.close();
      await accepting;
      await Promise.all(serving);
    },
  };
}

/** An app whose entry imports a module from `port`. */
async function remoteApp(port: number): Promise<string> {
  const app = await Deno.makeTempDir({ prefix: "denext-loader-info-" });
  await Deno.writeTextFile(join(app, "deno.json"), "{}");
  await Deno.writeTextFile(
    join(app, "main.ts"),
    `import { served } from "http://127.0.0.1:${port}/m-${crypto.randomUUID()}.ts";\n` +
      "console.log(served);\n",
  );
  return app;
}

/** `p`, or a rejection once {@linkcode TEST_BOUND_MS} has passed (the hang this file guards). */
async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the build was still running after ${TEST_BOUND_MS} ms`)),
      TEST_BOUND_MS,
    );
  });
  try {
    return await Promise.race([p, hang]);
  } finally {
    clearTimeout(timer);
  }
}

function build(app: string) {
  return esbuild.build({
    entryPoints: [join(app, "main.ts")],
    absWorkingDir: app,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
    plugins: denoLoaderPlugins(
      { configPath: join(app, "deno.json"), loader: "native" },
      { infoDeadlineMs: DEADLINE_MS },
    ),
  });
}

Deno.test({
  name: "loader deno info: one that never exits fails the build within its deadline, naming it",
  async fn() {
    const server = silentServer(Infinity);
    const app = await remoteApp(server.port);
    const started = Date.now();
    try {
      const err = await assertRejects(() => bounded(build(app)));
      const text = String((err as { message?: unknown }).message ?? err);
      assert(text.includes("deno info"), text);
      assert(text.includes("stalled twice"), text);
      assertEquals(server.connections(), 2, "killed once, retried once, killed again");
      assert(Date.now() - started < TEST_BOUND_MS);
    } finally {
      await esbuild.stop();
      await server.close();
      await Deno.remove(app, { recursive: true });
    }
  },
});

Deno.test({
  name: "loader deno info: one that stalls once is killed and the retry builds",
  async fn() {
    const server = silentServer(1);
    const app = await remoteApp(server.port);
    try {
      const result = await bounded(build(app));
      assert(result.outputFiles[0].text.includes("SERVED_ON_RETRY"), "the module was bundled");
      assertEquals(server.connections(), 2);
    } finally {
      await esbuild.stop();
      await server.close();
      await Deno.remove(app, { recursive: true });
    }
  },
});

Deno.test("withBoundedDenoInfo: only a deno info inside a loader callback is bounded", async () => {
  const exec = Deno.execPath();
  let inside: Promise<Deno.CommandOutput> | undefined;
  const plugin = withBoundedDenoInfo({
    name: "probe",
    setup(build) {
      build.onStart(async () => {
        await new Promise((r) => setTimeout(r, 1)); // across an await and a timer
        // A child that runs past the deadline: killed, retried, killed.
        inside = new Deno.Command(exec, {
          args: ["info", "--json"],
          stdout: "piped",
          stderr: "null",
        }).output();
        await inside.catch(() => {});
      });
    },
  }, 1);
  const starts: Array<() => unknown> = [];
  await plugin.setup({
    onStart: (cb: () => unknown) => starts.push(cb),
  } as unknown as esbuild.PluginBuild);
  await starts[0]();
  await assertRejects(() => inside!, ChildStallError);
  // Outside a callback: the stock `output()`, no turn taken in the serialized queue.
  const turns = serialChildTurns();
  const outside = await new Deno.Command(exec, {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  assert(outside.success);
  assertEquals(serialChildTurns(), turns);
});

Deno.test("withBoundedDenoInfo: under DENEXT_CHILD_PROBE a stalled deno info reports its probe", async () => {
  const exec = Deno.execPath();
  const previous = Deno.env.get("DENEXT_CHILD_PROBE");
  Deno.env.set("DENEXT_CHILD_PROBE", "1");
  try {
    let inside: Promise<Deno.CommandOutput> | undefined;
    const plugin = withBoundedDenoInfo({
      name: "probe",
      setup(build) {
        build.onStart(async () => {
          // Killed at the deadline (before it can finish), retried, killed again.
          inside = new Deno.Command(exec, {
            args: ["info", "--json"],
            stdout: "piped",
            stderr: "null", // piped anyway when probed
          }).output();
          await inside.catch(() => {});
        });
      },
    }, 1);
    const starts: Array<() => unknown> = [];
    await plugin.setup({
      onStart: (cb: () => unknown) => starts.push(cb),
    } as unknown as esbuild.PluginBuild);
    await starts[0]();
    const err = await assertRejects(() => inside!, ChildStallError);
    assert(err.probe !== undefined, "the stall carries the probe's report");
    assertStringIncludes(err.probe, `DENO_LOG=${DENO_CHILD_LOG}`);
    assertStringIncludes(err.message, "stalled twice");
    assertStringIncludes(err.message, "cpu: ");
  } finally {
    if (previous === undefined) Deno.env.delete("DENEXT_CHILD_PROBE");
    else Deno.env.set("DENEXT_CHILD_PROBE", previous);
  }
});
