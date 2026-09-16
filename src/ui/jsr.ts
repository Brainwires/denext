// `denext ui`'s JSR client — third-party plugin discovery, and the ONLY place the UI process
// reaches the network. Everything that comes back is treated as hostile input:
//
// - requests go to two pinned origins only (`https://api.jsr.io`, `https://jsr.io`), are built
//   with `new URL` (the user's query only ever lands in a search parameter), carry no
//   credentials, and refuse every redirect (`redirect: "error"`, plus a 3xx check for fetch
//   implementations that hand one back);
// - each request is bounded by a five-second deadline that also covers the body read, and holds
//   even when a fetch implementation ignores its abort signal;
// - the body is read through its stream with a hard 64 KiB cap enforced on the reader — the
//   stream is cancelled the moment the cap is crossed, an oversized `content-length` is refused
//   before a byte is read — and must be `application/json`;
// - the normaliser keeps only items whose scope/name pass JSR's own name rules and whose version
//   is a semver string; descriptions are coerced to capped, control-character-free text.
//
// Failures are values (`{ ok: false, reason }`) from a fixed vocabulary — nothing here throws,
// and no reason echoes text the network sent. `denext ui --offline` turns all of it off through
// {@linkcode jsrAvailable}.

/** The JSR API origin (`GET /packages?query=`). */
const API_ORIGIN = "https://api.jsr.io";
/** The JSR registry origin (`GET /@scope/name/meta.json`). */
const REGISTRY_ORIGIN = "https://jsr.io";
/** Largest response body read, in bytes; a larger one is cancelled mid-stream. */
const MAX_BODY_BYTES = 64 * 1024;
/** Per-request deadline in milliseconds (connect + headers + body). */
const TIMEOUT_MS = 5000;
/** A search query is trimmed and cut to this many characters. */
const MAX_QUERY_CHARS = 100;
/** A hit's description is cut to this many characters (JSR itself allows 250). */
const MAX_DESCRIPTION_CHARS = 300;
/** Hits per search unless the caller asks otherwise. */
const DEFAULT_LIMIT = 20;
/** The most hits one search asks for. */
const MAX_LIMIT = 50;
/** A version longer than this is not a version (and never reaches the regex). */
const MAX_VERSION_CHARS = 64;

/** One JSR name segment: lowercase alphanumerics, single inner hyphens, none leading/trailing. */
const SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
/**
 * `@scope/name`, per JSR's own validators (`crates/jsr_types/src/ids.rs` in jsr-io/jsr): a scope
 * is 2–20 and a package name 2–58 characters of `[a-z0-9-]`, neither starting nor ending with a
 * hyphen nor containing `--`. The lookaheads pin the lengths; {@linkcode SEGMENT} the rest.
 */
const SPEC_RE = new RegExp(`^@(?=[a-z0-9-]{2,20}/)${SEGMENT}/(?=[a-z0-9-]{2,58}$)${SEGMENT}$`);
/** A published version: `major.minor.patch`, optional prerelease and build metadata. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** One package from a JSR search, normalised and safe to render (after HTML escaping). */
export interface JsrHit {
  /** The scope, without the `@` (`denext`). */
  readonly scope: string;
  /** The package name (`openapi`). */
  readonly name: string;
  /** The latest published version (validated semver). */
  readonly version: string;
  /** Plain text: control characters removed, whitespace collapsed, at most 300 characters. */
  readonly description: string;
  /** JSR's package score, when it sent a finite number. */
  readonly score?: number;
  /** The package is archived on JSR. */
  readonly archived: boolean;
}

/** A refusal or failure — `reason` is from a fixed vocabulary, never network text. */
export interface JsrFailure {
  /** Discriminant. */
  readonly ok: false;
  /** `"timed out"`, `"aborted"`, `"unreachable"`, `"redirect refused"`, `"HTTP 500"`, … */
  readonly reason: string;
}

/** The outcome of {@linkcode searchJsr}. */
export type JsrSearchResult =
  | { readonly ok: true; readonly hits: JsrHit[]; readonly total: number }
  | JsrFailure;

/** The outcome of {@linkcode fetchJsrMeta}. */
export type JsrMetaResult = { readonly ok: true; readonly latest: string } | JsrFailure;

/** Options every JSR request takes. */
export interface JsrRequestOptions {
  /** Aborts the request (the UI shutting down, or the page going away). */
  readonly signal?: AbortSignal;
  /** The fetch implementation — injected by tests; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  /** The per-request deadline in milliseconds (default five seconds). */
  readonly timeoutMs?: number;
}

/** Options for {@linkcode searchJsr}. */
export interface JsrSearchOptions extends JsrRequestOptions {
  /** How many hits to ask for, clamped to 1..50 (default 20). */
  readonly limit?: number;
}

/** A read JSON body, or why there is none. */
type Fetched = { readonly ok: true; readonly value: unknown } | JsrFailure;

