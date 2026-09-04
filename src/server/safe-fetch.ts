// SSRF-safe HTTP GET with DNS-rebinding protection.
//
// The problem: validating a URL's hostname string and then handing it to
// `fetch()` leaves a gap — `fetch()` resolves DNS itself, at connect time, and we
// never see the IP. An allowlisted name whose DNS points at an internal address
// (169.254.169.254, 127.0.0.1, 10.0.0.0/8, …), or one that "rebinds" to such an
// address between check and use, reaches internal services.
//
// The fix here pins the connection to a validated address: resolve the host
// ourselves, reject if ANY returned A/AAAA record is private/loopback/link-local,
// then connect to that exact IP while sending the original Host header + TLS SNI
// (so certificate validation still works and there is no second, rebindable
// resolution). A minimal HTTP/1.1 GET client reads the response under a byte cap.
//
// The socket + resolver are injectable so the whole path is unit-testable without
// real network access.

/** True for a hostname/IP that must never be fetched (loopback/private/etc.). */
export function isForbiddenAddress(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.startsWith("[") || h.includes(":")) {
    return isForbiddenIPv6(h.replace(/^\[|\]$/g, ""));
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isForbiddenIPv4(h);
  return false;
}

function isForbiddenIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 || // this-network, private, loopback
    (a === 169 && b === 254) || // link-local (incl. cloud metadata 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 192 && b === 0) || // IETF protocol assignments (incl. 192.0.0.0/24)
    a >= 224 // multicast (224/4) + reserved (240/4) + broadcast
  );
}

/**
 * Parse an IPv6 literal into its 8 16-bit hextets, or `null` if malformed. Expands
 * `::`, accepts a trailing embedded IPv4 (`::ffff:127.0.0.1`), and strips a zone id
 * (`%eth0`). Normalizing to hextets is what defeats the string-prefix bypass — the
 * dotted `::ffff:127.0.0.1` and the hex `::ffff:7f00:1` decode to identical groups.
 */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct); // drop zone id

  const halves = s.split("::");
  if (halves.length > 2) return null; // at most one "::"

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const tokens = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes(".")) {
        if (i !== tokens.length - 1) return null; // embedded IPv4 only trails
        const v4 = tok.split(".").map(Number);
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null;
        }
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        groups.push(parseInt(tok, 16));
      }
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null; // no "::"
  const tail = parseGroups(halves[1]);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

function isForbiddenIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (g === null) return true; // unparseable → refuse (fail closed)
  if (g.every((h) => h === 0)) return true; // :: unspecified
  const embedded = embeddedIPv4(g);
  if (embedded === "loopback") return true;
  if (embedded) return isForbiddenIPv4(embedded);
  const hi = (g[0] >> 8) & 255;
  if (hi === 0xfc || hi === 0xfd) return true; // unique-local fc00::/7
  return (g[0] & 0xffc0) === 0xfe80; // link-local fe80::/10
}

/**
 * The IPv4 carried in the low 32 bits of a `::1` loopback, IPv4-mapped `::ffff:0:0/96`,
 * deprecated IPv4-compatible `::/96`, or NAT64 `64:ff9b::/96` address — `"loopback"` for
 * `::1`, the dotted IPv4 for the embedding prefixes, null for a plain IPv6 address.
 */
function embeddedIPv4(g: number[]): string | "loopback" | null {
  const topZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (topZero && g[5] === 0 && g[6] === 0 && g[7] === 1) return "loopback";
  const nat64 = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 &&
    g[5] === 0;
  if ((topZero && (g[5] === 0xffff || g[5] === 0)) || nat64) {
    return `${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`;
  }
  return null;
}

/** True if `host` is an IP literal (skip DNS resolution). */
function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Resolves a hostname to its IP addresses (A + AAAA). */
export type Resolver = (hostname: string) => Promise<string[]>;

/** Opens a connection to a pinned IP and returns the full raw HTTP response bytes. */
export type Transport = (opts: {
  ip: string;
  port: number;
  tls: boolean;
  /** Original hostname — for the `Host` header and TLS SNI/cert validation. */
  hostname: string;
  request: Uint8Array;
  maxBytes: number;
  signal?: AbortSignal | null;
}) => Promise<Uint8Array>;

