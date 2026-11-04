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

/** The origin the server that received a request listens on, as this machine reaches it. */
const serverOrigins = new WeakMap<Request, string>();

/** When the server loop's response to a request was delivered (or failed to be). */
const completions = new WeakMap<Request, Promise<void>>();

/**
 * Remember when the response to `request` is done (`Deno.serve`'s `info.completed`; called once
 * by the server loop): it resolves once the response is delivered and rejects when it is not.
 */
export function setResponseCompletion(request: Request, completed: Promise<void> | undefined) {
  if (completed) completions.set(request, completed);
}

/** The completion {@link setResponseCompletion} recorded for `request`, or `undefined`. */
export function responseCompletionOf(request: Request): Promise<void> | undefined {
  return completions.get(request);
}

/**
 * The origin a client on this machine reaches a server bound to `addr` on: its address, with a
 * wildcard bind (`0.0.0.0` / `::`) as the loopback address and an IPv6 one bracketed.
 *
 * @param addr The address `Deno.serve` bound.
 * @param scheme `https` for a server that serves TLS (`start.tls`).
 * @returns `<scheme>://<host>:<port>`, or `undefined` for a non-TCP address (a Unix socket).
 */
export function loopbackOrigin(
  addr: Deno.Addr,
  scheme: "http" | "https" = "http",
): string | undefined {
  if (!("hostname" in addr) || !("port" in addr)) return undefined;
  const host = addr.hostname === "0.0.0.0"
    ? "127.0.0.1"
    : addr.hostname === "::"
    ? "::1"
    : addr.hostname;
  return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;
}

/**
 * Remember the origin the server that received `request` listens on (called once by the server
 * loop): never derived from the request's own headers.
 */
export function setServerOrigin(request: Request, origin: string | undefined): void {
  if (origin !== undefined) serverOrigins.set(request, origin);
}

/** The origin {@link setServerOrigin} recorded for `request`, or `undefined`. */
export function serverOriginOf(request: Request): string | undefined {
  return serverOrigins.get(request);
}

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
 * How per-address limits pick their address beyond proxy trust — the app's
 * `rateLimitHeader` / `rateLimitTrustedProxies` / `rateLimitLocalAddresses` (or
 * `DENEXT_RATE_LIMIT_HEADER` / `DENEXT_RATE_LIMIT_TRUSTED_PROXIES` /
 * `DENEXT_RATE_LIMIT_LOCAL_ADDRESSES=1`), resolved once by {@link resolveLimitPolicy}.
 */
export interface LimitAddrPolicy {
  /**
   * A lower-cased header a fronting proxy sets to the client address (`cf-connecting-ip`,
   * `fly-client-ip`, `x-real-ip`), keyed on in preference to everything else — but only on a
   * request whose socket peer is a trusted proxy ({@link limitAddrOf}). Absent: none.
   */
  header?: string;
  /**
   * The socket peers whose {@link header} is believed (parsed CIDRs). Empty or absent: a
   * loopback/private peer when the app trusts its proxy (`trustForwardedHeaders`), else none.
   */
  trustedProxies?: readonly Cidr[];
  /** Count a loopback/private socket peer by its own address instead of skipping the limit. */
  localAddresses?: boolean;
}

/** The app settings {@link resolveLimitPolicy} reads. */
export interface LimitPolicySettings {
  /** The header naming the client address. */
  rateLimitHeader?: string;
  /** CIDRs (or bare addresses) of the proxies whose header is believed. */
  rateLimitTrustedProxies?: readonly string[];
  /** Count a loopback/private peer by its own address. */
  rateLimitLocalAddresses?: boolean;
  /** Whether the app trusts its fronting proxy (only for the startup warning). */
  trustForwardedHeaders?: boolean;
}

/**
 * The {@link LimitAddrPolicy} for the app's settings: the header trimmed and lower-cased (an empty
 * one is none), the trusted proxies parsed (an entry that is not a CIDR is dropped — the config
 * validator and the env reader report it), the local-addresses switch as a boolean.
 *
 * A header with no rule to trust it (neither `rateLimitTrustedProxies` nor
 * `trustForwardedHeaders`) is never believed, and a warning says so once per process.
 *
 * @param settings The app's `rateLimitHeader` / `rateLimitTrustedProxies` /
 *   `rateLimitLocalAddresses` (and `trustForwardedHeaders`).
 * @returns The policy {@link limitAddrOf} takes.
 */
