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
export function lastForwardedHop(request: Request): string | undefined {
  const hops = request.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim());
  return hops?.filter(Boolean).at(-1);
}

/** Copy the remembered peer of `from` onto `to` (a Request rebuilt from it). */
export function copyRemoteAddr(from: Request, to: Request): void {
  const addr = addrs.get(from);
  if (addr !== undefined) addrs.set(to, addr);
}