const defaultResolver: Resolver = async (hostname) => {
  if (isIpLiteral(hostname)) return [hostname.replace(/^\[|\]$/g, "")];
  const out: string[] = [];
  for (const kind of ["A", "AAAA"] as const) {
    try {
      out.push(...await Deno.resolveDns(hostname, kind));
    } catch { /* no records of this kind */ }
  }
  return out;
};

/**
 * Await a pending `Deno.connect`, but reject as soon as `signal` aborts. Without
 * this the deadline/abort covers only the phases *after* connect — a blackholed
 * host would hang in the TCP handshake until the OS connect timeout (tens of
 * seconds), ignoring our signal (M1). If the abort wins, the socket the connect
 * eventually yields is closed so it can't leak.
 *
 * Exported for direct unit testing of the connect-phase abort race; the socket
 * type is generic so tests can pass a minimal fake `{ close() }`.
 *
 * @param connecting The pending `Deno.connect` promise.
 * @param signal The abort/timeout signal, if any.
 * @returns The connected socket, or a rejection if the signal aborts first.
 */
export function connectWithAbort<T extends { close(): void }>(
  connecting: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return connecting;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error("aborted"));
      // The connect may still be in flight — close it once it lands.
      connecting.then((c) => {
        try {
          c.close();
        } catch { /* already closed */ }
      }).catch(() => {});
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    connecting.then(
      (c) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          try {
            c.close();
          } catch { /* already closed */ }
          return;
        }
        settled = true;
        resolve(c);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(err);
      },
    );
  });
}

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch { /* already closed */ }
}

/** TCP connect (abortable) and, for `tls`, the TLS handshake against `hostname`. */
async function openConnection(opts: Parameters<Transport>[0]): Promise<Deno.Conn> {
  const tcp = await connectWithAbort(
    Deno.connect({ hostname: opts.ip, port: opts.port }),
    opts.signal,
  );
  if (!opts.tls) return tcp;
  try {
    return await Deno.startTls(tcp, { hostname: opts.hostname });
  } catch (err) {
    closeQuietly(tcp);
    throw err;
  }
}

const defaultTransport: Transport = async (opts) => {
  throwIfAborted(opts.signal);
  const conn = await openConnection(opts);
  const onAbort = () => closeQuietly(conn);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(opts.signal);
    await writeAll(conn, opts.request);
    return await readToEnd(conn, opts.maxBytes);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    closeQuietly(conn);
  }
};

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new Error("aborted");
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let n = 0;
  while (n < data.length) n += await conn.write(data.subarray(n));
}

/** Read to EOF, refusing more than `maxBytes` of body (plus a header budget). */
async function readToEnd(conn: Deno.Conn, maxBytes: number): Promise<Uint8Array> {
  const limit = maxBytes + 64 * 1024; // room for the header block
  const chunks: Uint8Array[] = [];
  let total = 0;
  const buf = new Uint8Array(64 * 1024);
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
    total += n;
    if (total > limit) throw new Error("response too large");
  }
  return concatChunks(chunks, total);
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A parsed HTTP response: status, headers, and framed body bytes. */
export interface ParsedResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/**
 * Parse a raw HTTP/1.1 response (headers + body) into status/headers/body,
 * honoring `Transfer-Encoding: chunked` and `Content-Length` (else read-to-end).
 *
 * @param raw The full response bytes.
 */
export function parseHttpResponse(raw: Uint8Array): ParsedResponse {
  const sep = indexOfCRLFCRLF(raw);
  if (sep === -1) throw new Error("malformed HTTP response (no header terminator)");
  const { status, headers } = parseHeaderBlock(new TextDecoder().decode(raw.subarray(0, sep)));
  return { status, headers, body: frameBody(headers, raw.subarray(sep + 4)) };
}

/** The status line + header lines (an invalid header name is skipped). */
function parseHeaderBlock(headerText: string): { status: number; headers: Headers } {
  const lines = headerText.split("\r\n");
  const status = Number(lines[0]?.split(" ")[1]);
  if (!Number.isFinite(status)) throw new Error("malformed HTTP status line");
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx === -1) continue;
    try {
      headers.append(lines[i].slice(0, idx).trim(), lines[i].slice(idx + 1).trim());
    } catch { /* skip an invalid header name */ }
  }
  return { status, headers };
}

/**
 * Frame the body: `Transfer-Encoding: chunked` is de-chunked; a pure non-negative-integer
 * `Content-Length` truncates (the digit regex avoids JS's `Number("")` → 0, which would
 * empty the body, and `Number("0x10")` hex coercion); otherwise the body is everything to EOF.
 */
