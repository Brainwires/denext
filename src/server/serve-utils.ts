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
  /**
   * Max milliseconds to wait for in-flight requests to drain after a shutdown
   * signal before forcing the process to exit. `server.shutdown()` drains
   * gracefully but waits indefinitely, so a slow/stuck client could otherwise
   * pin the process open forever. `0` (the default) waits indefinitely (previous
   * behavior). When positive, {@linkcode onDrainTimeout} fires once the deadline
   * elapses with requests still in flight.
   */
  shutdownDrainMs?: number;
  /**
   * Called when the drain deadline ({@linkcode shutdownDrainMs}) elapses. Defaults
   * to warning and `Deno.exit(0)`. Injectable for tests.
   */
  onDrainTimeout?: () => void;
}

/**
 * Format a bound hostname for a clickable banner URL. Deno reports the *resolved*
 * bind address, so `localhost` often comes back as the IPv6 loopback `::1` — which,
 * printed bare, yields the invalid `http://::1:3000` (an IPv6 host must be
 * bracketed). Loopback/any-interface addresses are shown as `localhost` (reachable
 * and clickable), and any other IPv6 literal is bracketed.
 *
 * @param hostname The bound hostname Deno reported.
 * @returns A host suitable for embedding in an `http://HOST:PORT` URL.
 */
export function displayHost(hostname: string): string {
  if (
    hostname === "0.0.0.0" || hostname === "::" || hostname === "::1" ||
    hostname === "127.0.0.1"
  ) {
    return "localhost";
  }
  // A bare IPv6 literal (contains ":" but isn't already bracketed) needs brackets.
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

/** Default drain-deadline action: warn and force-exit. */
function defaultDrainTimeout(): void {
  console.warn(
    "denext: graceful-shutdown drain deadline reached — forcing exit with requests still in flight.",
  );
  Deno.exit(0);
}

/**
 * Bound a graceful drain: if `draining` hasn't settled within `drainMs`, invoke
 * `onTimeout` (force-exit). `drainMs <= 0` waits indefinitely (a no-op). The timer
 * is unref'd so it never itself keeps the event loop alive, and is cleared the
 * moment the drain settles. Returns a cancel function.
 *
 * @param draining The `server.shutdown()` promise (or any drain completion signal).
 * @param drainMs Deadline in ms; `<= 0` disables the bound.
 * @param onTimeout Invoked once if the deadline elapses before `draining` settles.
 * @returns A function that cancels the pending deadline.
 */
export function installDrainDeadline(
  draining: Promise<unknown>,
  drainMs: number,
  onTimeout: () => void,
): () => void {
  if (!(drainMs > 0)) return () => {};
  const timer = setTimeout(onTimeout, drainMs);
  // Don't let the deadline timer alone keep the process alive.
  try {
    Deno.unrefTimer(timer);
  } catch { /* older runtime without unrefTimer */ }
  const cancel = () => clearTimeout(timer);
  draining.then(cancel, cancel);
  return cancel;
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
        const beginShutdown = () => {
          const draining = server.shutdown();
          installDrainDeadline(
            draining,
            options.shutdownDrainMs ?? 0,
            options.onDrainTimeout ?? defaultDrainTimeout,
          );
        };
        if (signal.aborted) beginShutdown();
        else signal.addEventListener("abort", beginShutdown, { once: true });
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
          console.warn(
            `denext: port ${tryPort} in use, trying ${tryPort + 1}…`,
          );
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
