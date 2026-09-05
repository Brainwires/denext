// Serve with automatic port fallback: if the requested port is taken, try the
// next few ports before giving up (matching the behavior of most dev servers).

import { applyDefaultSecurityHeaders } from "./app.ts";
import { setRemoteAddr } from "./remote-addr.ts";
import { serveStatic } from "./static.ts";
import type { HstsConfig } from "./config.ts";

/** Cache-control for content-hashed, immutable build assets (split chunks, self-hosted fonts). */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
/**
 * Cache-control for build assets whose NAME does not change between builds (`<routeId>.js`,
 * `<routeId>.css`, `flight.js`): cacheable but revalidated on every use (ETag/304 from
 * `serveStatic`), so a redeploy is picked up instead of a browser holding the old entry for
 * a year.
 */
const REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** A basename that carries a content hash (`chunk-<hash>.js`, `<name>-<hash>.woff2`, …). */
function isContentHashed(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return /^chunk-[a-z0-9_-]+\.js$/i.test(base) || /[-.][0-9a-f]{8,}\.[a-z0-9]+$/i.test(base);
}

/**
 * Serve a built, content-hashed asset from `dir` (path `rel`) as immutable, with
 * denext's default hardening headers applied. Returns a hardened 404 carrying
 * `notFoundBody` when the file isn't found. Centralizes the "serve a client/font
 * asset with cache-control + default hardening, else a hardened 404" shape shared
 * by the prod server (client bundles, self-hosted fonts) and the SPA prod server.
 *
 * @param dir Directory root to serve from.
 * @param rel Request-relative path under `dir` (already prefix-stripped).
 * @param request The incoming request (for `accept-encoding` negotiation).
 * @param secure Whether the connection is HTTPS (gates HSTS in the hardening set).
 * @param hsts Optional HSTS tuning, threaded to {@link applyDefaultSecurityHeaders}.
 * @param notFoundBody Body for the 404 response; defaults to `"not found"`. Pass a
 *   JS comment (e.g. `"// not found"`) for a `.js` asset route so a 404 body can't
 *   be misparsed as script.
 */
export async function serveImmutableAsset(
  dir: string,
  rel: string,
  request: Request,
  secure: boolean,
  hsts: HstsConfig | false | undefined,
  notFoundBody = "not found",
): Promise<Response> {
  const asset = await serveStatic(
    dir,
    rel,
    request.headers.get("accept-encoding") ?? undefined,
    request,
  );
  if (asset) {
    asset.headers.set(
      "cache-control",
      isContentHashed(rel) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
    );
    return applyDefaultSecurityHeaders(asset, secure, hsts);
  }
  return applyDefaultSecurityHeaders(new Response(notFoundBody, { status: 404 }), secure, hsts);
}

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
  const { port, strict } = options;
  const maxAttempts = strict ? 1 : (options.maxAttempts ?? 10);
  for (let i = 0; i < maxAttempts; i++) {
    const tryPort = port + i;
    try {
      return serveOn(tryPort, options, handler);
    } catch (error) {
      if (!(error instanceof Deno.errors.AddrInUse)) throw error;
      if (strict) {
        throw new Deno.errors.AddrInUse(
          `denext: port ${tryPort} is already in use. ` +
            `Free it, or omit --port to auto-select an open port.`,
        );
      }
      if (i === maxAttempts - 1) throw error;
      console.warn(`denext: port ${tryPort} in use, trying ${tryPort + 1}…`);
    }
  }
  // Unreachable: the loop either returns a server or throws on the last attempt.
  throw new Deno.errors.AddrInUse(
    `denext: no free port found in range ${port}–${port + maxAttempts - 1}`,
  );
}

/**
 * `Deno.serve` on one port with graceful shutdown wired. NB: the shutdown signal is NOT
 * passed to Deno.serve — its `signal` option hard-closes live connections. Instead
 * `server.shutdown()` is driven on abort, which stops accepting new connections and
 * DRAINS in-flight requests (bounded by the drain deadline).
 */
function serveOn(
  port: number,
  options: ServeUtilOptions,
  handler: (request: Request) => Response | Promise<Response>,
): Deno.HttpServer {
  const server = Deno.serve(
    {
      port,
      hostname: options.hostname ?? "0.0.0.0",
      onListen: options.onListen ??
        (({ hostname, port }) => console.log(`denext listening on http://${hostname}:${port}`)),
    },
    (request, info) => {
      setRemoteAddr(request, info.remoteAddr);
      return handler(request);
    },
  );
  const { signal } = options;
  if (signal) {
    const beginShutdown = () => {
      installDrainDeadline(
        server.shutdown(),
        options.shutdownDrainMs ?? 0,
        options.onDrainTimeout ?? defaultDrainTimeout,
      );
    };
    if (signal.aborted) beginShutdown();
    else signal.addEventListener("abort", beginShutdown, { once: true });
  }
  return server;
}
