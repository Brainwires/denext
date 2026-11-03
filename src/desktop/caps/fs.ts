/**
 * The `fs` capability: `readFile` / `writeFile` / `deleteFile` / `listDir` / `downloadToFile` on
 * Deno Desktop, backed by the OS filesystem under the app's own directories. It answers the
 * `denext/mobile` filesystem calls (see `src/desktop/native.ts`), which on the web use OPFS.
 *
 * SECURITY — this is a path-scoping boundary for an untrusted page:
 * - A page-supplied `path` is joined onto the base directory for its {@link FileDirectory}, then
 *   BOTH `..` traversal (via {@link resolve} normalization) AND symlinks (via {@link Deno.realPath}
 *   of the deepest existing ancestor) are resolved BEFORE the scope check, so neither a `../`
 *   escape nor a symlink out of the tree passes. An absolute `path` is refused outright.
 * - Each {@link FileDirectory} maps to a config token (`data`→`$APPDATA`, `cache`→`$CACHE`,
 *   `documents`→`$DOCUMENTS`); an operation is refused (`forbidden`) unless that token is in the
 *   capability's read set (reads/listing) or write set (writes/delete/download). This mirrors the
 *   least-privilege `--allow-read` / `--allow-write` the package scripts bake in, so the runtime
 *   never grants what the packaged binary would not.
 * - TOCTOU: the check resolves symlinks as they are AT CHECK TIME; a same-user process racing a
 *   symlink swap between the check and the operation is the Electron-equivalent local-process
 *   boundary the bridge does not defend against (see `bridge.ts`). The page itself has no symlink
 *   primitive here, and the base dirs are app-owned.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { dirname, join, resolve } from "@std/path";
import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import type { FileEntry } from "../../mobile/filesystem.ts";
import type { DesktopAppDirs } from "../app-dirs.ts";
import { type DesktopCapability, type DesktopCapCtx, DesktopCapError } from "../extension.ts";
import {
  discardPartial,
  finalizePartial,
  type KeptPartial,
  openPartial,
  type PartialAt,
  partialAt,
  readPartial,
  strongValidator,
  writeSidecar,
} from "./download-partial.ts";
import { confineRelative, isReservedDataName, refuseReservedDataPath } from "../path-scope.ts";
import type { PickedPaths } from "../picked-paths.ts";
import {
  recordInfo,
  type TransferRecord,
  type TransferRecordPatch,
  TransferRecords,
} from "./transfer-records.ts";

/** An app-directory name (the string forms of a `FileDirectory`; kept local so this cap doesn't
 * couple to the page-side `FileDirectory` union, which also carries the `{ picked }` variant). */
type AppDirName = "data" | "cache" | "documents";

/** The config path token each {@link AppDirName} resolves to (for the read/write scope check). */
const DIRECTORY_TOKEN: Readonly<Record<AppDirName, string>> = {
  data: "$APPDATA",
  cache: "$CACHE",
  documents: "$DOCUMENTS",
};

/** The largest file `download` writes by default (bytes). */
const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** How long a `download` may take by default (ms), redirects included. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** The most redirects `download` follows (each hop is re-checked). */
const MAX_DOWNLOAD_REDIRECTS = 5;

/** Resolve a hostname to its addresses (injected in tests; defaults to {@link Deno.resolveDns}). */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** The roots and scope tokens an {@link fsCapability} instance was built with. */
export interface FsCapabilityConfig {
  /** The resolved absolute base directories (`data` / `cache` / `documents`). */
  readonly dirs: DesktopAppDirs;
  /** The path tokens (`$APPDATA` / `$CACHE` / `$DOCUMENTS`) the page may READ from. */
  readonly read: ReadonlySet<string>;
  /** The path tokens the page may WRITE to (also gates delete and download). */
  readonly write: ReadonlySet<string>;
  /** The per-launch picked-path set, for a `directory: { picked: handle }` from a native dialog. */
  readonly picked?: PickedPaths;
  /** `download`'s byte cap (default 100 MiB); a larger body is aborted and nothing is kept. */
  readonly downloadMaxBytes?: number;
  /** `download`'s overall timeout in ms (default 10 minutes). */
  readonly downloadTimeoutMs?: number;
  /** The DNS resolver `download` checks a hostname's addresses with (tests inject one). */
  readonly resolveHost?: HostResolver;
  /** The `fetch` `download` uses (tests inject one; defaults to the global). */
  readonly fetch?: typeof fetch;
  /** The clock the download records are stamped with (tests move it; defaults to `Date.now`). */
  readonly transferClock?: () => number;
}

/** A `forbidden` download target. */
function refusedTarget(why: string): DesktopCapError {
  return new DesktopCapError("forbidden", `download refused: ${why}`, { status: 403 });
}

/** The four octets of a dotted IPv4 address, or `undefined`. */
function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 literal, in either spelling — `::ffff:7f00:1` (how
 * the URL parser normalizes it) or `::ffff:127.0.0.1` — else `undefined`.
 */