function frameBody(headers: Headers, body: Uint8Array): Uint8Array {
  if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    return dechunk(body);
  }
  const clHeader = headers.get("content-length");
  if (clHeader === null || !/^\d+$/.test(clHeader.trim())) return body;
  const len = Number(clHeader.trim());
  return Number.isFinite(len) && len < body.byteLength ? body.subarray(0, len) : body;
}

function indexOfCRLFCRLF(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

/** Decode a chunked transfer-encoded body. */
function dechunk(input: Uint8Array): Uint8Array {
  const dec = new TextDecoder();
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i < input.length) {
    let j = i;
    while (j + 1 < input.length && !(input[j] === 13 && input[j + 1] === 10)) j++;
    const size = parseInt(dec.decode(input.subarray(i, j)).trim().split(";")[0], 16);
    if (!Number.isFinite(size)) throw new Error("malformed chunk size");
    i = j + 2; // past CRLF
    if (size === 0) break;
    parts.push(input.subarray(i, i + size));
    i += size + 2; // data + trailing CRLF
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Redirect status codes followed (and re-validated) by {@linkcode safeFetch}. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// Headers we always control; a caller cannot override framing/host/encoding.
const MANAGED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
]);

/** Build a minimal HTTP/1.1 request (method + headers + optional buffered body). */
function buildRequest(
  url: URL,
  spec: { method: string; headers?: HeadersInit; body?: Uint8Array },
): Uint8Array {
  const path = (url.pathname || "/") + (url.search || "");
  const lines = [
    `${spec.method} ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    `Accept-Encoding: identity`, // no gzip → no decompression to handle
    `Connection: close`,
  ];
  let hasUA = false;
  let hasAccept = false;
  for (const [k, v] of new Headers(spec.headers)) {
    const lk = k.toLowerCase();
    if (MANAGED_HEADERS.has(lk)) continue;
    if (lk === "user-agent") hasUA = true;
    if (lk === "accept") hasAccept = true;
    lines.push(`${k}: ${v}`);
  }
  if (!hasUA) lines.push("User-Agent: denext");
  if (!hasAccept) lines.push("Accept: */*");
  if (spec.body) lines.push(`Content-Length: ${spec.body.byteLength}`);
  const head = new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n");
  if (!spec.body) return head;
  const out = new Uint8Array(head.byteLength + spec.body.byteLength);
  out.set(head, 0);
  out.set(spec.body, head.byteLength);
  return out;
}

/** Error codes surfaced by {@linkcode safeFetch}. */
export type SafeFetchErrorCode =
  | "unsupported-protocol"
  | "host-not-allowed"
  | "blocked-address"
  | "dns"
  | "network"
  | "bad-response"
  | "too-many-redirects";

/** Thrown by {@linkcode safeFetch}/pinned fetch when a request is refused or fails. */
export class SafeFetchError extends Error {
  /** Machine-readable reason. */
  readonly code: SafeFetchErrorCode;
  /**
   * Create a SafeFetchError.
   *
   * @param code Machine-readable reason ({@linkcode SafeFetchErrorCode}).
   * @param message Human-readable detail.
   */
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

/** Choose an address to connect to, preferring IPv4. */
function pickIp(ips: string[]): string {
  return ips.find((ip) => !ip.includes(":")) ?? ips[0];
}

/** Config for {@linkcode makePinnedFetch}. */
export interface PinnedFetchConfig {
  /** DNS resolver (defaults to `Deno.resolveDns`; injectable for tests). */
  resolver?: Resolver;
  /** Socket transport (defaults to `Deno.connect`/`startTls`; injectable for tests). */
  transport?: Transport;
  /** Max response body bytes. */
  maxBytes?: number;
  /**
   * **Dangerous.** Skip the resolved-address SSRF guard, allowing connections to
   * loopback/private/link-local IPs. Only for a trusted, isolated context (e.g. the
   * image optimizer's `dangerouslyAllowLocalIP`). Defaults to false.
   */
  allowLocalIP?: boolean;
}

/**
 * Build a `fetch`-shaped function that performs an SSRF-safe, DNS-rebinding-proof
 * request: resolve → validate every resolved IP → connect to the pinned IP
 * (original Host/SNI preserved) → read the response under a byte cap. The method,
 * headers, and body come from the `init` argument. Redirects are returned verbatim
 * (status + `Location`) for the caller to re-validate and follow. A refused or
 * failed request throws a {@linkcode SafeFetchError}; a real HTTP response (any
 * status) is returned.
 *
 * @param cfg Resolver/transport/size overrides.
 */
export function makePinnedFetch(
  cfg: PinnedFetchConfig = {},
): (url: URL, init: RequestInit) => Promise<Response> {
  const resolver = cfg.resolver ?? defaultResolver;
  const transport = cfg.transport ?? defaultTransport;
  const maxBytes = cfg.maxBytes ?? 25 * 1024 * 1024;
  const allowLocalIP = cfg.allowLocalIP === true;

  return async (url, init) => {
    assertHttpUrl(url);
    const tls = url.protocol === "https:";
    const port = url.port ? Number(url.port) : (tls ? 443 : 80);
    const ips = await resolvePinned(resolver, url.hostname, allowLocalIP);
    const method = (init.method ?? "GET").toUpperCase();
    let raw: Uint8Array;
    try {
      raw = await transport({
        ip: pickIp(ips),
        port,
        tls,
        hostname: url.hostname,
        request: buildRequest(url, { method, headers: init.headers, body: bodyBytes(init.body) }),
        maxBytes,
        signal: init.signal,
      });
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      throw new SafeFetchError("network", `request to ${url.hostname} failed: ${e}`);
    }
    return responseFromRaw(raw, url.hostname);
  };
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("unsupported-protocol", `refusing ${url.protocol} URL`);
  }
}

/**
 * Resolve the host. DNS-rebinding defense: refuse if ANY resolved address is internal —
 * skipped only under the explicit, dangerous allowLocalIP escape hatch.
 */
async function resolvePinned(
  resolver: NonNullable<PinnedFetchConfig["resolver"]>,
  hostname: string,
  allowLocalIP: boolean,
): Promise<string[]> {
  let ips: string[];
  try {
    ips = await resolver(hostname);
  } catch (e) {
    throw new SafeFetchError("dns", `could not resolve ${hostname}: ${e}`);
  }
  if (ips.length === 0) throw new SafeFetchError("dns", `no DNS records for ${hostname}`);
  if (!allowLocalIP && ips.some(isForbiddenAddress)) {
    throw new SafeFetchError("blocked-address", `${hostname} resolves to a blocked address`);
  }
  return ips;
}

function bodyBytes(body: BodyInit | Uint8Array | null | undefined): Uint8Array | undefined {
  if (body == null) return undefined;
  return typeof body === "string" ? new TextEncoder().encode(body) : body as Uint8Array;
}

/**
 * Parse the raw response into a `Response`. We already have the exact (framed) body, so the
 * framing headers are dropped: the Response computes its own and a mismatched origin
 * Content-Length can't confuse readers.
 */
function responseFromRaw(raw: Uint8Array, hostname: string): Response {
  let parsed: ParsedResponse;
  try {
    parsed = parseHttpResponse(raw);
  } catch (e) {
    throw new SafeFetchError("bad-response", `malformed response from ${hostname}: ${e}`);
  }
  parsed.headers.delete("content-length");
  parsed.headers.delete("transfer-encoding");
  const hasBody = parsed.status >= 200 && parsed.status !== 204 && parsed.status !== 304;
  return new Response(hasBody ? (parsed.body as BodyInit) : null, {
    status: parsed.status,
    headers: parsed.headers,
  });
}

/** The default pinned fetch used by the image optimizer. */
export const pinnedFetch: (url: URL, init: RequestInit) => Promise<Response> = makePinnedFetch();

/** Does `hostname` satisfy an optional allowlist (exact host or `*.domain`)? */
function hostAllowed(hostname: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true; // any public host (IPs still validated)
  for (const h of allowedHosts) {
    if (h.startsWith("*.")) {
      const suffix = h.slice(1); // ".example.com"
      if (hostname !== h.slice(2) && hostname.endsWith(suffix)) return true; // sub, not apex
    } else if (hostname === h) return true;
  }
  return false;
}

/** Options for {@linkcode safeFetch}. */
export interface SafeFetchOptions {
  /** HTTP method (default `GET`). */
  method?: string;
  /** Request headers (framing/host headers are managed for you). */
  headers?: Record<string, string> | Headers;
  /** Request body (buffered). */
  body?: string | Uint8Array;
  /**
   * Host allowlist — exact hosts or `*.domain` (subdomains, not the apex). Omit to
   * allow **any public host** (private/internal addresses are always refused).
   */
  allowedHosts?: string[];
  /** Max response body bytes (default 10 MiB). */
  maxBytes?: number;
  /** Max redirects to follow, each re-validated (default 5). */
  maxRedirects?: number;
  /** Per-request timeout in milliseconds (default 10 000). */
  timeoutMs?: number;
  /** Caller abort signal, combined with the timeout. */
  signal?: AbortSignal;
}

/**
 * SSRF-safe `fetch` for **untrusted / user-supplied URLs** (link previews, "import
 * from URL", avatar-by-URL, webhooks). Use it instead of `fetch()` whenever the
 * destination is influenced by an end user.
 *
 * It resolves the host and refuses the request if any resolved address is
 * loopback/private/link-local/CGNAT/multicast, then connects to that pinned IP with
 * the original Host/SNI (closing DNS rebinding). Redirects are followed only after
 * re-validating each hop; the download is time- and size-bounded. Pass `signal`
 * (from an `AbortController`) to cancel; it is combined with `timeoutMs`.
 *
 * A refused or failed request throws {@linkcode SafeFetchError} (inspect `.code`);
 * a real HTTP response — including 4xx/5xx from the origin — is returned for you to
 * handle. Do **not** use this to reach your own internal services — that's what
 * `fetch`/`cachedFetch` are for.
 *
 * @param url The (untrusted) URL to fetch.
 * @param opts Method/headers/body, allowlist, and limits.
 */
export const safeFetch: (url: string | URL, opts?: SafeFetchOptions) => Promise<Response> =
  makeSafeFetch();

/**
 * Build a {@linkcode safeFetch} with an injected resolver/transport (for tests) or
 * a custom default byte cap. Most callers use the default {@linkcode safeFetch}.
 *
 * @param cfg Resolver/transport/size overrides.
 */
export function makeSafeFetch(
  cfg: PinnedFetchConfig = {},
): (url: string | URL, opts?: SafeFetchOptions) => Promise<Response> {
  return async (url, opts = {}) => {
    const maxRedirects = opts.maxRedirects ?? 5;
    const pinned = makePinnedFetch({
      resolver: cfg.resolver,
      transport: cfg.transport,
      maxBytes: opts.maxBytes ?? cfg.maxBytes ?? 10 * 1024 * 1024,
    });
    const hop: RedirectHop = {
      url: typeof url === "string" ? new URL(url) : new URL(url.href),
      method: (opts.method ?? "GET").toUpperCase(),
      body: bodyBytes(opts.body),
    };
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    for (let i = 0; i <= maxRedirects; i++) {
      assertHttpUrl(hop.url);
      if (!hostAllowed(hop.url.hostname, opts.allowedHosts)) {
        throw new SafeFetchError("host-not-allowed", `host ${hop.url.hostname} is not allowlisted`);
      }
      const res = await pinned(hop.url, {
        method: hop.method,
        headers: opts.headers,
        body: hop.body as BodyInit | undefined,
        signal,
      });
      if (!(await followRedirect(hop, res))) return res;
    }
    throw new SafeFetchError("too-many-redirects", `exceeded ${maxRedirects} redirects`);
  };
}

/** The request as it stands on the current redirect hop. */
interface RedirectHop {
  url: URL;
  method: string;
  body: Uint8Array | undefined;
}

/**
 * Advance `hop` to a redirect's target (discarding its body), or return false when `res` is
 * the final response. 303, and 301/302 on a non-idempotent method, downgrade to GET (per the
 * fetch spec).
 */
async function followRedirect(hop: RedirectHop, res: Response): Promise<boolean> {
  const location = REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null;
  if (!location) return false;
  await res.body?.cancel().catch(() => {});
  hop.url = redirectUrl(location, hop.url);
  if (downgradesToGet(res.status, hop.method)) {
    hop.method = "GET";
    hop.body = undefined;
  }
  return true;
}

function redirectUrl(location: string, from: URL): URL {
  try {
    return new URL(location, from);
  } catch {
    throw new SafeFetchError("bad-response", `invalid redirect location: ${location}`);
  }
}

function downgradesToGet(status: number, method: string): boolean {
  return status === 303 ||
    ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD");
}
