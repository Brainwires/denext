// Serve each framework's PRODUCTION build on a local port, so a real browser can
// load it. denext is served in-process via its own prod server; Next.js is served
// by shelling out to `next start` against its `.next` build.
//
// Both return the same { origin, close } shape used by the browser harness.

import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

export interface RunningServer {
  origin: string;
  close: () => Promise<void>;
}

/** Pick a free TCP port by binding :0, reading the port, and releasing it. */
function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

/** Poll `${origin}/` until it answers or the deadline passes. */
async function waitReachable(
  origin: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(origin + "/", { redirect: "manual" });
      await r.body?.cancel();
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`server at ${origin} never became reachable`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Build (unless reused) and serve a denext app on an ephemeral port. */
export async function serveDenext(
  appDir: string,
  opts: { reuseBuild?: boolean } = {},
): Promise<RunningServer> {
  if (!opts.reuseBuild) await build(appDir);
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<
    { hostname: string; port: number }
  >();
  const server = await startProdServer({
    projectDir: appDir,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: (info) => resolve(info),
  });
  const { hostname, port } = await promise;
  return {
    origin: `http://${hostname}:${port}`,
    close: async () => {
      controller.abort();
      await server.finished;
    },
  };
}

/** Serve a pre-built Next.js app via `next start` on a free port. */
export async function serveNext(
  appDir: string,
  nextBin: string,
): Promise<RunningServer> {
  const port = freePort();
  const child = new Deno.Command(nextBin, {
    args: ["start", "-p", String(port)],
    cwd: appDir,
    env: { ...Deno.env.toObject(), NEXT_TELEMETRY_DISABLED: "1" },
    stdout: "null",
    stderr: "null",
  }).spawn();

  const origin = `http://127.0.0.1:${port}`;
  await waitReachable(origin);
  return {
    origin,
    close: async () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      await child.status.catch(() => {});
    },
  };
}