function mappedIpv4(v6: string): string | undefined {
  const tail = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(v6)?.[1];
  if (tail === undefined) return undefined;
  if (ipv4Octets(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return undefined;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Whether `address` (an IP literal, or a hostname) is a loopback, unspecified or link-local
 * target that `download` must not reach: `localhost` / `*.localhost`, `127.0.0.0/8`, `0.0.0.0/8`,
 * `169.254.0.0/16`, `::1`, `::`, `fe80::/10`, and IPv4-mapped forms of those. LAN (RFC 1918)
 * addresses stay allowed — a desktop app legitimately downloads from the local network.
 *
 * @param address A hostname or IP (IPv6 with or without brackets).
 * @returns `true` when the target is refused.
 */
export function isRefusedDownloadHost(address: string): boolean {
  const h = address.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = ipv4Octets(h);
  if (v4) return v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254);
  if (!h.includes(":")) return false; // an ordinary hostname (checked again after DNS)
  const zoneless = h.split("%")[0];
  if (/^(?:0{0,4}:){2,7}0{0,3}1$/.test(zoneless) || zoneless === "::1") return true;
  if (/^(?:0{0,4}:){2,7}0{0,4}$/.test(zoneless) || zoneless === "::") return true;
  if (/^fe[89ab][0-9a-f]?:/.test(zoneless)) return true;
  const mapped = mappedIpv4(zoneless);
  return mapped !== undefined && isRefusedDownloadHost(mapped);
}

/**
 * Whether `address` (an IP literal, or a hostname) is on a private network: RFC 1918
 * (`10/8`, `172.16/12`, `192.168/16`), carrier-grade NAT (`100.64/10`), IPv6 unique-local
 * (`fc00::/7`) and their IPv4-mapped forms, or a `.local` (mDNS) name. A download may reach one,
 * but never with the page's own headers (see {@link fetchChecked}).
 *
 * @param address A hostname or IP (IPv6 with or without brackets).
 * @returns `true` for a private-network target.
 */
function isPrivateNetworkHost(address: string): boolean {
  const h = address.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (h.endsWith(".local")) return true;
  const v4 = ipv4Octets(h);
  if (v4) return isPrivateIpv4(v4);
  if (!h.includes(":")) return false;
  const zoneless = h.split("%")[0];
  if (/^f[cd][0-9a-f]{0,2}:/.test(zoneless)) return true;
  const mapped = mappedIpv4(zoneless);
  return mapped !== undefined && isPrivateNetworkHost(mapped);
}

/** RFC 1918 or carrier-grade NAT (`100.64/10`), from an IPv4 address's octets. */
function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === 10) return true;
  if (a === 172) return b >= 16 && b < 32;
  if (a === 192) return b === 168;
  return a === 100 && b >= 64 && b < 128;
}

/** The default resolver: A + AAAA; a permission failure yields `undefined` (see the caller). */
async function defaultResolveHost(hostname: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      out.push(...await Deno.resolveDns(hostname, type));
    } catch (err) {
      // No DNS permission (the packaged binary's --allow-net names hosts, not the resolver):
      // Deno's own per-host net permission is then the gate, so there is nothing to check here.
      if (err instanceof Deno.errors.NotCapable || err instanceof Deno.errors.PermissionDenied) {
        return [];
      }
      // NXDOMAIN / no AAAA record: the fetch itself will fail or use the other family.
    }
  }
  return out;
}

/**
 * Refuse a download URL that is not http(s), or whose host is (or resolves to) a loopback /
 * link-local address — the page must not use the runtime's CORS-free fetch to read local services
 * (a dev server, a local admin UI, cloud metadata at 169.254.169.254). The DNS check is
 * best-effort: a rebinding race between it and the fetch's own lookup is not closed (Deno's fetch
 * cannot pin an address); in a packaged app Deno's per-host `--allow-net` is the harder gate.
 *
 * @param url The URL (each redirect hop is checked too).
 * @param resolve The resolver (defaults to {@link Deno.resolveDns}).
 */
export async function checkDownloadUrl(url: string, resolve?: HostResolver): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badInput("url is not a valid URL");
  }
  // http(s) only: Deno's fetch also reads `file:` (and `data:`/`blob:`), which under the
  // packaged binary's broad --allow-read would copy ANY local file into the app dir.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw refusedTarget(`a "${parsed.protocol}" URL`);
  }
  if (isRefusedDownloadHost(parsed.hostname)) throw refusedTarget("a loopback/link-local host");
  if (ipv4Octets(parsed.hostname) || parsed.hostname.startsWith("[")) {
    return isPrivateNetworkHost(parsed.hostname); // an IP literal
  }
  const addresses = await (resolve ?? defaultResolveHost)(parsed.hostname);
  if (addresses.some(isRefusedDownloadHost)) {
    throw refusedTarget("the host resolves to a loopback/link-local address");
  }
  return isPrivateNetworkHost(parsed.hostname) || addresses.some(isPrivateNetworkHost);
}

/** The request headers a browser sends cross-origin without a preflight (CORS-safelisted). */
const SAFELISTED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-language",
  "range",
]);

/**
 * Refuse sending the page's own headers (an `Authorization`, an API key) to a private-network
 * host: a browser's `fetch` could not (CORS preflight), and the runtime's download reads the
 * answer, which would turn a script in the page into a client of the LAN's admin APIs.
 */
function assertNoPrivateHeaders(privateTarget: boolean, headers: Headers): void {
  if (!privateTarget) return;
  for (const name of headers.keys()) {
    if (!SAFELISTED_REQUEST_HEADERS.has(name)) {
      throw refusedTarget(`the "${name}" header to a private-network host`);
    }
  }
}

/**
 * Request headers a page may not set, as `fetch` refuses them in a browser (the Fetch standard's
 * forbidden request-header names), plus the hop-by-hop headers a proxy strips. They are dropped,
 * not sent, the way a browser's `fetch` ignores them.
 */
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

/** The method-override headers the Fetch standard forbids when they name a forbidden method. */
const METHOD_OVERRIDE_HEADERS: ReadonlySet<string> = new Set([
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);

/** The most request headers a download takes from the page. */
const MAX_DOWNLOAD_HEADERS = 64;

/**
 * Whether the page may send header `name` with `value` (lower-cased name): not a forbidden or
 * hop-by-hop name, no `proxy-` / `sec-` prefix, no method override naming CONNECT/TRACE/TRACK.
 *
 * @param name The header name, lower-cased.
 * @param value The header value.
 * @returns `true` when the header is sent.
 */
export function isAllowedDownloadHeader(name: string, value: string): boolean {
  if (FORBIDDEN_REQUEST_HEADERS.has(name)) return false;
  if (name.startsWith("proxy-") || name.startsWith("sec-")) return false;
  if (!METHOD_OVERRIDE_HEADERS.has(name)) return true;
  return !value.split(",").some((m) => /^(connect|trace|track)$/i.test(m.trim()));
}

/**
 * The page's `headers` arg as the request's {@link Headers}: a record of strings (a malformed one
 * is a `validation` error), with the headers a browser's `fetch` would not send dropped.
 */
function downloadHeaders(raw: unknown): Headers {
  const headers = new Headers();
  for (const [name, value] of headerEntries(raw)) {
    if (typeof value !== "string") throw badInput(`header "${name}" must be a string`);
    try {
      if (isAllowedDownloadHeader(name.toLowerCase(), value)) headers.append(name, value);
    } catch {
      throw badInput(`header "${name}" is not a valid header`);
    }
  }
  return headers;
}

/** The `headers` arg's entries: none when absent, a `validation` error when not a small object. */
function headerEntries(raw: unknown): Array<[string, unknown]> {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw badInput("headers must be an object of strings");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_DOWNLOAD_HEADERS) {
    throw badInput(`at most ${MAX_DOWNLOAD_HEADERS} headers`);
  }
  return entries;
}