/**
 * Whether `spec` is a well-formed JSR package name (`@scope/name`) under JSR's own rules — the
 * gate for anything that becomes a `deno add jsr:…` argument or a registry URL.
 *
 * @param spec The candidate, e.g. `"@denext/openapi"` (no `jsr:` prefix, no version).
 * @returns `true` for a scope of 2–20 and a name of 2–58 `[a-z0-9-]` characters with no
 *   leading, trailing or doubled hyphen.
 */
export function isJsrSpec(spec: string): boolean {
  return SPEC_RE.test(spec);
}

/** What a JSR request is for: a search, or a package's registry metadata and files. */
type JsrPurpose = "search" | "registry";

/** The one host each purpose reaches. */
const HOST_FOR: Readonly<Record<JsrPurpose, string>> = {
  search: "api.jsr.io",
  registry: "jsr.io",
};

/**
 * Whether a JSR request for `purpose` may run: never under `denext ui --offline`, and only when
 * this process already holds `--allow-net` for the one host it reaches — `api.jsr.io` to search,
 * `jsr.io` for a package's metadata and files. It only *queries* permissions — it never prompts,
 * so a UI started without net access simply shows no search.
 *
 * @param ctx The request context (only `offline` is read).
 * @param purpose What the request is for.
 * @param permissions The permission API (injected by tests; `Deno.permissions` otherwise).
 * @returns `true` when that host is `"granted"` and the UI is not offline.
 */
export async function jsrAvailable(
  ctx: { readonly offline?: boolean },
  purpose: JsrPurpose,
  permissions: {
    query(desc: Deno.NetPermissionDescriptor): Promise<{ readonly state: Deno.PermissionState }>;
  } = Deno.permissions,
): Promise<boolean> {
  if (ctx.offline === true) return false;
  try {
    return (await permissions.query({ name: "net", host: HOST_FOR[purpose] })).state === "granted";
  } catch {
    return false;
  }
}

/**
 * Search JSR for packages (`GET https://api.jsr.io/packages?query=…&limit=…`).
 *
 * @param query Free text; control characters are dropped, it is trimmed and cut to 100
 *   characters, and it only ever becomes the `query` search parameter.
 * @param opts `limit` (clamped 1..50), an abort `signal`, an injected `fetch`.
 * @returns The normalised hits (malformed items skipped) and JSR's `total`, or `{ ok: false }`.
 */
export async function searchJsr(
  query: string,
  opts: JsrSearchOptions = {},
): Promise<JsrSearchResult> {
  const limit = clampLimit(opts.limit);
  const url = new URL("/packages", API_ORIGIN);
  url.searchParams.set("query", capped(plainText(query), MAX_QUERY_CHARS, ""));
  url.searchParams.set("limit", String(limit));
  const fetched = await getJson(url, opts);
  return fetched.ok ? normaliseSearch(fetched.value, limit) : fetched;
}

/**
 * Read a package's latest version from its registry metadata
 * (`GET https://jsr.io/@scope/name/meta.json`).
 *
 * @param scope The scope, without the `@`.
 * @param name The package name.
 * @param opts An abort `signal`, an injected `fetch`.
 * @returns The validated `latest` version, or `{ ok: false }` — an invalid scope/name is refused
 *   without any request.
 */
export async function fetchJsrMeta(
  scope: string,
  name: string,
  opts: JsrRequestOptions = {},
): Promise<JsrMetaResult> {
  if (!isJsrSpec(`@${scope}/${name}`)) return failure("invalid package name");
  const path = `/@${encodeURIComponent(scope)}/${encodeURIComponent(name)}/meta.json`;
  const fetched = await getJson(new URL(path, REGISTRY_ORIGIN), opts);
  if (!fetched.ok) return fetched;
  const meta = fetched.value;
  if (!isRecord(meta) || !isVersion(meta.latest)) return failure("no valid latest version");
  if (meta.scope !== undefined && meta.scope !== scope) return failure("unexpected response shape");
  if (meta.name !== undefined && meta.name !== name) return failure("unexpected response shape");
  return { ok: true, latest: meta.latest };
}

/** A package's published `deno.json` (else `jsr.json`) at one version, parsed. */
export type JsrConfigResult = { readonly ok: true; readonly value: unknown } | JsrFailure;

/**
 * Read a package's published config at `version` — `deno.json`, else `jsr.json`
 * (`GET https://jsr.io/@scope/name/<version>/deno.json`), the file a plugin declares its
 * `denext.catalog` block in.
 *
 * @param scope The scope, without the `@`.
 * @param name The package name.
 * @param version The exact version.
 * @param opts An abort `signal`, an injected `fetch`.
 * @returns The parsed file, or `{ ok: false }` — an invalid name or version is refused without
 *   any request.
 */
