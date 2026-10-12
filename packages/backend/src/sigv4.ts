// AWS Signature Version 4 on Web Crypto (`crypto.subtle`) — no SDK, no npm. Signs a request's
// headers (the `Authorization` header form) or a URL's query (the presigned-URL form), for any
// SigV4 service; the S3 driver uses `service: "s3"`. Verified against AWS's published examples
// (tests/backend-sigv4.test.ts).

/** AWS credentials. */
export interface AwsCredentials {
  /** The access key id (`AKIA…`). */
  accessKeyId: string;
  /** The secret access key. */
  secretAccessKey: string;
  /** A session token, for temporary (STS) credentials. */
  sessionToken?: string;
}

/** One request to sign. `path` is the DECODED path; the signer percent-encodes it. */
export interface SigV4Request {
  /** The HTTP method. */
  method: string;
  /** Scheme + host (+ port) of the endpoint, e.g. `https://s3.us-east-1.amazonaws.com`. */
  origin: string;
  /** The decoded path, starting with `/` (e.g. `/bucket/photos/a b.png`). */
  path: string;
  /** Query parameters (decoded). */
  query?: Record<string, string>;
  /** Headers to sign and send (any case). `host` is added from `origin`. */
  headers?: Record<string, string>;
}

/** Where and as whom a request is signed. */
export interface SigV4Scope {
  /** The region (`us-east-1`; R2 uses `auto`). */
  region: string;
  /** The service (`s3`). */
  service: string;
  /** The credentials. */
  credentials: AwsCredentials;
  /** The signing time (default: now). */
  date?: Date;
}

/** A signed request: the URL to call and the headers to send with it. */
export interface SignedRequest {
  /** The full URL, path and query encoded exactly as signed. */
  url: string;
  /** The headers to send (lowercased names), `authorization` included. */
  headers: Record<string, string>;
}

/** The payload hash S3 accepts when the body is not hashed (presigned URLs, streamed parts). */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const ALGORITHM = "AWS4-HMAC-SHA256";
const encoder = new TextEncoder();

/**
 * RFC 3986 percent-encoding as SigV4 requires: every byte except `A-Z a-z 0-9 - _ . ~` is
 * encoded (uppercase hex); `/` is kept when `keepSlash`.
 *
 * @param value The decoded string.
 * @param keepSlash Keep `/` (for a path).
 * @returns The encoded string.
 */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * Lowercase hex SHA-256 of `data`.
 *
 * @param data Text (UTF-8) or bytes.
 * @returns The hex digest.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

/**
 * The SigV4 signing key: `HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service),
 * "aws4_request")`.
 *
 * @param secret The secret access key.
 * @param day The `YYYYMMDD` date.
 * @param region The region.
 * @param service The service.
 * @returns The derived key.
 */
export async function signingKey(
  secret: string,
  day: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  let key = await hmac(encoder.encode("AWS4" + secret), day);
  for (const part of [region, service, "aws4_request"]) key = await hmac(key, part);
  return key;
}

/** `20150830T123600Z` for a date. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The canonical query string: encoded pairs sorted by key, then value. */
function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Lowercased names, trimmed values with inner whitespace runs collapsed. */
function canonicalHeaders(headers: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    out.set(name.toLowerCase(), String(value).trim().replace(/\s+/g, " "));
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

interface Canonical {
  request: string;
  signedHeaders: string;
}

function canonicalRequest(
  req: SigV4Request,
  query: Record<string, string>,
  headers: Map<string, string>,
  payloadHash: string,
): Canonical {
  const signedHeaders = [...headers.keys()].join(";");
  const request = [
    req.method.toUpperCase(),
    uriEncode(req.path, true),
    canonicalQuery(query),
    [...headers].map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { request, signedHeaders };
}

async function signature(scope: SigV4Scope, when: string, canonical: string): Promise<string> {
  const day = when.slice(0, 8);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [ALGORITHM, when, credentialScope, await sha256Hex(canonical)].join("\n");
  const key = await signingKey(scope.credentials.secretAccessKey, day, scope.region, scope.service);
  return hex(await hmac(key, stringToSign));
}

function urlOf(req: SigV4Request, query: Record<string, string>): string {
  const qs = canonicalQuery(query);
  return `${req.origin}${uriEncode(req.path, true)}${qs ? "?" + qs : ""}`;
}

/**
 * Sign a request in the `Authorization` header form. Adds `host`, `x-amz-date`, (for S3)
 * `x-amz-content-sha256`, and `x-amz-security-token` for temporary credentials.
 *
 * @param req The request.
 * @param scope Region, service, credentials and time.
 * @param payloadHash The body's hex SHA-256, or {@link UNSIGNED_PAYLOAD}.
 * @returns The URL and the headers to send.
 */
export async function signRequest(
  req: SigV4Request,
  scope: SigV4Scope,
  payloadHash: string,
): Promise<SignedRequest> {
  const when = amzDate(scope.date ?? new Date());
  const query = req.query ?? {};
  const base: Record<string, string> = {
    ...req.headers,
    host: new URL(req.origin).host,
    "x-amz-date": when,
  };
  if (scope.service === "s3") base["x-amz-content-sha256"] = payloadHash;
  if (scope.credentials.sessionToken) base["x-amz-security-token"] = scope.credentials.sessionToken;
  const headers = canonicalHeaders(base);
  const { request, signedHeaders } = canonicalRequest(req, query, headers, payloadHash);
  const sig = await signature(scope, when, request);
  const credential = `${scope.credentials.accessKeyId}/${
    when.slice(0, 8)
  }/${scope.region}/${scope.service}/aws4_request`;
  const out = Object.fromEntries(headers);
  out.authorization =
    `${ALGORITHM} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return { url: urlOf(req, query), headers: out };
}

/**
 * Presign a URL (the query-string form): anyone holding it may make exactly this request until
 * it expires. Headers in `req.headers` are signed too, so the caller must send them with the
 * same values (S3 refuses the request otherwise) — that is how a presigned PUT pins its
 * `content-type` and `content-length`.
 *
 * @param req The request.
 * @param scope Region, service, credentials and time.
 * @param expiresIn Seconds the URL stays valid (1 … 604800).
 * @returns The presigned URL.
 */
export async function presignUrl(
  req: SigV4Request,
  scope: SigV4Scope,
  expiresIn: number,
): Promise<string> {
  const when = amzDate(scope.date ?? new Date());
  const headers = canonicalHeaders({ ...req.headers, host: new URL(req.origin).host });
  const credential = `${scope.credentials.accessKeyId}/${
    when.slice(0, 8)
  }/${scope.region}/${scope.service}/aws4_request`;
  const query: Record<string, string> = {
    ...req.query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": credential,
    "X-Amz-Date": when,
    "X-Amz-Expires": String(Math.trunc(expiresIn)),
    "X-Amz-SignedHeaders": [...headers.keys()].join(";"),
  };
  if (scope.credentials.sessionToken) {
    query["X-Amz-Security-Token"] = scope.credentials.sessionToken;
  }
  const { request } = canonicalRequest(req, query, headers, UNSIGNED_PAYLOAD);
  query["X-Amz-Signature"] = await signature(scope, when, request);
  return urlOf(req, query);
}