/** A download's own `id` arg (the page's transfer id), or `undefined` when none was sent. */
function downloadId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw badInput("id must be a string of 1 to 200 characters");
  }
  return raw;
}

/** Why a download's request stopped: the page cancelled it, it timed out, or the network failed. */
function stoppedError(err: unknown, cancel: AbortSignal, timeout: AbortSignal): DesktopCapError {
  if (err instanceof DesktopCapError) return err;
  if (cancel.aborted) return new DesktopCapError("cancelled", "the download was cancelled");
  if (timeout.aborted) return new DesktopCapError("network", "the download timed out");
  return new DesktopCapError("network", "the download failed: the connection was lost");
}

/** The request's headers: the page's (checked), then the runtime's own resume headers. */
function requestHeaders(page: Headers, resume: Readonly<Record<string, string>>): Headers {
  const out = new Headers(page);
  for (const [name, value] of Object.entries(resume)) out.set(name, value);
  return out;
}

/**
 * `fetch` with redirects followed BY HAND, re-checking every hop with {@link checkDownloadUrl}.
 * Like a browser's `fetch`, a redirect to another origin drops `Authorization`. `resume` is the
 * runtime's own `Range` / `If-Range` (a resumed download's), added after the page's headers are
 * checked, on every hop: the page's headers get the same checks on a resume as on a first request.
 */
async function fetchChecked(
  url: string,
  signal: AbortSignal,
  cfg: FsCapabilityConfig,
  headers: Headers,
  privateTarget: boolean,
  resume: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const doFetch = cfg.fetch ?? fetch;
  let current = url;
  assertNoPrivateHeaders(privateTarget, headers);
  for (let hop = 0;; hop++) {
    const res = await doFetch(current, {
      signal,
      redirect: "manual",
      headers: requestHeaders(headers, resume),
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || location === null) return res;
    await res.body?.cancel();
    if (hop >= MAX_DOWNLOAD_REDIRECTS) {
      throw new DesktopCapError("network", "too many redirects");
    }
    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) headers.delete("authorization");
    current = next.href;
    assertNoPrivateHeaders(await checkDownloadUrl(current, cfg.resolveHost), headers);
  }
}

/** The most of a failed answer's body a download keeps for the page (bytes of text). */
const MAX_ERROR_BODY_CHARS = 64 * 1024;

/**
 * A non-2xx answer as the page's error: `download_failed` with the status and, when the page may
 * read the directory the download was going to (so it could read a successful one), (some of)
 * the body.
 */
async function httpFailure(res: Response, withBody: boolean): Promise<DesktopCapError> {
  if (!withBody) {
    await res.body?.cancel();
    return new DesktopCapError("download_failed", `download failed with status ${res.status}`, {
      data: { status: res.status },
    });
  }
  const text = await res.text().catch(() => "");
  return new DesktopCapError("download_failed", `download failed with status ${res.status}`, {
    data: { status: res.status, body: text.slice(0, MAX_ERROR_BODY_CHARS) },
  });
}

/** How often a download reports progress (ms), as the native transfer plugin does. */
const PROGRESS_EVERY_MS = 200;

/** Reports a download's progress (`bytes`, `total`), at most every {@link PROGRESS_EVERY_MS}. */
type ProgressReporter = (bytes: number, total: number | null, force?: boolean) => void;

/** A reporter that emits `progress` events for transfer `id` (none without an id). */
function progressReporter(ctx: DesktopCapCtx, id: string | undefined): ProgressReporter {
  let last = -Infinity;
  return (bytes, total, force = false) => {
    if (id === undefined) return;
    const now = Date.now();
    if (!force && now - last < PROGRESS_EVERY_MS) return;
    last = now;
    ctx.emit("progress", { id, bytes, total });
  };
}

/** Run a file-system step, its failure an `io` error (the disk, not the network). */
async function onDisk<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch {
    throw new DesktopCapError("io", "the download could not be written");
  }
}

/** Write every byte of `chunk` to `file`. */
async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) written += await file.write(chunk.subarray(written));
}

/** The size a response declares (`Content-Length`), or `null`. */
function declaredLength(res: Response): number | null {
  const raw = res.headers.get("content-length");
  const declared = raw === null ? NaN : Number(raw);
  return Number.isFinite(declared) ? declared : null;
}

/** The `download` args, checked: the URL, the optional transfer id and the request headers. */
function downloadArgs(a: { url?: unknown; id?: unknown; headers?: unknown }): {
  url: string;
  id: string | undefined;
  headers: Headers;
} {
  if (typeof a.url !== "string") throw badInput("url must be a string");
  return { url: a.url, id: downloadId(a.id), headers: downloadHeaders(a.headers) };
}

/** Why a download was stopped from outside: paused (the partial kept) or cancelled (dropped). */
type StopWhy = "pause" | "cancel";

/** Where a download attempt continues from: the kept bytes and the validator guarding them. */
interface ResumePlan {
  readonly from: number;
  readonly validator: string | null;
  readonly total: number | null;
}

/** A download from byte zero. */
const FRESH: ResumePlan = { from: 0, validator: null, total: null };