export async function fetchJsrConfig(
  scope: string,
  name: string,
  version: string,
  opts: JsrRequestOptions = {},
): Promise<JsrConfigResult> {
  if (!isJsrSpec(`@${scope}/${name}`) || !isVersion(version)) {
    return failure("invalid package name or version");
  }
  const base = `/@${encodeURIComponent(scope)}/${encodeURIComponent(name)}/${
    encodeURIComponent(version)
  }/`;
  for (const file of ["deno.json", "jsr.json"]) {
    const fetched = await getJson(new URL(base + file, REGISTRY_ORIGIN), opts);
    if (fetched.ok || fetched.reason !== "HTTP 404") return fetched;
  }
  return failure("the package publishes no deno.json or jsr.json");
}

// ── the bounded request ──────────────────────────────────────────────────────

/** GET `url` as JSON under every bound in the header comment; never throws. */
async function getJson(url: URL, opts: JsrRequestOptions): Promise<Fetched> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
  try {
    return await request(url, opts.fetch ?? fetch, signal);
  } catch {
    if (opts.signal?.aborted) return failure("aborted");
    return failure(deadline.signal.aborted ? "timed out" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** The request itself; throws on a transport failure or an abort (handled by the caller). */
async function request(url: URL, doFetch: typeof fetch, signal: AbortSignal): Promise<Fetched> {
  const response = await abortable(
    doFetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal,
    }),
    signal,
  );
  const refused = refusal(response);
  if (refused) {
    response.body?.cancel().catch(() => {});
    return failure(refused);
  }
  return await readJson(response.body, signal);
}

/** Why `response` cannot be read, or `null` when it may be. */
function refusal(response: Response): string | null {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return "redirect refused";
  }
  if (!response.ok) return `HTTP ${response.status}`;
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) return "not JSON";
  const length = Number(response.headers.get("content-length") ?? 0);
  return length > MAX_BODY_BYTES ? "response too large" : null;
}

/** Read and parse a capped body; crossing the cap (or any exit) cancels the stream. */
async function readJson(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<Fetched> {
  if (!body) return failure("empty response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) return parseJson(chunks, size);
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) return failure("response too large");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Decode (strict UTF-8) and parse the collected chunks. */
function parseJson(chunks: Uint8Array[], size: number): Fetched {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return failure("malformed JSON");
  }
}

/**
 * `work`, rejected as soon as `signal` aborts — so the deadline holds even when the promise's
 * producer (an injected fetch, a stalled stream) ignores the signal.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// ── the normaliser ───────────────────────────────────────────────────────────

/** A search page → the valid hits (at most `limit`) and a sane total. */
function normaliseSearch(value: unknown, limit: number): JsrSearchResult {
  if (!isRecord(value) || !Array.isArray(value.items)) return failure("unexpected response shape");
  const hits: JsrHit[] = [];
  for (const item of value.items.slice(0, limit)) {
    const hit = toHit(item);
    if (hit) hits.push(hit);
  }
  const total = value.total;
  const validTotal = typeof total === "number" && Number.isSafeInteger(total) && total >= 0;
  return { ok: true, hits, total: validTotal ? total : hits.length };
}

/** One search item → a {@linkcode JsrHit}, or `null` when anything load-bearing is malformed. */
function toHit(item: unknown): JsrHit | null {
  if (!isRecord(item)) return null;
  const { scope, name, latestVersion, score } = item;
  if (typeof scope !== "string" || typeof name !== "string") return null;
  if (!isJsrSpec(`@${scope}/${name}`) || !isVersion(latestVersion)) return null;
  return {
    scope,
    name,
    version: latestVersion,
    description: capped(plainText(item.description), MAX_DESCRIPTION_CHARS, "…"),
    ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
    archived: item.isArchived === true,
  };
}

/** Whether `value` is a version string {@linkcode VERSION_RE} accepts. */
function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_VERSION_CHARS && VERSION_RE.test(value);
}

/**
 * `value` as one line of plain text: C0/C1 controls, zero-width, line-separator and bidi
 * formatting characters become spaces, whitespace collapses, the ends are trimmed. A non-string
 * is `""`.
 */
function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const char of value) out += isUnsafeChar(char.codePointAt(0)!) ? " " : char;
  return out.replace(/\s+/g, " ").trim();
}

/** C0/C1 controls, DEL, and the invisible/bidi formatting characters (Trojan Source). */
function isUnsafeChar(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) || code === 0xfeff;
}

/** `text` cut to `max` code points (the last one replaced by `mark` when it was cut). */
function capped(text: string, max: number, mark: string): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, mark ? max - 1 : max).join("").trimEnd() + mark;
}

/** The requested hit count, clamped to 1..{@linkcode MAX_LIMIT}. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A {@linkcode JsrFailure}. */
function failure(reason: string): JsrFailure {
  return { ok: false, reason };
}