export function resolveLimitPolicy(settings: LimitPolicySettings): LimitAddrPolicy {
  const header = settings.rateLimitHeader?.trim().toLowerCase();
  const trustedProxies = (settings.rateLimitTrustedProxies ?? [])
    .map(parseCidr)
    .filter((cidr): cidr is Cidr => cidr !== null);
  if (header && trustedProxies.length === 0 && settings.trustForwardedHeaders !== true) {
    warnUntrustedHeaderConfigOnce(header);
  }
  return {
    ...(header ? { header } : {}),
    ...(trustedProxies.length > 0 ? { trustedProxies } : {}),
    ...(settings.rateLimitLocalAddresses === true ? { localAddresses: true } : {}),
  };
}

/** Whether {@link warnUntrustedHeaderConfigOnce} has logged (once per process). */
let warnedUntrustedHeaderConfig = false;

/** Tell the operator once that the configured limit header has no rule to trust it. */
function warnUntrustedHeaderConfigOnce(header: string): void {
  if (warnedUntrustedHeaderConfig) return;
  warnedUntrustedHeaderConfig = true;
  console.warn(
    `denext: rateLimitHeader (\`${header}\`) is ignored: per-address limits believe it only from a ` +
      "trusted proxy. Set rateLimitTrustedProxies (DENEXT_RATE_LIMIT_TRUSTED_PROXIES) to the " +
      "proxy's address ranges, or trustForwardedHeaders (DENEXT_TRUST_PROXY=1) when the proxy " +
      "connects from a loopback/private address.",
  );
}

/** Whether the socket `peer` of a request is a proxy whose limit header is believed. */
function headerTrusted(
  peer: string | undefined,
  trustForwardedHeaders: boolean,
  policy: LimitAddrPolicy,
): boolean {
  const proxies = policy.trustedProxies ?? [];
  // An in-process request (a handler called directly) has no socket to check: it is believed
  // only when the app declares some trust rule at all.
  if (peer === undefined) return proxies.length > 0 || trustForwardedHeaders;
  if (proxies.length > 0) return inCidrs(peer, proxies);
  return trustForwardedHeaders && isLocalAddress(peer);
}

/**
 * The address to key a **per-address limit** on (a connection cap, a signed-out quota):
 *
 * 1. the value of {@link LimitAddrPolicy.header} when the app names one, the request's socket peer
 *    is a trusted proxy (inside {@link LimitAddrPolicy.trustedProxies}, or — with none listed — a
 *    loopback/private address while `trustForwardedHeaders` is on), and the request carries an IP
 *    address in it (its LAST comma-separated value — the one the nearest proxy wrote), counted as
 *    it is, loopback/private or not (the operator vouched for the header). From any other peer
 *    the header is ignored (a client that can reach the server directly could otherwise pick a
 *    fresh limit bucket per request) and a warning says so once per process;
 * 2. else the client address {@link clientAddrOf} answers — unless that is the socket peer (no
 *    trusted forwarded hop) and the peer is a loopback, private, link-local or unique-local address
 *    ({@link isLocalAddress}) while {@link LimitAddrPolicy.localAddresses} is off. Such a peer is
 *    most likely a reverse proxy the app does not trust, so every visitor would share its address
 *    and its limit; the limit is skipped instead (`undefined`).
 *
 * A request without the named header (or with a value that is not an IP address) falls back to
 * step 2 — never to "no limit" — and a warning says so once per process (not for an in-process
 * request with no recorded socket peer): either the request reached the server without passing the
 * proxy that sets the header, or the proxy does not set it.
 *
 * @param request The incoming request (or a Live connection's synthetic one).
 * @param trustForwardedHeaders Whether the app trusts its fronting proxy.
 * @param policy The app's header / local-address settings (default: neither).
 * @returns The address to limit on, or `undefined` when per-address limits do not apply.
 */
export function limitAddrOf(
  request: Request,
  trustForwardedHeaders: boolean,
  policy: LimitAddrPolicy = {},
): string | undefined {
  const resolved = limitAddrs.get(request);
  if (resolved !== undefined) return resolved ?? undefined;
  const peer = remoteAddrOf(request);
  if (policy.header) {
    const named = headerAddr(request, policy.header);
    if (named && headerTrusted(peer, trustForwardedHeaders, policy)) return named;
    // An in-process request (no recorded peer: a handler called directly) is no proxy bypass.
    if (named) warnUntrustedLimitHeaderOnce(policy.header, peer);
    else if (peer !== undefined) warnMissingLimitHeaderOnce(policy.header);
  }
  const hop = trustForwardedHeaders ? lastForwardedHop(request) : undefined;
  if (hop) return hop;
  if (peer === undefined) return undefined;
  return policy.localAddresses || !isLocalAddress(peer) ? peer : undefined;
}