/** The plan for a kept partial: continue it only with bytes AND a validator `If-Range` can use. */
function planFor(kept: KeptPartial | null): ResumePlan {
  return kept && kept.validator !== null && kept.bytes > 0
    ? { from: kept.bytes, validator: kept.validator, total: kept.total }
    : FRESH;
}

/** The runtime's own `Range` / `If-Range` for `plan` (none from byte zero). */
function rangeHeaders(plan: ResumePlan): Record<string, string> {
  if (plan.from === 0 || plan.validator === null) return {};
  return { range: `bytes=${plan.from}-`, "if-range": plan.validator };
}

/** A 206 answer's `Content-Range`: where it starts and the full size (`null` for `*`). */
function contentRange(res: Response): { start: number; total: number | null } | undefined {
  const m = /^bytes\s+(\d+)-\d+\/(\d+|\*)\s*$/i.exec(res.headers.get("content-range") ?? "");
  if (!m) return undefined;
  return { start: Number(m[1]), total: m[2] === "*" ? null : Number(m[2]) };
}

/** What to do with an answer: write it (appending or from zero), finish, or ask again from zero. */
type AnswerStep =
  | {
    readonly kind: "write";
    readonly append: boolean;
    readonly from: number;
    readonly total: number | null;
    /** The validator for the partial's sidecar (`null`: it cannot be resumed). */
    readonly validator: string | null;
  }
  | { readonly kind: "finish"; readonly bytes: number }
  | { readonly kind: "restart" };

/** The answer to a resumed request (`plan.from > 0`), as the next step. */
async function resumedStep(res: Response, plan: ResumePlan): Promise<AnswerStep | undefined> {
  if (res.status === 206) {
    const range = contentRange(res);
    if (range?.start === plan.from) {
      const rest = declaredLength(res);
      const total = range.total ?? (rest === null ? plan.total : plan.from + rest);
      const validator = strongValidator(res.headers) ?? plan.validator;
      return { kind: "write", append: true, from: plan.from, total, validator };
    }
    await res.body?.cancel();
    return { kind: "restart" }; // a range that does not continue the kept bytes
  }
  if (res.status === 416) {
    await res.body?.cancel();
    // Nothing left to send: the kept bytes are the whole file when they match its known size.
    return plan.total === plan.from ? { kind: "finish", bytes: plan.from } : { kind: "restart" };
  }
  return undefined;
}

/** The answer to a request as the next step (a non-2xx one is the download's failure). */
async function answerStep(
  res: Response,
  plan: ResumePlan,
  withBody: boolean,
): Promise<AnswerStep> {
  const resumed = plan.from > 0 ? await resumedStep(res, plan) : undefined;
  if (resumed) return resumed;
  if (!res.ok) throw await httpFailure(res, withBody);
  // A 200 to a resumed request: the server ignored the range or the file changed. Start over.
  return {
    kind: "write",
    append: false,
    from: 0,
    total: declaredLength(res),
    validator: strongValidator(res.headers),
  };
}

/** One download's fixed parts, shared by its attempts and its failure handling. */
interface DownloadJob {
  readonly url: string;
  readonly target: string;
  /** Where its partial lives (beside the target, or in the cache dir for a picked file). */
  readonly at: PartialAt;
  readonly headers: Headers;
  readonly privateTarget: boolean;
  readonly signal: AbortSignal;
  readonly cfg: FsCapabilityConfig;
  readonly maxBytes: number;
  readonly withBody: boolean;
  readonly progress: ProgressReporter;
}

/** A download's {@link DownloadJob} from its checked request and the capability's config. */
function downloadJob(
  cfg: FsCapabilityConfig,
  a: Record<string, unknown>,
  ctx: DesktopCapCtx,
  req: {
    url: string;
    id: string | undefined;
    headers: Headers;
    target: string;
    at: PartialAt;
    privateTarget: boolean;
    signal: AbortSignal;
  },
): DownloadJob {
  return {
    url: req.url,
    target: req.target,
    at: req.at,
    headers: req.headers,
    privateTarget: req.privateTarget,
    signal: req.signal,
    cfg,
    maxBytes: cfg.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
    withBody: readable(cfg, a.directory),
    progress: progressReporter(ctx, req.id),
  };
}

/** A `too_large` refusal for `job`. */
function tooLarge(job: DownloadJob): DesktopCapError {
  return new DesktopCapError("too_large", `the download is over ${job.maxBytes} bytes`);
}

/**
 * Stream `res`'s body into `job`'s partial file (appended to the kept bytes, or from zero),
 * the sidecar written first, enforcing `maxBytes` over the WHOLE file (the kept bytes included);
 * then move it into place. Resolves the file's size.
 */
async function writePartial(
  res: Response,
  job: DownloadJob,
  step: Extract<AnswerStep, { kind: "write" }>,
): Promise<number> {
  const { from, total, validator } = step;
  if (total !== null && total > job.maxBytes) {
    await res.body?.cancel();
    throw tooLarge(job);
  }
  const file = await onDisk(() => openPartial(job.at, step.append, from));
  let bytes = from;
  try {
    await onDisk(() => writeSidecar(job.at, { url: job.url, validator, total, bytes }));
    job.progress(bytes, total, true);
    for await (const chunk of res.body ?? new ReadableStream<Uint8Array>()) {
      bytes += chunk.byteLength;
      if (bytes > job.maxBytes) throw tooLarge(job);
      await onDisk(() => writeAll(file, chunk));
      job.progress(bytes, total);
    }
  } finally {
    file.close();
  }
  await onDisk(() => finalizePartial(job.at));
  return bytes;
}

/**
 * Run `job`: continue the partial a paused, interrupted or failed download (this launch's or an
 * earlier one's) kept for the same URL — a range request guarded by `If-Range` — else download it
 * from zero. A range that does not continue the kept bytes, or a 416 that does not mean "done",
 * asks once more from zero. Resolves the file's size.
 */
