// Reverse proxy for SPA serving: forward selected path prefixes (HTTP + WebSocket)
// to a separate backend, so a client-only SPA can reach its API and socket on the
// same origin denext serves it from — the SPA analogue of a Vite dev server's
// `server.proxy`. Configured via `spa.proxy` ({@link SpaProxyConfig}).
//
// This is a desktop/dev convenience for reaching a *local* backend (a loopback
// target is enforced by `validateDenextConfig` unless `allowNonLoopback`). It is
// NOT a hardened production reverse proxy.
//
// `npm:ws` is imported statically here because Deno's built-in `WebSocket` client
// cannot set request headers (notably `Cookie`) on the upgrade, which cookie-authed
// backends require. This module is only imported (lazily, from spa.ts) when an app
// actually declares `spa.proxy`, so proxy-less SPAs never pull in `ws`.

import { WebSocket as NodeWebSocket } from "ws";
import type { SpaProxyConfig } from "../server/config.ts";

/** True when `pathname` is under one of the proxied prefixes (exact match or sub-path). */
export function matchesProxyPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Guarded upgrade check — reading headers after the socket is taken over can throw. */
function isWebSocketUpgrade(req: Request): boolean {
  try {
    return req.headers.get("upgrade")?.toLowerCase() === "websocket";
  } catch {
    return false;
  }
}

/**
 * Forward a matched request to `cfg.target`. HTTP is relayed via `fetch` (with the
 * `Set-Cookie` `Domain`/`Secure` attributes stripped so cookies bind to the proxy
 * origin over http); a WebSocket upgrade is bridged to the backend with the request
 * `Cookie` forwarded on the handshake. Call only for requests that already matched a
 * proxy prefix (see {@link matchesProxyPrefix}).
 */
export function proxyToBackend(
  req: Request,
  url: URL,
  cfg: SpaProxyConfig,
): Response | Promise<Response> {
  const backend = new URL(cfg.target);
  if (isWebSocketUpgrade(req)) {
    try {
      return proxyWebSocket(req, url, backend);
    } catch (e) {
      console.error("denext proxy: ws upgrade failed", e);
      return new Response("ws proxy error", { status: 502 });
    }
  }
  return proxyHttp(req, url, backend);
}

async function proxyHttp(req: Request, url: URL, backend: URL): Promise<Response> {
  const target = new URL(url.pathname + url.search, backend);
  const headers = new Headers(req.headers);
  headers.set("host", backend.host);
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
  };
  if (req.body) init.duplex = "half";
  const res = await fetch(target, init);
  // Rebuild headers, rewriting Set-Cookie so cookies bind to the proxy origin over
  // http (drop Domain and Secure — the backend sets them for its own loopback host).
  const outHeaders = new Headers(res.headers);
  outHeaders.delete("set-cookie");
  for (const c of res.headers.getSetCookie?.() ?? []) {
    outHeaders.append(
      "set-cookie",
      c.replace(/;\s*Domain=[^;]+/i, "").replace(/;\s*Secure\b/i, ""),
    );
  }
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

/**
 * Read the upgrade request's subprotocols + Cookie BEFORE upgrading — after the socket is
 * taken over (or if the client already went away) `req.headers` can throw "Request closed".
 * The backend WS authenticates via the browser session COOKIE at handshake time; Deno's
 * built-in `WebSocket` client can't set request headers, so the upstream socket is opened
 * with `npm:ws`, which forwards the Cookie (and subprotocol) on the upgrade request.
 */
function upgradeHeaders(req: Request): { protocols: string[] | undefined; cookie: string | null } {
  try {
    const protocols = req.headers.get("sec-websocket-protocol")
      ?.split(",").map((s) => s.trim()).filter(Boolean);
    return { protocols, cookie: req.headers.get("cookie") };
  } catch {
    return { protocols: undefined, cookie: null }; // request already closed
  }
}

/** A close code the client socket accepts (1005/1006 and out-of-range codes → 1000). */
function safeCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000;
}

