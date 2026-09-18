// The `denext ui` server kernel: bind loopback, run every request through the security chain,
// then dispatch it against the route table.
//
// Hard rule of this process: it never imports the user's modules. EVERYTHING project-related —
// `doctor --json`, `deno task`, `deno add`, and the project's own CLI verbs (`denext commands
// --json`) — goes out through `src/ui/proc.ts` as a `deno` subprocess, so no config, plugin
// `setup()`, or app dependency is ever evaluated inside this privileged server. That is also
// what keeps the bundler out of this module graph (`tests/ui-server.test.ts` asserts both, via
// `deno info` and a runtime pid check).

import { fromFileUrl } from "@std/path";
import type { SseClients } from "../build/sse.ts";
import { serveWithPortFallback } from "../server/serve-utils.ts";
import { jsonResponse, type UiContext } from "./html.ts";
import { broadcast, closeAll } from "./events.ts";
import { UI_ROUTES } from "./routes.ts";
import {
  applySecurityHeaders,
  authorized,
  checkCsrf,
  createUiSession,
  handshake,
  isMutation,
  type UiCookie,
  uiOriginAllowed,
  type UiSession,
} from "./security.ts";

/** The port `denext ui` listens on unless `--port` says otherwise. */
export const DEFAULT_UI_PORT = 5177;

/** Options for {@linkcode startUiServer}. */
export interface UiServerOptions {
  /** The project directory the UI manages. */
  readonly dir: string;
  /** First port to try (default {@linkcode DEFAULT_UI_PORT}); `0` picks a free one. */
  readonly port?: number;
  /**
   * The port is an explicit requirement (the user passed `--port`): fail with a clear error when
   * it is taken instead of quietly serving on the next one up. Without it the default port falls
   * forward through at most ten ports.
   */
  readonly strictPort?: boolean;
  /** An explicit session token (`--token`); a fresh 256-bit one is minted when omitted. */
  readonly token?: string;
  /** `--read-only`: refuse every mutation with a `403`. */
  readonly readOnly?: boolean;
  /**
   * `denext ui --offline`: nothing the UI starts reaches the network. No JSR search; every
   * denext-CLI child (the commands listing, verb runs, doctor) runs `--deny-net --cached-only`
   * and `deno install` runs `--cached-only`; `deno task`, the wizard's `denext dev` and plugin
   * add/remove are refused with a `503` (`offline.ts`).
   */
  readonly offline?: boolean;
  /** Aborting this stops accepting and drains in-flight requests. */
  readonly signal?: AbortSignal;
  /** `--ui-dev`: watch `src/ui/**` and push a reload to every open page. */
  readonly uiDev?: boolean;
}

/** A running UI server. */
export interface UiServer {
  /**
   * The URL to open, carrying the single-use `?t=` handshake. Always `http://127.0.0.1:<port>`,
   * never `localhost`: a cookie set on `localhost` is sent to every other local server on that
   * name, so the UI's session lives on the address only it is opened at.
   */
  readonly url: string;
  /** The bound port. */
  readonly port: number;
  /** The bound hostname (always loopback). */
  readonly hostname: string;
  /** The launch token (the `?t=` value; the session cookie is a separate secret). */
  readonly token: string;
  /** Resolves once the server has stopped and drained. */
  readonly finished: Promise<void>;
  /**
   * Stop accepting, drain in-flight requests, and release the port.
   *
   * @returns Resolves when the port is free.
   */
  shutdown(): Promise<void>;
}

/**
 * Start the project-management UI on loopback.
 *
 * @param options Project directory, port, token, read-only mode, shutdown signal.
 * @returns The bound server, its URL (with the handshake token) and a `shutdown()`.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const session = await createUiSession(options.token);
  const events: SseClients = new Set();
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  controller.signal.addEventListener("abort", () => closeAll(events), { once: true });
  const server = serveWithPortFallback({
    port: options.port ?? DEFAULT_UI_PORT,
    hostname: "127.0.0.1",
    strict: options.strictPort === true,
    signal: controller.signal,
    onListen: () => {},
  }, (request) => handleUiRequest(request, session, events, controller.signal, options));
  const addr = server.addr as Deno.NetAddr;
  const url = `http://${addr.hostname}:${addr.port}/?t=${session.token}`;
  if (options.uiDev) watchUiSources(events, controller.signal);
  return {
    url,
    port: addr.port,
    hostname: addr.hostname,
    token: session.token,
    finished: server.finished,
    shutdown: async () => {
      controller.abort();
      await server.finished;
    },
  };
}

/**
 * Every request, with nothing able to escape as a bare 500: a thrown handler, and a malformed
 * `Host` that `new URL` itself rejects, both come back as the hardened `{ ok: false }` envelope.
 * The detail goes to the server's own stderr — a local page is not the place to echo a stack, a
 * path, or whatever a filesystem error decided to say.
 */