async function runDownload(job: DownloadJob): Promise<number> {
  let plan = planFor(await readPartial(job.at, job.url));
  for (;;) {
    const res = await fetchChecked(
      job.url,
      job.signal,
      job.cfg,
      job.headers,
      job.privateTarget,
      rangeHeaders(plan),
    );
    const step = await answerStep(res, plan, job.withBody);
    if (step.kind === "write") return await writePartial(res, job, step);
    if (step.kind === "finish") {
      await onDisk(() => finalizePartial(job.at));
      job.progress(step.bytes, step.bytes, true);
      return step.bytes;
    }
    await discardPartial(job.at);
    plan = FRESH;
  }
}

/** The failure codes after which a partial is dropped: the cap was hit, or the disk failed. */
const DROPS_PARTIAL: ReadonlySet<string> = new Set(["too_large", "io"]);

/**
 * A stopped download's partial: dropped (a plain cancel, the byte cap, a disk failure), else kept
 * with its sidecar's byte count brought up to date. Resolves what is kept (`null` when nothing).
 */
async function settlePartial(
  job: DownloadJob,
  drop: boolean,
): Promise<KeptPartial | null> {
  if (drop) {
    await discardPartial(job.at);
    return null;
  }
  const kept = await readPartial(job.at, job.url);
  if (kept) {
    await writeSidecar(job.at, { url: job.url, ...kept }).catch(() => {});
  }
  return kept;
}

/** What a stopped download kept, as its error's `data`: the bytes, the size, whether it resumes. */
function keptData(
  kept: KeptPartial | null,
): { bytes: number; total: number | null; resumable: boolean } {
  if (!kept) return { bytes: 0, total: null, resumable: false };
  return { bytes: kept.bytes, total: kept.total, resumable: planFor(kept).from > 0 };
}

/** Why a download stopped, from outside (a pause or a cancel), or `undefined`. */
function stopWhy(stop: AbortSignal): StopWhy | undefined {
  return stop.aborted ? stop.reason as StopWhy : undefined;
}

/**
 * The error a stopped download rejects with, its partial settled: `paused` (with the bytes kept)
 * for a pause, `cancelled` for a cancel or the page going away, and the failure otherwise — a
 * `network` one carrying `{ bytes, total, resumable }`.
 */
async function downloadFailure(
  err: unknown,
  job: DownloadJob,
  stop: AbortSignal,
  ctxSignal: AbortSignal,
  timeout: AbortSignal,
): Promise<DesktopCapError> {
  const why = stopWhy(stop);
  if (why === "pause") {
    const data = keptData(await settlePartial(job, false));
    return new DesktopCapError("paused", "the download was paused", { data });
  }
  const base = stoppedError(err, AbortSignal.any([ctxSignal, stop]), timeout);
  const kept = await settlePartial(job, why === "cancel" || DROPS_PARTIAL.has(base.code));
  // A network failure, or the page going away (not the user's cancel), keeps what it wrote.
  if (base.code !== "network" && (base.code !== "cancelled" || why === "cancel")) return base;
  return new DesktopCapError(base.code, base.message, { data: keptData(kept) });
}

/** A `directory` arg that names a picked handle (`{ picked: "<handle>" }`) instead of a token. */
function pickedHandle(directory: unknown): string | undefined {
  const p = (directory as { picked?: unknown } | null | undefined)?.picked;
  return typeof p === "string" ? p : undefined;
}

/** A validation error (a bad `directory`, absolute path, or malformed arg). */
function badInput(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** Whether the page may read `directory` (a known directory token in the read scope). */
function readable(cfg: FsCapabilityConfig, directory: unknown): boolean {
  return (directory === "data" || directory === "cache" || directory === "documents") &&
    cfg.read.has(DIRECTORY_TOKEN[directory]);
}

/** The base dir for `directory`, checking the config scope for the given access. */
function baseFor(cfg: FsCapabilityConfig, directory: unknown, write: boolean): string {
  if (directory !== "data" && directory !== "cache" && directory !== "documents") {
    throw badInput(`unknown directory "${String(directory)}"`);
  }
  const token = DIRECTORY_TOKEN[directory];
  const scope = write ? cfg.write : cfg.read;
  if (!scope.has(token)) {
    throw new DesktopCapError(
      "forbidden",
      `the fs capability is not allowed to ${write ? "write" : "read"} "${directory}" ` +
        `(add ${token} to desktop.capabilities.fs.${write ? "write" : "read"})`,
      { status: 403 },
    );
  }
  return cfg.dirs[directory];
}

/** Confine a page-supplied relative `path` to `base` (see {@link confineRelative}). With
 * `allowRoot` (listDir), `""` names the directory itself — the page's `listDir("")`, which
 * normalizes `"."` away, so it is the only way the page can list an app directory's root. */
function scopedPath(base: string, path: unknown, allowRoot = false): Promise<string> {
  if (allowRoot && path === "") return confineRelative(base, ".");
  if (typeof path !== "string" || path.length === 0) {
    throw badInput("path must be a non-empty string");
  }
  return confineRelative(base, path);
}

/**
 * Resolve `(directory, path)` to a confined `{ target, root }` for the given access — a
 * {@link FileDirectory} token (scope-checked) or a `{ picked: handle }` directory (resolved through
 * the picked-path set). `root` is the directory to ensure before a write.
 */
async function resolveTarget(
  cfg: FsCapabilityConfig,
  directory: unknown,
  path: unknown,
  write: boolean,
  allowRoot = false,
): Promise<{ target: string; root: string; single?: boolean }> {
  const handle = pickedHandle(directory);
  if (handle !== undefined) {
    if (!cfg.picked) throw badInput("picked directories are not available");
    return cfg.picked.resolve(handle, typeof path === "string" ? path : "", write);
  }
  const base = baseFor(cfg, directory, write);
  const target = await scopedPath(base, path, allowRoot);
  // The runtime's own state under the data dir (the updater overlay, the engine profile) is never
  // reachable from the page: not read, listed, written or deleted.
  await refuseReservedDataPath(cfg.dirs.data, target);
  return { target, root: base };
}

/** Whether `a` and `b` are the same directory (by real path when both exist, else as spelled). */
async function sameDir(a: string, b: string): Promise<boolean> {
  const real = (p: string) => Deno.realPath(p).catch(() => resolve(p));
  return (await real(a)) === (await real(b));
}

/** `mkdir -p path`, treating an existing directory as success (used for the base and write parents). */
async function mkdirp(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true }).catch((err) => {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  });
}

