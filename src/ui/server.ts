// The `denext ui` server kernel: bind loopback, run every request through the security chain,
// then dispatch it against the route table.
//
// Hard rule of this process: it never imports the user's modules. Everything that needs the
// project evaluated (`doctor --json`, `deno task`, `deno add`) goes out through
// `src/ui/proc.ts` as a subprocess — which is also what keeps the bundler out of this module
// graph (`tests/ui-server.test.ts` asserts it, via `deno info`).

import { fromFileUrl } from "@std/path";
import type { SseClients } from "../build/sse.ts";
import { displayHost, serveWithPortFallback } from "../server/serve-utils.ts";
import { jsonResponse, type UiContext } from "./html.ts";
import { broadcast, UI_ROUTES } from "./routes.ts";
import {
  applySecurityHeaders,
  authorized,
  checkCsrf,
  createUiSession,
  handshake,
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
  /** An explicit session token (`--token`); a fresh 256-bit one is minted when omitted. */
  readonly token?: string;
  /** `--read-only`: refuse every mutation with a `403`. */
  readonly readOnly?: boolean;
  /** Aborting this stops accepting and drains in-flight requests. */
  readonly signal?: AbortSignal;
  /** `--ui-dev`: watch `src/ui/**` and push a reload to every open page. */
  readonly uiDev?: boolean;
}

/** A running UI server. */
export interface UiServer {
  /** The URL to open, carrying the one-time `?t=` handshake. */
  readonly url: string;
  /** The bound port. */
  readonly port: number;
  /** The bound hostname (always loopback). */
  readonly hostname: string;
  /** The session token. */
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
  const server = serveWithPortFallback({
    port: options.port ?? DEFAULT_UI_PORT,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: () => {},
  }, (request) => handleUiRequest(request, session, events, options));
  const addr = server.addr as Deno.NetAddr;
  const url = `http://${displayHost(addr.hostname)}:${addr.port}/?t=${session.token}`;
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
 * The security chain, then table dispatch. Ordered so that a cross-origin or rebound-DNS caller
 * is refused (403) *before* the session token is ever consulted, and an unauthenticated caller
 * (401) before any route runs.
 */
async function handleUiRequest(
  request: Request,
  session: UiSession,
  events: SseClients,
  options: UiServerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (!uiOriginAllowed(request, url)) return refuse(403, "forbidden origin");
  const exchanged = handshake(url, session);
  if (exchanged) return applySecurityHeaders(exchanged);
  if (!authorized(request, session)) return refuse(401, "unauthorized");
  const route = UI_ROUTES[url.pathname];
  if (!route) return refuse(404, "not found");
  if (!route.methods.includes(request.method)) return refuse(405, "method not allowed");
  const ctx = await buildContext(request, url, session, events, options);
  if ("refusal" in ctx) return ctx.refusal;
  try {
    return applySecurityHeaders(await route.handle(request, ctx.ctx));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(500, detail);
  }
}

/** Whether `method` changes state (and therefore passes the read-only + CSRF gates). */
function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/**
 * Decode the request body (once) and assemble the feature context — or the refusal that stops a
 * mutation: `--read-only`, a cross-origin caller, or a missing/incorrect CSRF token.
 */
async function buildContext(
  request: Request,
  url: URL,
  session: UiSession,
  events: SseClients,
  options: UiServerOptions,
): Promise<{ ctx: UiContext } | { refusal: Response }> {
  const mutating = isMutation(request.method);
  if (mutating && options.readOnly) return { refusal: refuse(403, "read-only") };
  const { form, body } = mutating ? await readBody(request) : {};
  if (mutating) {
    const bad = checkCsrf(request, url, session, form);
    if (bad) return { refusal: refuse(403, bad) };
  }
  return {
    ctx: {
      dir: options.dir,
      url,
      method: request.method,
      readOnly: options.readOnly === true,
      csrf: session.csrf,
      json: url.pathname.startsWith("/api/"),
      fragment: (request.headers.get("accept") ?? "").includes("text/html-fragment"),
      form,
      body,
      events,
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
