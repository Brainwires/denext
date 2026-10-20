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
import { confineRelative, isReservedDataName, refuseReservedDataPath } from "../path-scope.ts";
import type { PickedPaths } from "../picked-paths.ts";

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
export async function checkDownloadUrl(url: string, resolve?: HostResolver): Promise<void> {
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
  if (ipv4Octets(parsed.hostname) || parsed.hostname.startsWith("[")) return; // an IP literal
  const addresses = await (resolve ?? defaultResolveHost)(parsed.hostname);
  if (addresses.some(isRefusedDownloadHost)) {
    throw refusedTarget("the host resolves to a loopback/link-local address");
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

/**
 * `fetch` with redirects followed BY HAND, re-checking every hop with {@link checkDownloadUrl}.
 * Like a browser's `fetch`, a redirect to another origin drops `Authorization`.
 */
async function fetchChecked(
  url: string,
  signal: AbortSignal,
  cfg: FsCapabilityConfig,
  headers: Headers,
): Promise<Response> {
  const doFetch = cfg.fetch ?? fetch;
  let current = url;
  for (let hop = 0;; hop++) {
    const res = await doFetch(current, { signal, redirect: "manual", headers });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || location === null) return res;
    await res.body?.cancel();
    if (hop >= MAX_DOWNLOAD_REDIRECTS) {
      throw new DesktopCapError("network", "too many redirects");
    }
    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) headers.delete("authorization");
    current = next.href;
    await checkDownloadUrl(current, cfg.resolveHost);
  }
}

/** The most of a failed answer's body a download keeps for the page (bytes of text). */
const MAX_ERROR_BODY_CHARS = 64 * 1024;

/** A non-2xx answer as the page's error: `download_failed` with the status and (some of) the body. */
async function httpFailure(res: Response): Promise<DesktopCapError> {
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

/**
 * Stream `res`'s body to `target` through a `.part` file, aborting past `maxBytes` (nothing is
 * left behind on failure, a cancel included), then rename it into place. Resolves the size.
 */
async function writeCapped(
  res: Response,
  target: string,
  maxBytes: number,
  progress: ProgressReporter = () => {},
): Promise<number> {
  const total = declaredLength(res);
  if (total !== null && total > maxBytes) {
    await res.body?.cancel();
    throw new DesktopCapError("too_large", `the download is over ${maxBytes} bytes`);
  }
  const part = `${target}.${crypto.randomUUID()}.part`;
  const file = await onDisk(() => Deno.open(part, { write: true, createNew: true }));
  let ok = false;
  let bytes = 0;
  try {
    progress(0, total, true);
    for await (const chunk of res.body ?? new ReadableStream<Uint8Array>()) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new DesktopCapError("too_large", `the download is over ${maxBytes} bytes`);
      }
      await onDisk(() => writeAll(file, chunk));
      progress(bytes, total);
    }
    ok = true;
  } finally {
    file.close();
    if (!ok) await Deno.remove(part).catch(() => {});
  }
  await onDisk(() => Deno.rename(part, target));
  return bytes;
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
): Promise<{ target: string; root: string }> {
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

/**
 * Build the `fs` capability over `cfg`. The factory closes over the resolved base dirs and the
 * read/write scope; every method confines its path before touching the disk.
 *
 * @param cfg The resolved directories and the read/write token scope.
 * @returns The `fs` {@link DesktopCapability}.
 */
export function fsCapability(cfg: FsCapabilityConfig): DesktopCapability {
  /** The downloads running under a page-given id (for `cancelDownload`). */
  const running = new Map<string, { cancel: AbortController; settled: Promise<void> }>();
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
      download: {
        // The runtime fetches the URL itself; the bridge deadline is off (a large file may take a
        // while) and the download enforces its own timeout and byte cap instead.
        timeoutMs: false,
        permissions: { write: [...cfg.write], net: ["*"] },
        handler: async (args, ctx) => {
          const a = (args ?? {}) as {
            url?: unknown;
            path?: unknown;
            directory?: unknown;
            id?: unknown;
            headers?: unknown;
          };
          const { url, id, headers } = downloadArgs(a);
          if (id !== undefined && running.has(id)) {
            throw new DesktopCapError("exists", `download ${id} is already running`, {
              status: 409,
            });
          }
          // Registered before the first await, so a cancel can never slip in ahead of it.
          const cancel = new AbortController();
          const settled = Promise.withResolvers<void>();
          if (id !== undefined) running.set(id, { cancel, settled: settled.promise });
          const timeout = AbortSignal.timeout(cfg.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
          const signal = AbortSignal.any([ctx.signal, timeout, cancel.signal]);
          try {
            await checkDownloadUrl(url, cfg.resolveHost);
            const { target, root } = await resolveTarget(cfg, a.directory, a.path, true);
            await mkdirp(root);
            // A failure past this point is the network's, a cancel, or the disk's (`io`).
            const stopped = (err: unknown): never => {
              throw stoppedError(err, AbortSignal.any([ctx.signal, cancel.signal]), timeout);
            };
            const res = await fetchChecked(url, signal, cfg, headers).catch(stopped);
            if (!res.ok) throw await httpFailure(res);
            await onDisk(() => mkdirp(dirname(target)));
            const bytes = await writeCapped(
              res,
              target,
              cfg.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
              progressReporter(ctx, id),
            ).catch(stopped);
            return { path: target, bytes };
          } finally {
            if (id !== undefined) running.delete(id);
            settled.resolve();
          }
        },
      },
      cancelDownload: {
        // Answers once the download has stopped and its partial file is gone.
        handler: async (args) => {
          const id = downloadId((args as { id?: unknown } | null)?.id);
          const entry = id === undefined ? undefined : running.get(id);
          if (!entry) return { cancelled: false };
          entry.cancel.abort();
          await entry.settled;
          return { cancelled: true };
        },
      },
    },
  };
}