/** One `readDir` entry as a {@link FileEntry} (size/mtime from a stat; 0/absent on failure). */
async function toFileEntry(dir: string, name: string, isDirectory: boolean): Promise<FileEntry> {
  const base: FileEntry = { name, type: isDirectory ? "directory" : "file", size: 0 };
  try {
    const info = await Deno.stat(join(dir, name));
    const size = isDirectory ? 0 : info.size;
    const mtime = info.mtime?.getTime();
    return typeof mtime === "number" ? { ...base, size, mtime } : { ...base, size };
  } catch {
    return base;
  }
}

/** Validate a {@link FileEncoding} arg, defaulting to `"utf8"`. */
function encodingOf(value: unknown): "utf8" | "base64" {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw badInput(`unknown encoding "${String(value)}"`);
}

/** A download running under a page-given id: how to stop it, and when it has. */
interface RunningDownload {
  readonly stop: AbortController;
  readonly settled: Promise<void>;
  /** Set once it has stopped because of a pause (its partial kept). */
  paused: boolean;
  /** Set once it finished: a stop that came too late leaves it done. */
  done: boolean;
}

/** The runtime's download failure codes as the page's `FileTransferError` codes, for a record. */
const RECORD_CODES: Readonly<Record<string, string>> = {
  download_failed: "HTTP",
  network: "NETWORK",
  cancelled: "NETWORK",
  io: "IO",
  too_large: "IO",
  validation: "INVALID",
  forbidden: "INVALID",
  exists: "EXISTS",
};

/** A stopped download's error `data`: what it kept, and an HTTP failure's status. */
function failureData(failure: DesktopCapError): {
  bytes: number;
  total: number | null;
  resumable: boolean;
  status?: number;
} {
  const d = (failure.data ?? {}) as {
    bytes?: unknown;
    total?: unknown;
    resumable?: unknown;
    status?: unknown;
  };
  const out: { bytes: number; total: number | null; resumable: boolean; status?: number } = {
    bytes: typeof d.bytes === "number" ? d.bytes : 0,
    total: typeof d.total === "number" ? d.total : null,
    resumable: d.resumable === true,
  };
  if (typeof d.status === "number") out.status = d.status;
  return out;
}

/**
 * The record of a download that stopped (not paused, not the user's cancel): failed, with what it
 * kept. The page going away is told apart from a network failure.
 */
function failedRecordPatch(failure: DesktopCapError): TransferRecordPatch {
  const { bytes, total, resumable, status } = failureData(failure);
  return {
    state: "failed",
    code: RECORD_CODES[failure.code] ?? "NETWORK",
    error: failure.code === "cancelled"
      ? "the download stopped when its page went away"
      : failure.message,
    status,
    bytes,
    total,
    resumable,
    file: undefined,
  };
}

/** The request headers as a plain record (to keep with a download's record). */
function headerObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => (out[name] = value));
  return out;
}

/** Whether `headers` has none. */
function noHeaders(headers: Headers): boolean {
  for (const _ of headers.keys()) return false;
  return true;
}

/** The `exists` refusal for a download id or destination already in use. */
function inUse(what: string): DesktopCapError {
  return new DesktopCapError("exists", `${what} is already downloading`, { status: 409 });
}

/** How one download attempt keeps its record up to date. */
interface DownloadRecorder {
  /** It starts (running, with its request headers). */
  start(): Promise<void>;
  /** It finished into `target`. */
  done(target: string, bytes: number): Promise<void>;
  /** It stopped: paused, cancelled (the record goes), or failed. */
  stopped(failure: DesktopCapError, why: StopWhy | undefined): Promise<void>;
}

/** No record (a download without an id, or into a picked file). */
const NO_RECORD: DownloadRecorder = {
  start: () => Promise.resolve(),
  done: () => Promise.resolve(),
  stopped: () => Promise.resolve(),
};

/**
 * The recorder of one attempt at download `req`: a download with an id into an app folder is
 * recorded (a picked file's handle lasts one launch, so a restart could not continue it). Every
 * change is this attempt's, so an attempt that stopped never writes over its successor's record.
 */
function downloadRecorder(
  records: TransferRecords,
  a: Record<string, unknown>,
  req: { url: string; id: string | undefined; headers: Headers },
): DownloadRecorder {
  const id = req.id;
  if (id === undefined || pickedHandle(a.directory) !== undefined) return NO_RECORD;
  const attempt = crypto.randomUUID();
  const cleared = { code: undefined, error: undefined, status: undefined };
  return {
    start: () =>
      records.start({
        id,
        url: req.url,
        directory: a.directory as TransferRecord["directory"],
        path: a.path as string,
        headers: headerObject(req.headers),
        state: "running",
        bytes: 0,
        total: null,
        resumable: false,
        attempt,
      }),
    done: async (target, bytes) => {
      const patch = { state: "done", bytes, total: bytes, resumable: false, file: target } as const;
      await records.update(id, attempt, { ...patch, ...cleared });
    },
    stopped: async (failure, why) => {
      if (failure.code === "paused") {
        const { bytes, total, resumable } = failureData(failure);
        await records.update(id, attempt, { state: "paused", bytes, total, resumable, ...cleared });
      } else if (why === "cancel") {
        await records.remove(id, attempt);
      } else {
        await records.update(id, attempt, failedRecordPatch(failure));
      }
    },
  };
}

