// Serve with automatic port fallback: if the requested port is taken, try the
// next few ports before giving up (matching the behavior of most dev servers).

export interface ServeUtilOptions {
  port: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  /** How many sequential ports to try before failing (default 10). */
  maxAttempts?: number;
}

/**
 * Like `Deno.serve`, but if the port is in use it retries on `port + 1`,
 * `port + 2`, … up to `maxAttempts` times. Returns the bound server.
 */
export function serveWithPortFallback(
  options: ServeUtilOptions,
  handler: (request: Request) => Response | Promise<Response>,
): Deno.HttpServer {
  const { port, hostname, signal, onListen } = options;
  const maxAttempts = options.maxAttempts ?? 10;

  for (let i = 0; i < maxAttempts; i++) {
    const tryPort = port + i;
    try {
      return Deno.serve(
        {
          port: tryPort,
          hostname: hostname ?? "0.0.0.0",
          signal,
          onListen: onListen ??
            (({ hostname, port }) => console.log(`denext listening on http://${hostname}:${port}`)),
        },
        handler,
      );
    } catch (error) {
      if (error instanceof Deno.errors.AddrInUse && i < maxAttempts - 1) {
        console.warn(
          `denext: port ${tryPort} in use, trying ${tryPort + 1}…`,
        );
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop either returns a server or throws on the last attempt.
  throw new Deno.errors.AddrInUse(
    `denext: no free port found in range ${port}–${port + maxAttempts - 1}`,
  );
}