async function handleUiRequest(
  request: Request,
  session: UiSession,
  events: SseClients,
  signal: AbortSignal,
  options: UiServerOptions,
): Promise<Response> {
  try {
    return await dispatch(request, session, events, signal, options);
  } catch (error) {
    console.error("denext ui:", error instanceof Error ? (error.stack ?? error.message) : error);
    return refuse(500, "internal error");
  }
}

/**
 * The security chain, then table dispatch. Ordered so that a cross-origin or rebound-DNS caller
 * is refused (403) *before* the session token is ever consulted, and an unauthenticated caller
 * (401) before any route runs.
 */
async function dispatch(
  request: Request,
  session: UiSession,
  events: SseClients,
  signal: AbortSignal,
  options: UiServerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (!uiOriginAllowed(request, url)) return refuse(403, "forbidden origin");
  const exchanged = await handshake(request, url, session);
  if (exchanged) return applySecurityHeaders(exchanged);
  const cookie = authorized(request, session);
  if (cookie === null) return refuse(401, "unauthorized");
  const route = UI_ROUTES[url.pathname];
  if (!route) return refuse(404, "not found");
  if (!route.methods.includes(request.method)) return refuse(405, "method not allowed");
  const ctx = await buildContext(request, url, cookie, events, signal, options);
  if ("refusal" in ctx) return ctx.refusal;
  return applySecurityHeaders(await route.handle(request, ctx.ctx));
}

/**
 * Decode the request body (once) and assemble the feature context — or the refusal that stops a
 * mutation: `--read-only`, a cross-origin caller, or a missing/incorrect CSRF token.
 */
async function buildContext(
  request: Request,
  url: URL,
  cookie: UiCookie,
  events: SseClients,
  signal: AbortSignal,
  options: UiServerOptions,
): Promise<{ ctx: UiContext } | { refusal: Response }> {
  const mutating = isMutation(request.method);
  if (mutating && options.readOnly) return { refusal: refuse(403, "read-only") };
  const { form, body } = mutating ? await readBody(request) : {};
  if (mutating) {
    const bad = checkCsrf(request, url, cookie, form);
    if (bad) return { refusal: refuse(403, bad) };
  }
  return {
    ctx: {
      dir: options.dir,
      url,
      method: request.method,
      readOnly: options.readOnly === true,
      offline: options.offline === true,
      csrf: cookie.csrf,
      json: url.pathname.startsWith("/api/"),
      fragment: (request.headers.get("accept") ?? "").includes("text/html-fragment"),
      form,
      body,
      events,
      signal,
    },
  };
}

/** Decode a mutation's body once, so the CSRF gate and the feature share one read. */
async function readBody(request: Request): Promise<{ form?: FormData; body?: unknown }> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (/form-data|x-www-form-urlencoded/.test(type)) return { form: await request.formData() };
    if (type.includes("json")) return { body: await request.json() };
  } catch { /* malformed body — the gates below see no token and refuse */ }
  return {};
}

/** A hardened `{ ok: false, reason }` refusal. */
function refuse(status: number, reason: string): Response {
  return applySecurityHeaders(jsonResponse({ ok: false, reason }, status));
}

/**
 * `--ui-dev`: watch this module's own directory and push a reload to every open page. Only
 * possible when the CLI runs from a checkout — installed from JSR the framework root is an
 * `https:` URL with no filesystem behind it, so the watcher is skipped.
 */
function watchUiSources(events: SseClients, signal: AbortSignal): void {
  if (!import.meta.url.startsWith("file:")) return;
  const dir = fromFileUrl(new URL(".", import.meta.url));
  let timer: ReturnType<typeof setTimeout> | undefined;
  (async () => {
    const watcher = Deno.watchFs(dir);
    signal.addEventListener("abort", () => watcher.close(), { once: true });
    for await (const _event of watcher) {
      clearTimeout(timer);
      timer = setTimeout(() => broadcast(events, { type: "reload" }), 80);
    }
  })().catch(() => {/* watcher closed on shutdown */});
}
