// Connection caps for the long-lived GraphQL transports — a WebSocket, and a streamed (SSE or
// multipart) response — mirroring the Live socket's `maxConnections` / `maxConnectionsPerIp`:
// a total, and a per-address cap keyed on `clientIpForLimits({ bucket: true })` (so a
// loopback/private peer behind an untrusted proxy counts only against the total, a trusted
// proxy's hop or the `rateLimitHeader` address is the client, and an IPv6 client is its /64).
// Internal: `mod.ts` takes a slot before the upgrade / the response and releases it when the
// socket closes or the stream ends, whichever way that happens.

import { clientIpForLimits } from "@denext/denext/server";

/** Live's defaults (`live.limits`), used when the app sets none. */
const DEFAULT_MAX_CONNECTIONS = 10_000;
/** Live's default per-address cap. */
const DEFAULT_MAX_CONNECTIONS_PER_IP = 64;

/** The caps a limiter enforces. */
export interface ConnectionCaps {
  /** Open connections across every client. */
  maxConnections: number;
  /** Open connections from one address (bucket). */
  maxConnectionsPerIp: number;
}

/** A positive finite number, else `undefined`. */
function cap(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * The caps for this app: the plugin's own options, else the app's `live.limits`, else Live's
 * defaults — one budget shape for both push transports.
 */
export function resolveCaps(
  own: { maxConnections?: number; maxConnectionsPerIp?: number },
  live: { maxConnections?: number; maxConnectionsPerIp?: number } | undefined,
): ConnectionCaps {
  return {
    maxConnections: cap(own.maxConnections) ?? cap(live?.maxConnections) ??
      DEFAULT_MAX_CONNECTIONS,
    maxConnectionsPerIp: cap(own.maxConnectionsPerIp) ?? cap(live?.maxConnectionsPerIp) ??
      DEFAULT_MAX_CONNECTIONS_PER_IP,
  };
}

/** The address bucket the current request is limited on, or `undefined` (total cap only). */
function limitKey(): string | undefined {
  try {
    return clientIpForLimits({ bucket: true });
  } catch {
    return undefined; // outside a request context: nothing to key on
  }
}

/** Counts open connections; `acquire` refuses past a cap. */
export interface ConnectionLimiter {
  /**
   * Take a slot for the current request: a release function (idempotent), or the refusal to
   * send instead of upgrading / streaming.
   */
  acquire(): (() => void) | Response;
  /** Open connections now (tests). */
  readonly open: number;
}

/**
 * A limiter over `caps` (read on every acquire, so a dev reload of the options would apply).
 *
 * @param caps The caps.
 * @returns The limiter.
 */
export function createConnectionLimiter(caps: () => ConnectionCaps): ConnectionLimiter {
  let open = 0;
  const perIp = new Map<string, number>();
  return {
    get open() {
      return open;
    },
    acquire() {
      const { maxConnections, maxConnectionsPerIp } = caps();
      if (open >= maxConnections) return refusal("too many connections");
      const key = limitKey();
      if (key !== undefined && (perIp.get(key) ?? 0) >= maxConnectionsPerIp) {
        return refusal("too many connections from this address");
      }
      open++;
      if (key !== undefined) perIp.set(key, (perIp.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        open--;
        if (key === undefined) return;
        const n = (perIp.get(key) ?? 1) - 1;
        if (n > 0) perIp.set(key, n);
        else perIp.delete(key);
      };
    },
  };
}

/** The refusal: a 429 before any upgrade or stream (Live sends no `Retry-After`; nor do we). */
function refusal(message: string): Response {
  return new Response(message, { status: 429 });
}

/**
 * `response` with its body wrapped so `release` runs once the stream ends, errors or is
 * cancelled (a client disconnect, a schema reload completing the subscription) — or at once when
 * it has no body.
 */
export function releaseWhenDone(response: Response, release: () => void): Response {
  const body = response.body;
  if (!body) {
    release();
    return response;
  }
  const reader = body.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Does this request ask for a streamed (SSE / multipart) GraphQL response? */
export function wantsStream(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return /text\/event-stream|multipart\/mixed/i.test(accept);
}
