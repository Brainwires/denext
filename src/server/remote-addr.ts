/**
 * The peer address `Deno.serve` reported for a request, remembered per `Request` so
 * server code (the auth rate limiter, custom loggers) can key on the real socket peer
 * instead of a forwarded header anyone can set — and the one place that decides whether an
 * address is a loopback/private peer (plausibly a proxy) for per-address limits.
 *
 * @module
 */

const addrs = new WeakMap<Request, string>();

/**
 * For a request whose client address was recorded already resolved ({@link setClientAddr}: a
 * Live connection's synthetic requests), the address to key per-address limits on — `null` when
 * the connection came from an untrusted proxy-looking peer. Absent for a server-loop request.
 */
const limitAddrs = new WeakMap<Request, string | null>();

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
 * @param limitIp The address its per-address limits key on ({@link limitAddrOf} of the upgrade
 *   request) — `undefined` when they are off for it.
 */
export function setClientAddr(
  request: Request,
  ip: string | undefined,
  limitIp: string | undefined,
): void {
  if (ip !== undefined) addrs.set(request, ip);
  limitAddrs.set(request, limitIp ?? null);
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

/**
 * The address to key a **per-address limit** on (a connection cap, a signed-out quota): the client
 * address {@link clientAddrOf} answers — unless that is the socket peer (no trusted forwarded hop)
 * and the peer is a loopback, private, link-local or unique-local address
 * ({@link isLocalAddress}). Such a peer is most likely a reverse proxy the app does not trust, so
 * every visitor would share its address and its limit; the limit is skipped instead
 * (`undefined`). A directly connected public peer, and a trusted proxy's hop, keep it.
 *
 * @param request The incoming request (or a Live connection's synthetic one).
 * @param trustForwardedHeaders Whether the app trusts its fronting proxy.
 * @returns The address to limit on, or `undefined` when per-address limits do not apply.
 */
export function limitAddrOf(request: Request, trustForwardedHeaders: boolean): string | undefined {
  const resolved = limitAddrs.get(request);
  if (resolved !== undefined) return resolved ?? undefined;
  const hop = trustForwardedHeaders ? lastForwardedHop(request) : undefined;
  if (hop) return hop;
  const peer = remoteAddrOf(request);
  return peer === undefined || isLocalAddress(peer) ? undefined : peer;
}

/** Copy the remembered peer of `from` onto `to` (a Request rebuilt from it). */
export function copyRemoteAddr(from: Request, to: Request): void {
  const addr = addrs.get(from);
  if (addr !== undefined) addrs.set(to, addr);
  const limit = limitAddrs.get(from);
  if (limit !== undefined) limitAddrs.set(to, limit);
}

/**
 * Parse an IPv6 literal into its eight 16-bit hextets, or `null` when it is not one.
 * Expands `::`, accepts a trailing embedded IPv4 (`::ffff:1.2.3.4`) and strips a zone id
 * (`%eth0`) — so every spelling of one address decodes to the same groups.
 */
export function parseIPv6Groups(input: string): number[] | null {
  const s = input.toLowerCase().split("%")[0];
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = parseHextets(halves[0]);
  const tail = halves.length === 2 ? parseHextets(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 0 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** One `:`-separated run of hextets (a trailing dotted IPv4 counts as two), or `null`. */
function parseHextets(part: string): number[] | null {
  if (part === "") return [];
  const tokens = part.split(":");
  const groups: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.includes(".")) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      groups.push(parseInt(token, 16));
      continue;
    }
    if (i !== tokens.length - 1) return null; // an embedded IPv4 may only trail
    const octets = token.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
  }
  return groups;
}

/** Whether a dotted IPv4 is loopback, RFC 1918 private or link-local (169.254/16). */
function isLocalIPv4(ip: string): boolean {
  const [p, q] = ip.split(".").map(Number);
  return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) ||
    (p === 192 && q === 168) || (p === 169 && q === 254);
}

/**
 * Whether an address is a loopback, private, link-local or unique-local one (`127.0.0.0/8`,
 * `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`) — as a socket
 * peer, plausibly a reverse proxy on the same host or network rather than a real client. An
 * IPv4-mapped IPv6 peer (`::ffff:10.0.0.1`) is judged on the IPv4 it carries, so a mapped PUBLIC
 * address is not mistaken for a local one. This is the one place that decision is made: the auth
 * rate limiter's undeclared-proxy check and the per-address limits ({@link limitAddrOf}) use it.
 *
 * @param addr An IP address (IPv6 optionally bracketed).
 * @returns Whether it is a local address.
 */
export function isLocalAddress(addr: string): boolean {
  const trimmed = addr.trim().replace(/^\[|\]$/g, "");
  if (!trimmed.includes(":")) return isLocalIPv4(trimmed);
  const g = parseIPv6Groups(trimmed);
  if (!g) return false;
  const topZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (topZero && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // ::1
  if (topZero && (g[5] === 0xffff || g[5] === 0)) {
    return isLocalIPv4(`${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`);
  }
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}
