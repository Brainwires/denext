/**
 * The peer address `Deno.serve` reported for a request, remembered per `Request` so
 * server code (the auth rate limiter, custom loggers) can key on the real socket peer
 * instead of a forwarded header anyone can set.
 *
 * @module
 */

const addrs = new WeakMap<Request, string>();

/** Remember the socket peer for `request` (called once by the server loop). */
export function setRemoteAddr(request: Request, addr: Deno.Addr | undefined): void {
  if (addr && "hostname" in addr) addrs.set(request, addr.hostname);
}

/**
 * The socket peer address of `request` (an IP), or `undefined` when the request did not
 * arrive through denext's own server loop (tests, embedders that call the handler directly).
 */
export function remoteAddrOf(request: Request): string | undefined {
  return addrs.get(request);
}

/**
 * The last `x-forwarded-for` hop — the address the nearest trusted proxy saw the connection
 * come from. Earlier hops are client-supplied and must not be trusted. Call this ONLY when the
 * app trusts the proxy (`trustForwardedHeaders`); otherwise the socket peer is the client.
 *
 * @param request The incoming request.
 * @returns The last non-empty hop, or `undefined` when the header is absent or empty.
 */
function lastForwardedHop(request: Request): string | undefined {
  const hops = request.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim());
  return hops?.filter(Boolean).at(-1);
}

/**
 * Record `ip` as the client address of a synthetic request built for a long-lived connection
 * (a Live socket's re-renders and policy hooks), so `clientIp()` inside them answers the address
 * the upgrade request came from. The address is already resolved (proxy trust applied).
 *
 * @param request The synthetic request.
 * @param ip The connection's client address, or `undefined` to record none.
 */
export function setClientAddr(request: Request, ip: string | undefined): void {
  if (ip !== undefined) addrs.set(request, ip);
}

/**
 * The client address of a request as `clientIp()` answers it: the last `x-forwarded-for` hop
 * when the proxy is trusted (and the header carries one), else the socket peer.
 *
 * @param request The incoming request.
 * @param trustForwardedHeaders Whether the app trusts its fronting proxy.
 * @returns The client address, or `undefined` when none is known.
 */
export function clientAddrOf(request: Request, trustForwardedHeaders: boolean): string | undefined {
  return (trustForwardedHeaders ? lastForwardedHop(request) : undefined) ?? remoteAddrOf(request);
}

/** Copy the remembered peer of `from` onto `to` (a Request rebuilt from it). */
export function copyRemoteAddr(from: Request, to: Request): void {
  const addr = addrs.get(from);
  if (addr !== undefined) addrs.set(to, addr);
}