/** The `fs` methods that download: `download` / `resumeDownload`, the controls, and the records. */
type DownloadMethods = Record<
  | "download"
  | "resumeDownload"
  | "pauseDownload"
  | "cancelDownload"
  | "listDownloads"
  | "forgetDownload",
  DesktopCapability["methods"][string]
>;

/** The checked `id` arg of a control (`pauseDownload`, `cancelDownload`, …). */
function controlId(args: unknown): string | undefined {
  return downloadId((args as { id?: unknown } | null)?.id);
}

/**
 * The download methods over `cfg`, sharing one registry: the downloads running under a page-given
 * id, the partials a stopped one kept (by id, for `cancelDownload`), the destinations being
 * written (one download per file, as they share its partial), and the records of the downloads
 * with an id (kept across restarts: {@link TransferRecords}).
 */
function downloadMethods(cfg: FsCapabilityConfig): DownloadMethods {
  const running = new Map<string, RunningDownload>();
  const kept = new Map<string, PartialAt>();
  const busy = new Set<string>();
  const clock = cfg.transferClock ?? Date.now;
  const records = new TransferRecords(cfg.dirs.data, clock);

  /** Where record `r`'s partial lives, or `undefined` when its folder is no longer granted. */
  const recordPartial = async (r: TransferRecord): Promise<PartialAt | undefined> => {
    try {
      const { target } = await resolveTarget(cfg, r.directory, r.path, true);
      return await partialAt(target);
    } catch {
      return undefined;
    }
  };

  /**
   * A loaded record as this launch sees it: one that was running when the app stopped failed
   * there, resumable from its partial file when that kept bytes and a validator (as a download a
   * force-quit stopped comes back on iOS).
   */
  const restore = async (r: TransferRecord): Promise<TransferRecord> => {
    if (r.state !== "running") return r;
    const at = await recordPartial(r);
    const data = keptData(at ? await readPartial(at, r.url) : null);
    return {
      ...r,
      state: "failed",
      code: "NETWORK",
      error: "the download stopped when the app quit",
      bytes: data.bytes,
      total: data.total ?? r.total,
      resumable: data.resumable,
      headers: data.resumable ? r.headers : {},
      updatedAt: clock(),
    };
  };

  /** A record dropped for its age: a failed one's partial file goes with it. */
  const expire = async (r: TransferRecord): Promise<void> => {
    if (r.state !== "failed") return;
    const at = await recordPartial(r);
    if (at) await discardPartial(at);
  };

  const ready = () => records.ready(restore, expire);

  /** Note whether download `id` (if it has one) left a partial (at `at`) behind. */
  const remember = (id: string | undefined, at: PartialAt, keeps: boolean) => {
    if (id === undefined) return;
    if (keeps) kept.set(id, at);
    else kept.delete(id);
  };

  /** Run one download (the page's `id`, if any, already registered as `entry`). */
  const transfer = async (
    a: Record<string, unknown>,
    ctx: DesktopCapCtx,
    req: { url: string; id: string | undefined; headers: Headers },
    entry: RunningDownload,
  ): Promise<{ path: string; bytes: number }> => {
    const timeout = AbortSignal.timeout(cfg.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
    const privateTarget = await checkDownloadUrl(req.url, cfg.resolveHost);
    const { target, root, single } = await resolveTarget(cfg, a.directory, a.path, true);
    if (busy.has(target)) throw inUse("that file");
    busy.add(target);
    // A file picked on its own grants that file only: its partial goes in the app's cache dir.
    const at = await partialAt(target, single ? cfg.dirs.cache : undefined);
    const job = downloadJob(cfg, a, ctx, {
      ...req,
      target,
      at,
      privateTarget,
      signal: AbortSignal.any([ctx.signal, timeout, entry.stop.signal]),
    });
    const record = downloadRecorder(records, a, req);
    try {
      await record.start();
      await mkdirp(root);
      await onDisk(() => mkdirp(dirname(target)));
      const bytes = await runDownload(job);
      entry.done = true;
      remember(req.id, at, false);
      await record.done(target, bytes);
      return { path: target, bytes };
    } catch (err) {
      const failure = await downloadFailure(err, job, entry.stop.signal, ctx.signal, timeout);
      entry.paused = failure.code === "paused";
      const keeps = (failure.data as { bytes?: unknown } | undefined)?.bytes;
      remember(req.id, at, typeof keeps === "number" && keeps > 0);
      await record.stopped(failure, stopWhy(entry.stop.signal));
      throw failure;
    } finally {
      busy.delete(target);
    }
  };

  /**
   * A resume that sends no headers of its own continues with the ones its record kept (the page
   * that started it may be gone, after a restart), when the record names the same URL and file.
   * Credential headers are never written to disk, so a record loaded after a restart that had one
   * (`withheld`) is refused: the page starts it again with its headers, from the partial file.
   */
  const resumeHeaders = (
    a: Record<string, unknown>,
    req: { url: string; id: string | undefined; headers: Headers },
  ): Headers => {
    if (req.id === undefined || !noHeaders(req.headers)) return req.headers;
    const r = records.get(req.id);
    const same = r !== undefined && r.url === req.url && r.directory === a.directory &&
      r.path === a.path;
    if (!same) return req.headers;
    if (r.withheld) {
      throw badInput(
        `download ${req.id}'s credential headers are not kept across a restart: ` +
          "start it again with its headers (it continues from its partial file)",
      );
    }
    return new Headers(r.headers);
  };

  /** The `download` (or, with `resume`, `resumeDownload`) method. */
  const downloadMethod = (resume: boolean): DesktopCapability["methods"][string] => ({
    // The runtime fetches the URL itself; the bridge deadline is off (a large file may take a
    // while) and the download enforces its own timeout and byte cap instead.
    timeoutMs: false,
    permissions: { write: [...cfg.write], net: ["*"] },
    handler: async (args, ctx) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const checked = downloadArgs(a);
      if (checked.id !== undefined && running.has(checked.id)) {
        throw inUse(`download ${checked.id}`);
      }
      // Registered before the first await, so a pause or cancel can never slip in ahead of it.
      const settled = Promise.withResolvers<void>();
      const entry: RunningDownload = {
        stop: new AbortController(),
        settled: settled.promise,
        paused: false,
        done: false,
      };
      if (checked.id !== undefined) running.set(checked.id, entry);
      try {
        await ready();
        const req = resume ? { ...checked, headers: resumeHeaders(a, checked) } : checked;
        return await transfer(a, ctx, req, entry);
      } finally {
        if (checked.id !== undefined) running.delete(checked.id);
        settled.resolve();
      }
    },
  });

  /** Stop running download `id` for `why`; resolves once it has stopped (or `undefined`). */
  const stopRunning = async (args: unknown, why: StopWhy) => {
    const id = controlId(args);
    const entry = id === undefined ? undefined : running.get(id);
    if (entry) {
      entry.stop.abort(why);
      await entry.settled;
    }
    return { id, entry };
  };

  /** Drop the partial download `id` kept (and its record): whether there was one to drop. */
  const dropKept = async (id: string): Promise<boolean> => {
    const at = kept.get(id);
    if (at !== undefined) {
      if (busy.has(at.target)) return false;
      kept.delete(id);
      await discardPartial(at);
      await records.remove(id);
      return true;
    }
    const r = records.get(id);
    // A done download is the user's file: a cancel that comes after it is too late.
    if (!r || r.state === "done" || r.state === "running") return false;
    const recordAt = await recordPartial(r);
    if (recordAt && busy.has(recordAt.target)) return false;
    if (recordAt) await discardPartial(recordAt);
    await records.remove(id);
    return true;
  };

  return {
    download: downloadMethod(false),
    // The same download: it continues the partial a paused or interrupted one kept for the same
    // URL and file (this launch's or an earlier one's), else starts over.
    resumeDownload: downloadMethod(true),
    pauseDownload: {
      // Answers once the download has stopped, its partial file and sidecar kept.
      handler: async (args) => {
        const { entry } = await stopRunning(args, "pause");
        return { paused: entry?.paused === true };
      },
    },
    cancelDownload: {
      // Answers once the download has stopped and its partial file is gone; a paused (or failed)
      // one's kept partial is dropped too, an earlier launch's included. One that finished first
      // is not cancelled: its file stays.
      handler: async (args) => {
        const id = controlId(args);
        if (id !== undefined && !running.has(id)) await ready();
        const { entry } = await stopRunning(args, "cancel");
        if (entry) return { cancelled: !entry.done };
        return { cancelled: id !== undefined && (await dropKept(id)) };
      },
    },
    listDownloads: {
      // The recorded downloads (those started with an id into an app folder): running, paused,
      // failed, and done ones not yet forgotten — an earlier launch's included.
      handler: async () => {
        await ready();
        return { transfers: records.all().map(recordInfo) };
      },
    },
    forgetDownload: {
      // Drops a settled download's record (a failed one's kept partial file with it).
      handler: async (args) => {
        const id = controlId(args);
        await ready();
        const r = id === undefined ? undefined : records.get(id);
        if (!r || r.state === "running" || r.state === "paused" || running.has(r.id)) {
          return { forgotten: false };
        }
        if (r.state === "failed") await dropKept(r.id);
        await records.remove(r.id);
        return { forgotten: true };
      },
    },
  };
}

