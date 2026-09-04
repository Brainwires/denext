// Start the real prod server for an already-built example app on an ephemeral
// port and hand back its origin. Shared by the integration tests that build an
// example and then probe it over plain HTTP.

import { startProdServer } from "../../src/build/prod-server.ts";

export interface ProdOrigin {
  /** `http://127.0.0.1:<port>` of the listening server. */
  origin: string;
  /** The server handle — `await server.finished` after aborting `signal`. */
  server: Deno.HttpServer;
}

export async function startProdOrigin(
  projectDir: string,
  signal: AbortSignal,
): Promise<ProdOrigin> {
  const { promise, resolve } = Promise.withResolvers<
    { hostname: string; port: number }
  >();
  const server = await startProdServer({
    projectDir,
    port: 0,
    hostname: "127.0.0.1",
    signal,
    onListen: (info) => resolve(info),
  });
  const { hostname, port } = await promise;
  return { origin: `http://${hostname}:${port}`, server };
}
