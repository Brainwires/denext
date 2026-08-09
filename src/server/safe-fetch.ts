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

function isForbiddenIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // loopback, unspecified
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // IPv4-mapped
  if (mapped) return isForbiddenIPv4(mapped[1]);
  return false;
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

const defaultTransport: Transport = async (opts) => {
  const tcp = await Deno.connect({ hostname: opts.ip, port: opts.port });
  let conn: Deno.Conn = tcp;
  const onAbort = () => {
    try {
      conn.close();
    } catch { /* already closed */ }
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (opts.signal?.aborted) throw new Error("aborted");
    if (opts.tls) conn = await Deno.startTls(tcp, { hostname: opts.hostname });
    await writeAll(conn, opts.request);
    return await readToEnd(conn, opts.maxBytes);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    try {
      conn.close();
    } catch { /* already closed */ }
  }
};

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
  const headerText = new TextDecoder().decode(raw.subarray(0, sep));
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
  let body = raw.subarray(sep + 4);
  if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    body = dechunk(body);
  } else {
    const clHeader = headers.get("content-length");
    if (clHeader !== null) {
      const len = Number(clHeader);
      if (Number.isFinite(len) && len >= 0 && len < body.byteLength) body = body.subarray(0, len);
    }
    // No Content-Length and not chunked → body is everything up to EOF (as read).
  }
  return { status, headers, body };
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

/** Build a minimal HTTP/1.1 GET request for `url`. */
function buildRequest(url: URL): Uint8Array {
  const path = (url.pathname || "/") + (url.search || "");
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    `User-Agent: denext-image-optimizer`,
    `Accept: image/*,*/*;q=0.8`,
    `Accept-Encoding: identity`, // no gzip → no decompression to handle
    `Connection: close`,
    "",
    "",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
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
}

/**
 * Build a `fetch`-shaped function that performs an SSRF-safe, DNS-rebinding-proof
 * GET: resolve → validate every resolved IP → connect to the pinned IP (original
 * Host/SNI preserved) → read the response under a byte cap. Redirects are returned
 * verbatim (status + `Location`) for the caller to re-validate and follow. Any
 * failure resolves to a `502` Response (so callers treat it as "not fetchable").
 *
 * @param cfg Resolver/transport/size overrides.
 */
export function makePinnedFetch(
  cfg: PinnedFetchConfig = {},
): (url: URL, init: RequestInit) => Promise<Response> {
  const resolver = cfg.resolver ?? defaultResolver;
  const transport = cfg.transport ?? defaultTransport;
  const maxBytes = cfg.maxBytes ?? 25 * 1024 * 1024;

  return async (url, init) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return new Response(null, { status: 502 });
    }
    const tls = url.protocol === "https:";
    const port = url.port ? Number(url.port) : (tls ? 443 : 80);

    let ips: string[];
    try {
      ips = await resolver(url.hostname);
    } catch {
      return new Response(null, { status: 502 });
    }
    // DNS-rebinding defense: refuse if the name resolves to nothing, or if ANY
    // returned address is internal.
    if (ips.length === 0 || ips.some(isForbiddenAddress)) {
      return new Response(null, { status: 502 });
    }

    let raw: Uint8Array;
    try {
      raw = await transport({
        ip: pickIp(ips),
        port,
        tls,
        hostname: url.hostname,
        request: buildRequest(url),
        maxBytes,
        signal: init.signal,
      });
    } catch {
      return new Response(null, { status: 502 });
    }

    let parsed: ParsedResponse;
    try {
      parsed = parseHttpResponse(raw);
    } catch {
      return new Response(null, { status: 502 });
    }
    // We already have the exact (framed) body; drop framing headers so the Response
    // computes its own and a mismatched origin Content-Length can't confuse readers.
    parsed.headers.delete("content-length");
    parsed.headers.delete("transfer-encoding");
    const hasBody = parsed.status >= 200 && parsed.status !== 204 && parsed.status !== 304;
    return new Response(hasBody ? (parsed.body as BodyInit) : null, {
      status: parsed.status,
      headers: parsed.headers,
    });
  };
}

/** The default pinned fetch used by the image optimizer. */
export const pinnedFetch: (url: URL, init: RequestInit) => Promise<Response> = makePinnedFetch();