/**
 * Build the `fs` capability over `cfg`. The factory closes over the resolved base dirs and the
 * read/write scope; every method confines its path before touching the disk.
 *
 * @param cfg The resolved directories and the read/write token scope.
 * @returns The `fs` {@link DesktopCapability}.
 */
export function fsCapability(cfg: FsCapabilityConfig): DesktopCapability {
  return {
    name: "fs",
    events: ["progress"],
    methods: {
      readFile: {
        permissions: { read: [...cfg.read] },
        handler: async (args) => {
          const a = (args ?? {}) as { path?: unknown; directory?: unknown; encoding?: unknown };
          const encoding = encodingOf(a.encoding);
          const { target } = await resolveTarget(cfg, a.directory, a.path, false);
          if (encoding === "utf8") return await Deno.readTextFile(target);
          return bytesToBase64(await Deno.readFile(target));
        },
      },
      writeFile: {
        permissions: { write: [...cfg.write] },
        handler: async (args) => {
          const a = (args ?? {}) as {
            path?: unknown;
            data?: unknown;
            directory?: unknown;
            encoding?: unknown;
            recursive?: unknown;
          };
          const encoding = encodingOf(a.encoding);
          if (typeof a.data !== "string") throw badInput("data must be a string");
          const { target, root } = await resolveTarget(cfg, a.directory, a.path, true);
          await mkdirp(root);
          if (a.recursive === true) await mkdirp(dirname(target));
          if (encoding === "utf8") await Deno.writeTextFile(target, a.data);
          else await Deno.writeFile(target, base64ToBytes(a.data));
          return { path: target };
        },
      },
      deleteFile: {
        permissions: { write: [...cfg.write] },
        handler: async (args) => {
          const a = (args ?? {}) as { path?: unknown; directory?: unknown };
          const { target } = await resolveTarget(cfg, a.directory, a.path, true);
          await Deno.remove(target).catch((err) => {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          });
          return { ok: true };
        },
      },
      listDir: {
        permissions: { read: [...cfg.read] },
        handler: async (args) => {
          const a = (args ?? {}) as { path?: unknown; directory?: unknown };
          const { target } = await resolveTarget(cfg, a.directory, a.path, false, true);
          // The data root's listing leaves the runtime-owned sub-directories out.
          const hide = await sameDir(target, cfg.dirs.data);
          const entries: FileEntry[] = [];
          try {
            for await (const e of Deno.readDir(target)) {
              if (hide && isReservedDataName(e.name)) continue;
              entries.push(await toFileEntry(target, e.name, e.isDirectory));
            }
          } catch (err) {
            if (err instanceof Deno.errors.NotFound) return [];
            throw err;
          }
          return entries;
        },
      },
      ...downloadMethods(cfg),
    },
  };
}
