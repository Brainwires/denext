// Serve with automatic port fallback: if the requested port is taken, try the
// next few ports before giving up (matching the behavior of most dev servers).

/** Options for {@linkcode serveWithPortFallback}. */
export interface ServeUtilOptions {
  /** The first port to try. */
  port: number;
  /** Hostname/interface to bind; defaults to "0.0.0.0". */
  hostname?: string;
  /** Signal used to shut the server down. */
  signal?: AbortSignal;
  /** Called once the server is listening, with the bound host and port. */
  onListen?: (info: { hostname: string; port: number }) => void;
  /** How many sequential ports to try before failing (default 10). */
  maxAttempts?: number;
  /**
   * When true, the port is an explicit requirement: if it is in use, fail
   * immediately instead of trying other ports. Set this when the user passed an
   * explicit `--port`.
   */
  strict?: boolean;
}

/**
 * Like `Deno.serve`, but if the port is in use it retries on `port + 1`,
 * `port + 2`, … up to `maxAttempts` times. Returns the bound server.
 */
export function serveWithPortFallback(
  options: ServeUtilOptions,
  handler: (request: Request) => Response | Promise<Response>,
): Deno.HttpServer {
  const { port, hostname, signal, onListen, strict } = options;
  const maxAttempts = strict ? 1 : (options.maxAttempts ?? 10);

  for (let i = 0; i < maxAttempts; i++) {
    const tryPort = port + i;
    try {
      // NB: the shutdown signal is NOT passed to Deno.serve — its `signal` option
      // hard-closes live connections. Instead we drive `server.shutdown()` on
      // abort, which stops accepting new connections and DRAINS in-flight requests.
      const server = Deno.serve(
        {
          port: tryPort,
          hostname: hostname ?? "0.0.0.0",
          onListen: onListen ??
            (({ hostname, port }) => console.log(`denext listening on http://${hostname}:${port}`)),
        },
        handler,
      );
      if (signal) {
        if (signal.aborted) void server.shutdown();
        else signal.addEventListener("abort", () => void server.shutdown(), { once: true });
      }
      return server;
    } catch (error) {
      if (error instanceof Deno.errors.AddrInUse) {
        if (strict) {
          throw new Deno.errors.AddrInUse(
            `denext: port ${tryPort} is already in use. ` +
              `Free it, or omit --port to auto-select an open port.`,
          );
        }
        if (i < maxAttempts - 1) {
          console.warn(`denext: port ${tryPort} in use, trying ${tryPort + 1}…`);
          continue;
        }
      }
      throw error;
    }
  }

  // Unreachable: the loop either returns a server or throws on the last attempt.
  throw new Deno.errors.AddrInUse(
    `denext: no free port found in range ${port}–${port + maxAttempts - 1}`,
  );
}