/** The two sockets being bridged plus the frames queued until upstream opens. */
interface WsBridge {
  client: WebSocket;
  upstream: NodeWebSocket;
  pending: (string | ArrayBufferLike)[];
  upstreamReady: boolean;
  up2c: number;
  c2up: number;
  dbg: boolean;
  label: string;
}

/** Relay upstream → client: flush the queue on open, forward frames, mirror close/error. */
function wireUpstream(b: WsBridge): void {
  const { upstream, client } = b;
  upstream.on("open", () => {
    b.upstreamReady = true;
    if (b.dbg) console.error(`[ws] upstream OPEN ${b.label}`);
    for (const m of b.pending) {
      try {
        upstream.send(m);
      } catch { /* dropped */ }
    }
    b.pending.length = 0;
  });
  // deno-lint-ignore no-explicit-any
  upstream.on("message", (data: any, isBinary: boolean) => {
    b.up2c++;
    try {
      client.send(isBinary ? new Uint8Array(data.buffer ?? data) : data.toString());
    } catch { /* client gone */ }
  });
  // deno-lint-ignore no-explicit-any
  upstream.on("close", (code: number, reason: any) => {
    const text = reason?.toString?.() ?? "";
    if (b.dbg) {
      console.error(
        `[ws] upstream CLOSE code=${code} reason="${text}" up2c=${b.up2c} c2up=${b.c2up}`,
      );
    }
    try {
      client.close(safeCloseCode(code), text);
    } catch { /* already closed */ }
  });
  // deno-lint-ignore no-explicit-any
  upstream.on("error", (e: any) => {
    if (b.dbg) console.error(`[ws] upstream ERROR`, e?.message ?? e);
    try {
      client.close();
    } catch { /* already closed */ }
  });
}

/** Relay client → upstream (queued until upstream opens); a client close/error closes upstream. */
function wireClient(b: WsBridge): void {
  const { upstream, client } = b;
  const closeUpstream = () => {
    try {
      upstream.close();
    } catch { /* already closed */ }
  };
  client.onmessage = (e: MessageEvent) => {
    b.c2up++;
    if (!b.upstreamReady) {
      b.pending.push(e.data);
      return;
    }
    try {
      upstream.send(e.data);
    } catch { /* upstream gone */ }
  };
  client.onclose = (e: CloseEvent) => {
    if (b.dbg) console.error(`[ws] client CLOSE code=${e.code} up2c=${b.up2c} c2up=${b.c2up}`);
    closeUpstream();
  };
  client.onerror = closeUpstream;
}

function proxyWebSocket(req: Request, url: URL, backend: URL): Response {
  const { protocols, cookie } = upgradeHeaders(req);
  const { socket: client, response } = Deno.upgradeWebSocket(
    req,
    protocols?.length ? { protocol: protocols[0] } : undefined,
  );
  const backendWs = new URL(url.pathname + url.search, backend);
  backendWs.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
  const dbg = !!Deno.env.get("DENEXT_PROXY_DEBUG");
  if (dbg) {
    console.error(
      `[ws] ${url.pathname}${url.search} proto=${protocols?.join(",") ?? "-"} cookie=${!!cookie}`,
    );
  }
  const headers: Record<string, string> = { host: backend.host, origin: backend.origin };
  if (cookie) headers.cookie = cookie;
  const upstream = new NodeWebSocket(backendWs.toString(), protocols, { headers });
  // Binary frames (msgpackr etc.) must arrive as ArrayBuffers so they can be relayed
  // verbatim; the Deno default (Blob) can't be forwarded synchronously.
  client.binaryType = "arraybuffer";
  const bridge: WsBridge = {
    client,
    upstream,
    pending: [],
    upstreamReady: false,
    up2c: 0,
    c2up: 0,
    dbg,
    label: backendWs.pathname,
  };
  wireUpstream(bridge);
  wireClient(bridge);
  return response;
}
