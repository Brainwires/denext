/**
 * iOS's Local Network permission, as `denext/mobile` reports it. Until the user answers iOS's
 * Local Network prompt (iOS 14+), a request to a host on the local network fails with
 * `NSURLErrorNotConnectedToInternet` (-1009, "The Internet connection appears to be offline"),
 * which reads like the phone being offline. When the OTA check or a file transfer sees that
 * error against a private-range host, its message gets {@linkcode LOCAL_NETWORK_HINT}.
 *
 * Internal: not re-exported from `denext/mobile`.
 *
 * @module
 */

/** The hint added to a -1009 failure against a local-network host. */
export const LOCAL_NETWORK_HINT = "iOS may be blocking local-network access: allow it in " +
  "Settings → Privacy & Security → Local Network → this app";

/** An IPv4 address's four octets, or null when `host` is not a dotted quad. */
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/** Whether an IPv4 address is RFC 1918 private (10/8, 172.16/12, 192.168/16) or link-local. */
function isLocalIpv4([a, b]: number[]): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

/** The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` / `::ffff:XXXX:XXXX`) holds. */
function mappedIpv4(host: string): number[] | null {
  const m = /^::ffff:(.+)$/.exec(host);
  if (!m) return null;
  const dotted = ipv4(m[1]);
  if (dotted) return dotted;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(m[1]);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

/** Whether an IPv6 address is link-local (`fe80::/10`) or unique-local (`fc00::/7`). */
function isLocalIpv6(host: string): boolean {
  const mapped = mappedIpv4(host);
  if (mapped) return isLocalIpv4(mapped);
  if (!host.includes(":")) return false;
  return /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
}

/**
 * Whether `host` is on the local network as iOS's Local Network permission sees it: an
 * RFC 1918 address (`10/8`, `172.16/12`, `192.168/16`), a link-local one (`169.254/16`,
 * `fe80::/10`), a unique-local IPv6 one (`fc00::/7`), or a `.local` (mDNS) name. Loopback is
 * not: the device itself needs no permission.
 *
 * @param host A URL's hostname (IPv6 with or without brackets).
 * @returns Whether it is a local-network host.
 */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const v4 = ipv4(h);
  if (v4) return isLocalIpv4(v4);
  if (isLocalIpv6(h)) return true;
  return h.endsWith(".local") && h.length > ".local".length;
}

/** The text of iOS's -1009 error, as a message or a native description carries it. */
const OFFLINE_TEXT =
  /internet connection appears to be offline|NSURLErrorNotConnectedToInternet|(^|[^\d])-1009(?!\d)/i;

/**
 * Whether `err` is iOS's `NSURLErrorNotConnectedToInternet` (-1009): by its message (the
 * localized description, a `NSURLErrorDomain Code=-1009` dump), its `code`, or its `cause`.
 *
 * @param err A thrown value, a plugin rejection, or a message.
 * @returns Whether it is the -1009 error.
 */
export function isOfflineError(err: unknown): boolean {
  for (let e = err, depth = 0; e != null && depth < 3; depth++) {
    if (typeof e === "string") return OFFLINE_TEXT.test(e);
    const { message, code, cause } = e as { message?: unknown; code?: unknown; cause?: unknown };
    if (code === -1009 || code === "-1009") return true;
    if (typeof message === "string" && OFFLINE_TEXT.test(message)) return true;
    e = cause;
  }
  return false;
}

/**
 * `message` with {@linkcode LOCAL_NETWORK_HINT} appended, when `err` is the -1009 error and
 * `url` names a local-network host; otherwise (or when the hint is there already) unchanged.
 *
 * @param message The failure's message.
 * @param url The URL the request went to.
 * @param err The failure (its message, code or cause is checked).
 * @returns The message, hinted where it applies.
 */
export function withLocalNetworkHint(message: string, url: string, err: unknown): string {
  if (message.includes(LOCAL_NETWORK_HINT) || !isOfflineError(err)) return message;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return message;
  }
  return isLocalNetworkHost(host) ? `${message} (${LOCAL_NETWORK_HINT})` : message;
}
