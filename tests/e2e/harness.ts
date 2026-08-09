// Test harness for the real-browser E2E suite: build an example app and serve it
// from the production server on an ephemeral port, returning its origin and a
// clean shutdown. Not run by `deno task test`; see `deno task test:e2e`.

import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

/** A running server for the E2E suite. */
export interface RunningServer {
  /** The `http://host:port` origin the server is listening on. */
  origin: string;
  /** Abort the server and wait for it to finish draining. */
  close: () => Promise<void>;
}

/**
 * Build `dir` for production and start {@linkcode startProdServer} on an
 * ephemeral port (`port: 0`), capturing the actually-bound port via `onListen`
 * (never assume 3000). Shut down via the returned `close()`.
 *
 * @param dir Absolute path to the example app to build and serve.
 */
export async function buildAndServe(dir: string): Promise<RunningServer> {
  await build(dir);
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startProdServer({
    projectDir: dir,
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