/**
 * The IP address in `header` of `request`: its last non-empty comma-separated value (a proxy that
 * appends rather than overwrites puts its own last; anything before it came from the client),
 * unbracketed — or `undefined` when the header is absent or that value is not an IPv4 / IPv6
 * literal.
 */
function headerAddr(request: Request, header: string): string | undefined {
  const last = request.headers.get(header)?.split(",").map((v) => v.trim()).filter(Boolean).at(-1);
  const addr = last?.replace(/^\[|\]$/g, "");
  return addr !== undefined && isIpLiteral(addr) ? addr : undefined;
}

/** Whether `addr` is a dotted IPv4 address or an IPv6 literal (optionally with a zone id). */
function isIpLiteral(addr: string): boolean {
  if (addr.includes(":")) return parseIPv6Groups(addr) !== null;
  const octets = addr.split(".");
  return octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

/** Whether {@link warnMissingLimitHeaderOnce} has logged (once per process). */
let warnedMissingLimitHeader = false;

/**
 * Tell the operator once that a request lacked the configured limit header (or carried no IP
 * address in it), so its limits fell back to the socket peer / trusted hop.
 */
function warnMissingLimitHeaderOnce(header: string): void {
  if (warnedMissingLimitHeader) return;
  warnedMissingLimitHeader = true;
  console.warn(
    `denext: a request carried no IP address in \`${header}\` (rateLimitHeader / ` +
      "DENEXT_RATE_LIMIT_HEADER), so its per-address limits key on the trusted x-forwarded-for " +
      "hop or the socket peer instead (a loopback/private peer stays unlimited unless " +
      "rateLimitLocalAddresses is on). Either the request reached the server without passing " +
      "the proxy, or the proxy does not set that header.",
  );
}

/** Whether {@link warnUntrustedLimitHeaderOnce} has logged (once per process). */
let warnedUntrustedLimitHeader = false;

/** Tell the operator once that a request's limit header came from a peer that is not trusted. */
function warnUntrustedLimitHeaderOnce(header: string, peer: string | undefined): void {
  if (warnedUntrustedLimitHeader) return;
  warnedUntrustedLimitHeader = true;
  console.warn(
    `denext: ignored \`${header}\` (rateLimitHeader) on a request from ${
      peer ?? "an in-process caller"
    }, which is not a trusted proxy; its per-address limits key on the socket peer / trusted ` +
      "x-forwarded-for hop instead. List the proxy's ranges in rateLimitTrustedProxies " +
      "(DENEXT_RATE_LIMIT_TRUSTED_PROXIES), or set trustForwardedHeaders when it connects from " +
      "a loopback/private address.",
  );
}

/** Forget the once-per-process limit-header warnings (tests). */
export function resetLimitHeaderWarningForTesting(): void {
  warnedMissingLimitHeader = false;
  warnedUntrustedLimitHeader = false;
  warnedUntrustedHeaderConfig = false;
}

/** A parsed CIDR range: the network's bytes (4 for IPv4, 16 for IPv6) and its prefix length. */
export interface Cidr {
  /** The address bytes. */
  readonly bytes: readonly number[];
  /** The prefix length in bits. */
  readonly prefix: number;
}

/**
 * An IP address as bytes — 4 for IPv4, 16 for IPv6, with an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`, how a dual-stack listener reports an IPv4 peer) as its IPv4 — or `null`.
 */
function addrBytes(addr: string): number[] | null {
  const trimmed = addr.trim().replace(/^\[|\]$/g, "");
  if (!trimmed.includes(":")) {
    return isIpLiteral(trimmed) ? trimmed.split(".").map(Number) : null;
  }
  const g = parseIPv6Groups(trimmed);
  if (!g) return null;
  if (g.slice(0, 6).join(":") === "0:0:0:0:0:65535") {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  }
  return g.flatMap((h) => [h >> 8, h & 255]);
}

/**
 * Parse a CIDR range (`173.245.48.0/20`, `2400:cb00::/32`) or a bare address (a single host),
 * or `null` when it is neither.
 *
 * @param text The range.
 * @returns The parsed range, or `null`.
 */
export function parseCidr(text: string): Cidr | null {
  const [addr, bits, extra] = text.trim().split("/");
  if (extra !== undefined) return null;
  const bytes = addrBytes(addr);
  if (!bytes) return null;
  const max = bytes.length * 8;
  if (bits === undefined) return { bytes, prefix: max };
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null;
  return { bytes, prefix: Number(bits) };
}

/**
 * Whether `addr` is inside any of `ranges` (an IPv4 address never matches an IPv6 range, except
 * an IPv4-mapped one, which is its IPv4).
 *
 * @param addr An IP address.
 * @param ranges Parsed ranges.
 * @returns Whether one contains it.
 */
export function inCidrs(addr: string, ranges: readonly Cidr[]): boolean {
  const bytes = addrBytes(addr);
  return bytes !== null && ranges.some((range) => inCidr(bytes, range));
}

/** Whether address `bytes` fall inside `range`. */
function inCidr(bytes: readonly number[], range: Cidr): boolean {
  if (bytes.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.prefix; bit += 8) {
    const i = bit / 8;
    const mask = range.prefix - bit >= 8 ? 255 : (0xff << (8 - (range.prefix - bit))) & 255;
    if ((bytes[i] & mask) !== (range.bytes[i] & mask)) return false;
  }
  return true;
}

/** Copy the remembered peer of `from` onto `to` (a Request rebuilt from it). */
export function copyRemoteAddr(from: Request, to: Request): void {
  const addr = addrs.get(from);
  if (addr !== undefined) addrs.set(to, addr);
  const limit = limitAddrs.get(from);
  if (limit !== undefined) limitAddrs.set(to, limit);
  const origin = serverOrigins.get(from);
  if (origin !== undefined) serverOrigins.set(to, origin);
}

/**
 * Parse an IPv6 literal into its eight 16-bit hextets, or `null` when it is not one.
 * Expands `::`, accepts a trailing embedded IPv4 (`::ffff:1.2.3.4`) and strips a zone id
 * (`%eth0`) — so every spelling of one address decodes to the same groups.
 */
function parseIPv6Groups(input: string): number[] | null {
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

/**
 * The limiter bucket for a client address.
 *
 * IPv4 is used as-is. **IPv6 is normalised and bucketed by /64**, for two reasons: the
 * same address has many spellings (`::1`, `0:0:0:0:0:0:0:1`, `[::1]`, `::0001`), each of
 * which used to open its own window, and a residential IPv6 allocation is at least a /64, so
 * keying on the full 128 bits hands one client an effectively unbounded supply of fresh buckets.
 *
 * An IPv4-mapped IPv6 address (`::ffff:198.51.100.7`, `::ffff:c633:6407`) is the IPv4 address it
 * carries — on a dual-stack listener every IPv4 client is reported that way, and their shared /64
 * would be one bucket for all of them. So is a NAT64 address (`64:ff9b::198.51.100.7`) and an
 * IPv4-compatible one (`::198.51.100.7`), for the same reason.
 *
 * An address that parses as neither is lower-cased and returned unchanged (it is already
 * whatever the socket peer or the trusted proxy said). The Live hub's per-address connection cap,
 * `rateLimit()` and `clientIpForLimits({ bucket: true })` key on it too.
 *
 * @param ip A client address.
 * @returns The bucket the address counts against.
 */
export function ipBucket(ip: string): string {
  const trimmed = ip.trim().replace(/^\[|\]$/g, "");
  if (!trimmed.includes(":")) return trimmed;
  const groups = parseIPv6Groups(trimmed);
  if (!groups) return trimmed.toLowerCase();
  // An IPv4-mapped address (a dual-stack listener's IPv4 client) is that IPv4 client: its /64
  // would be one bucket for every IPv4 visitor.
  if (embedsIPv4(groups)) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  // The /64 prefix: the four high hextets, hex, with the host half zeroed.
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * Whether an IPv6 address is an IPv4 client in IPv6 form, whose /64 would be one bucket for every
 * such client: IPv4-mapped (`::ffff:0:0/96`, a dual-stack listener's IPv4 peer), the NAT64
 * well-known prefix (`64:ff9b::/96`, RFC 6052 — a NAT64 gateway's IPv4 destination) and the
 * deprecated IPv4-compatible form (`::a.b.c.d`, except `::` and `::1`).
 */
function embedsIPv4(g: number[]): boolean {
  const prefix = g.slice(0, 6).join(":");
  if (prefix === "0:0:0:0:0:65535" || prefix === NAT64_PREFIX) return true;
  return prefix === "0:0:0:0:0:0" && (g[6] !== 0 || g[7] > 1); // IPv4-compatible, not :: / ::1
}

/** The first six hextets of the NAT64 well-known prefix `64:ff9b::/96`, as {@link embedsIPv4} joins them. */
const NAT64_PREFIX = "100:65435:0:0:0:0";

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
