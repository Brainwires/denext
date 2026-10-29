// The pieces the pinned downloads share — the Deno Desktop runtime (desktop-runtime.ts) and
// denext's Deno toolchain (deno-toolchain.ts): streaming a download to a new file while hashing it
// and refusing it the moment it outgrows its pin, hashing a file on disk, reading a JSON marker,
// and sweeping what a crashed install left behind.

import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";

/**
 * The lowercase hex SHA-256 of the file at `path`.
 *
 * @param path The file.
 * @returns Its hash.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  // The readable closes the file once drained.
  const f = await Deno.open(path, { read: true });
  for await (const chunk of f.readable) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The parsed JSON at `path`, or `null` when it is missing or malformed.
 *
 * @param path The file.
 * @returns Its contents.
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

/**
 * Remove the `.tmp-*` / `.stale-*` entries (files or directories) of `dir` older than a day: what
 * a crashed or raced install left behind.
 *
 * @param dir The directory to sweep.
 */
export async function sweepLeftovers(dir: string): Promise<void> {
  const cutoff = Date.now() - 24 * 3600_000;
  for await (const e of Deno.readDir(dir)) {
    if (!/^\.(tmp|stale)-/.test(e.name)) continue;
    const path = join(dir, e.name);
    const mtime = (await Deno.lstat(path).catch(() => null))?.mtime?.getTime();
    if (mtime !== undefined && mtime < cutoff) {
      await Deno.remove(path, { recursive: true }).catch(() => {});
    }
  }
}

/** Raised when a cache directory may be written by another user (see {@linkcode assertTrustedCacheDirs}). */
export class UntrustedCacheDirError extends Error {
  override name = "UntrustedCacheDirError";
}

/** What {@linkcode assertTrustedCacheDirs} reads from the process (injectable for tests). */
export interface TrustedCacheDirSeams {
  /** The OS (default `Deno.build.os`); Windows is not checked (its ACLs are no mode bits). */
  readonly os?: string;
  /** This process's user id (default `Deno.uid()`; `null` when it can't be read). */
  readonly uid?: number | null;
  /** Stat a path (default `Deno.stat`). */
  readonly stat?: (path: string) => Promise<Deno.FileInfo>;
}

/** `Deno.uid()`, or `null` without the grant. */
function processUid(): number | null {
  try {
    return Deno.uid();
  } catch {
    return null;
  }
}

/**
 * Refuse to trust a download cache another user can change. A binary cached under a directory
 * another user owns, or that anyone may write into (world-writable without the sticky bit), may
 * have been planted or swapped by that user, stamp and all, and so may the cache's lock files (a
 * symlink there makes this process create a file wherever it points). Each existing directory of
 * `dirs` must be owned by this user (or by root) and must not be world-writable unless it is
 * sticky. A missing directory is skipped: this process creates it. Not checked on Windows, and only
 * world-writability is checked where this process may not read its own user id.
 *
 * @param dirs The cache directories, outermost first (`DENO_DIR` down to the binary's own).
 * @param seams Test seams.
 * @throws {UntrustedCacheDirError} When one of them is not this user's alone.
 */
export async function assertTrustedCacheDirs(
  dirs: readonly string[],
  seams: TrustedCacheDirSeams = {},
): Promise<void> {
  if ((seams.os ?? Deno.build.os) === "windows") return;
  const uid = seams.uid !== undefined ? seams.uid : processUid();
  const stat = seams.stat ?? Deno.stat;
  for (const dir of dirs) {
    const info = await stat(dir).catch(() => null);
    if (!info) continue;
    const why = untrustedWhy(info, uid);
    if (why === null) continue;
    throw new UntrustedCacheDirError(
      `denext: refusing the cache directory ${dir}: it ${why}, so another user could replace ` +
        "what denext would run from it.\n  Fix: point DENO_DIR at a directory only you can write " +
        `(or \`chown -R $(id -u) ${dir}\` and \`chmod o-w ${dir}\`), then retry.`,
    );
  }
}

/** Why a cache directory is not this user's alone, or `null`. */
function untrustedWhy(info: Deno.FileInfo, uid: number | null): string | null {
  const owner = info.uid;
  if (uid !== null && owner !== null && owner !== uid && owner !== 0) {
    return `is owned by user ${owner}, not you (${uid})`;
  }
  const mode = info.mode;
  if (mode !== null && (mode & 0o002) !== 0 && (mode & 0o1000) === 0) {
    return "is writable by every user";
  }
  return null;
}

/**
 * The directories from `outer` down to `inner` (both included), outermost first: what
 * {@linkcode assertTrustedCacheDirs} checks for a binary in `inner` of a cache under `outer`.
 * Just `[outer, inner]` when `inner` is not under `outer`.
 *
 * @param outer The outermost directory (`DENO_DIR`).
 * @param inner The binary's directory.
 * @returns The chain.
 */
export function cacheDirChain(outer: string, inner: string): string[] {
  const out: string[] = [];
  let at = inner;
  while (at !== outer) {
    out.unshift(at);
    const up = dirname(at);
    if (up === at) return [outer, inner];
    at = up;
  }
  return [outer, ...out];
}

/** How {@linkcode streamHashed} words its two refusals. */
export interface StreamHashedErrors {
  /** The download outgrew its pinned size (thrown as is). */
  readonly tooLarge: () => Error;
  /** The stream or a write failed after `size` bytes. */
  readonly interrupted: (size: number, cause: unknown) => Error;
}

/** A download's progress line ({@linkcode downloadProgress}). */
export interface DownloadProgress {
  /** The bytes received so far. */
  update(bytes: number): void;
  /** Clear the line (the download ended, either way). */
  done(): void;
}

/** The seams of {@linkcode downloadProgress} (all default to the process's stderr and clock). */
export interface DownloadProgressOptions {
  /** Whether stderr is a terminal (no line otherwise: a log or CI gets nothing). */
  readonly isTerminal?: () => boolean;
  /** Write raw text to stderr. */
  readonly write?: (text: string) => void;
  /** Milliseconds now. */
  readonly now?: () => number;
  /** The least time between two redraws, in ms (default 100). */
  readonly intervalMs?: number;
}

/** `12.3 MB` (decimal megabytes, one decimal). */
function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * One self-redrawing stderr line for a download — `  <what>: 12.3 / 69.6 MB (17%)`, or just the
 * bytes when the total is unknown — redrawn at most every 100 ms and cleared when it ends. Silent
 * when stderr is not a terminal, so logs and CI output stay clean.
 *
 * @param what What is being downloaded (`denext's Deno toolchain 2.9.7-denext.22`).
 * @param total Its size in bytes, when known.
 * @param options Seams for tests.
 * @returns The reporter.
 */
export function downloadProgress(
  what: string,
  total: number | undefined,
  options: DownloadProgressOptions = {},
): DownloadProgress {
  const terminal = (options.isTerminal ?? (() => Deno.stderr.isTerminal()))();
  const encoder = new TextEncoder();
  const write = options.write ?? ((t: string) => void Deno.stderr.writeSync(encoder.encode(t)));
  const now = options.now ?? (() => Date.now());
  const interval = options.intervalMs ?? 100;
  let last = -Infinity;
  let drawn = false;
  return {
    update(bytes) {
      if (!terminal) return;
      const t = now();
      const finished = total !== undefined && bytes >= total;
      if (t - last < interval && !finished) return;
      last = t;
      const amount = total
        ? `${megabytes(bytes)} / ${megabytes(total)} (${Math.floor((bytes / total) * 100)}%)`
        : megabytes(bytes);
      write(`\r\x1b[2K  ${what}: ${amount}`);
      drawn = true;
    },
    done() {
      if (drawn) write("\r\x1b[2K");
      drawn = false;
    },
  };
}

/** Which of a download's deadlines fired. */
type DownloadDeadlineKind = "connect" | "idle";

/** The variable that sets each deadline. */
const DEADLINE_ENV = {
  connect: "DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS",
  idle: "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS",
} as const;

/** `10 s`, `0.2 s`. */
function seconds(ms: number): string {
  return `${ms / 1000} s`;
}

/** A download that hit one of its deadlines: worth a retry on a new connection. */
class DownloadDeadlineError extends Error {
  /**
   * @param kind Which deadline fired.
   * @param afterMs The deadline, in ms.
   * @param message The error's message.
   */
  constructor(
    readonly kind: DownloadDeadlineKind,
    readonly afterMs: number,
    message: string,
  ) {
    super(message);
    this.name = "DownloadDeadlineError";
  }

  /** The variable that sets this deadline. */
  get envVar(): string {
    return DEADLINE_ENV[this.kind];
  }

  /** One line for a per-attempt report: what fired, and the variable that sets it. */
  get summary(): string {
    const what = this.kind === "connect" ? "no response within" : "no data for";
    return `${what} ${seconds(this.afterMs)} (${this.envVar})`;
  }
}

/** A download that sent no response headers within its connect deadline. */
export class DownloadConnectError extends DownloadDeadlineError {
  /**
   * @param connectMs The deadline it missed.
   */
  constructor(connectMs: number) {
    super(
      "connect",
      connectMs,
      `no response within ${seconds(connectMs)} (DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS raises it)`,
    );
    this.name = "DownloadConnectError";
  }
}

/** A download that sent no bytes for its idle deadline (the connection is half-open, say). */
export class DownloadIdleError extends DownloadDeadlineError {
  /**
   * @param idleMs How long it went without a byte.
   */
  constructor(idleMs: number) {
    super("idle", idleMs, `no data for ${seconds(idleMs)}; the connection looks stalled`);
    this.name = "DownloadIdleError";
  }
}

/** The connection failed (the request could not be sent, or the body broke off): worth a retry. */
export class DownloadNetworkError extends Error {
  override name = "DownloadNetworkError";
}

/** A download answered with an HTTP error; 408, 429 and 5xx are worth a retry. */
export class DownloadStatusError extends Error {
  /**
   * @param url The download.
   * @param status The HTTP status.
   * @param statusText Its reason phrase.
   */
  constructor(url: string, readonly status: number, statusText: string) {
    super(`GET ${url} → ${status} ${statusText}`.trimEnd());
    this.name = "DownloadStatusError";
  }
}

/**
 * `res`'s body when it answered with success, else (its body cancelled) the error `refuse` makes
 * of its status: a {@linkcode DownloadStatusError}, for the error's `cause`.
 *
 * @param res The response.
 * @param url The download (for the message).
 * @param refuse Wraps the status error in the caller's own.
 * @returns The body to stream.
 */
export async function responseBody(
  res: Response,
  url: string,
  refuse: (status: DownloadStatusError) => Error,
): Promise<ReadableStream<Uint8Array>> {
  if (res.ok && res.body) return res.body;
  await res.body?.cancel();
  throw refuse(new DownloadStatusError(url, res.status, res.statusText));
}

/** The first of `err` and its causes that tells why a download failed, or `null`. */
function downloadCause(
  err: unknown,
): DownloadDeadlineError | DownloadNetworkError | DownloadStatusError | null {
  for (let e = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (
      e instanceof DownloadDeadlineError || e instanceof DownloadNetworkError ||
      e instanceof DownloadStatusError
    ) return e;
  }
  return null;
}

/**
 * Whether a failed download is worth another attempt on a new connection: a deadline fired, the
 * connection failed, or the server answered 408, 429 or 5xx (found on `err` or its `cause` chain).
 * A refusal of what arrived (too large, truncated, a SHA-256 mismatch) is not.
 *
 * @param err What the attempt threw.
 * @returns Whether to retry.
 */
function retryableDownloadFailure(err: unknown): boolean {
  const cause = downloadCause(err);
  if (!(cause instanceof DownloadStatusError)) return cause !== null;
  // A retry may well get another answer.
  return cause.status === 408 || cause.status === 429 || cause.status >= 500;
}

/** One line for the per-attempt report. */
function attemptSummary(err: unknown): string {
  const cause = downloadCause(err);
  if (cause instanceof DownloadDeadlineError) return cause.summary;
  const message = cause?.message ?? (err instanceof Error ? err.message : String(err));
  return message.split("\n")[0];
}

/**
 * `body`'s chunks, cancelling it and throwing {@linkcode DownloadIdleError} when no chunk arrives
 * for `idleMs` (`Infinity`: no deadline). A read that fails is a {@linkcode DownloadNetworkError}. A
 * consumer that stops early (a download refused as too large) cancels it too, so the response and
 * its connection are let go rather than left open.
 *
 * @param body The download.
 * @param idleMs The most time between two chunks.
 * @returns The chunks.
 */
async function* idleBounded(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let settled = false; // the body ended, or the read failed (and cancelled it)
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        if (Number.isFinite(idleMs)) {
          timer = setTimeout(() => reject(new DownloadIdleError(idleMs)), idleMs);
        }
      });
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([
          reader.read().catch((err) => {
            throw new DownloadNetworkError(err instanceof Error ? err.message : String(err), {
              cause: err,
            });
          }),
          idle,
        ]);
      } catch (err) {
        settled = true;
        reader.cancel(err).catch(() => {});
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (next.done) {
        settled = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!settled) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Stream `body` into the NEW file `dest` (it must not exist), hashing it as it goes and refusing it
 * as soon as it holds more than `maxSize` bytes, or once it sends nothing for `idleMs`.
 *
 * @param body The download.
 * @param dest The file to create.
 * @param maxSize The most bytes accepted.
 * @param errors The refusals' wording.
 * @param progress Told the running byte count after each chunk (a {@linkcode downloadProgress}).
 * @param idleMs The most time between two chunks (default: no deadline).
 * @returns The byte count and SHA-256.
 */
export async function streamHashed(
  body: ReadableStream<Uint8Array>,
  dest: string,
  maxSize: number,
  errors: StreamHashedErrors,
  progress?: (bytes: number) => void,
  idleMs = Infinity,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  let refused: Error | null = null;
  const file = await Deno.open(dest, { write: true, createNew: true });
  try {
    for await (const chunk of idleBounded(body, idleMs)) {
      size += chunk.byteLength;
      if (size > maxSize) throw (refused = errors.tooLarge());
      hash.update(chunk);
      for (let off = 0; off < chunk.byteLength;) off += await file.write(chunk.subarray(off));
      progress?.(size);
    }
  } catch (err) {
    if (err === refused) throw err;
    throw errors.interrupted(size, err);
  } finally {
    file.close();
  }
  return { size, sha256: hash.digest("hex") };
}

/** The default deadline for a download's response headers (ms). */
const CONNECT_TIMEOUT_MS = 10_000;
/** The default longest gap between two chunks of a download's body (ms). */
const IDLE_TIMEOUT_MS = 20_000;
/** The default number of attempts a download gets, each on a new connection. */
const DOWNLOAD_ATTEMPTS = 4;
/** The default time after which no new attempt starts (ms since the first). */
const TOTAL_TIMEOUT_MS = 120_000;

/** The deadlines and retry budget of one download ({@linkcode downloadDeadlines}). */
export interface DownloadDeadlines {
  /** Until the response headers arrive, in ms (`Infinity`: none). */
  readonly connectMs: number;
  /** The longest gap between two chunks of the body, in ms (`Infinity`: none). */
  readonly idleMs: number;
  /** Attempts in all (at least 1). */
  readonly attempts: number;
  /** No new attempt starts once this much time has passed since the first (`Infinity`: none). */
  readonly totalMs: number;
}

/**
 * A download deadline: `DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS` / `DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS` /
 * `DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS` when set (milliseconds; `0` for none), else the default.
 *
 * @param name The variable.
 * @param fallback The default.
 * @param env Env reader.
 * @returns The deadline (`Infinity`: none).
 */
export function downloadTimeoutMs(
  name:
    | "DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS"
    | "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS"
    | "DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS",
  fallback: number,
  env: (k: string) => string | undefined = envGet,
): number {
  const raw = env(name)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return Number(raw) === 0 ? Infinity : Number(raw);
}

/**
 * The deadlines and retry budget every pinned download runs under, from the environment:
 * `DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS` (10 s), `DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS` (20 s),
 * `DENEXT_DOWNLOAD_ATTEMPTS` (4) and `DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS` (120 s). `0` turns a
 * deadline off; a value that is not a whole number keeps the default, and so does an attempt
 * count of `0`.
 *
 * @param env Env reader.
 * @returns The deadlines.
 */
export function downloadDeadlines(
  env: (k: string) => string | undefined = envGet,
): DownloadDeadlines {
  const raw = env("DENEXT_DOWNLOAD_ATTEMPTS")?.trim();
  const attempts = raw && /^\d+$/.test(raw) && Number(raw) >= 1
    ? Math.min(Number(raw), 100)
    : DOWNLOAD_ATTEMPTS;
  return {
    connectMs: downloadTimeoutMs("DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS", CONNECT_TIMEOUT_MS, env),
    idleMs: downloadTimeoutMs("DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS", IDLE_TIMEOUT_MS, env),
    attempts,
    totalMs: downloadTimeoutMs("DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS", TOTAL_TIMEOUT_MS, env),
  };
}

/** One environment variable, or `undefined` (unset, or no env permission). */
function envGet(k: string): string | undefined {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined;
  }
}

/**
 * The wait before retry number `retry` (from 1), in ms: exponential from 250 ms, capped at 4 s,
 * with "equal jitter" (half fixed, half random), so downloads that failed together don't retry in
 * lockstep.
 *
 * @param retry Which retry (1 for the first).
 * @param random A number in [0, 1) (default `Math.random`).
 * @returns The wait.
 */
export function retryWaitMs(retry: number, random: () => number = Math.random): number {
  const exp = Math.min(250 * 2 ** Math.min(Math.max(retry - 1, 0), 16), 4_000);
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * GET `url`, given up on with {@linkcode DownloadConnectError} when no response headers arrive
 * within `connectMs`. A request that fails outright (a `TypeError`: refused, reset, DNS) is a
 * {@linkcode DownloadNetworkError}; anything else (a permission refusal) is thrown as is.
 *
 * @param fetchImpl `fetch`.
 * @param url The download.
 * @param headers Request headers, if any.
 * @param connectMs The deadline (default `DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS`, else 10 s).
 * @returns The response (its body still to be read).
 */
export async function fetchWithConnectDeadline(
  fetchImpl: typeof fetch,
  url: string,
  headers?: Readonly<Record<string, string>>,
  connectMs: number = downloadTimeoutMs(
    "DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS",
    CONNECT_TIMEOUT_MS,
  ),
): Promise<Response> {
  const connect = new AbortController();
  const timer = Number.isFinite(connectMs)
    ? setTimeout(() => connect.abort(), connectMs)
    : undefined;
  try {
    return await fetchImpl(url, {
      redirect: "follow",
      signal: connect.signal,
      ...(headers ? { headers: { ...headers } } : {}),
    });
  } catch (err) {
    if (connect.signal.aborted) throw new DownloadConnectError(connectMs);
    if (err instanceof TypeError) {
      throw new DownloadNetworkError(err.message, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A new HTTP client, with its own connection pool, or `null` where the runtime has no
 * `Deno.createHttpClient` (or refuses one). It reads the same proxy variables and certificate
 * store as `fetch`'s default client.
 *
 * @returns The client; close it when the download is over.
 */
export function freshHttpClient(): Deno.HttpClient | null {
  try {
    return typeof Deno.createHttpClient === "function" ? Deno.createHttpClient({}) : null;
  } catch {
    return null;
  }
}

/** One attempt of {@linkcode withDownloadRetries}. */
export interface DownloadAttempt {
  /** `fetch` on this attempt's own HTTP client, so on a new connection. */
  readonly fetch: typeof fetch;
  /** Which attempt this is (from 1). */
  readonly number: number;
  /** The deadlines to apply. */
  readonly deadlines: DownloadDeadlines;
}

/** Options for {@linkcode withDownloadRetries} (all but `log` are test seams). */
export interface DownloadRetryOptions {
  /** Default: {@linkcode downloadDeadlines} from the environment. */
  readonly deadlines?: DownloadDeadlines;
  /** Where a retry is announced. */
  readonly log?: (line: string) => void;
  /** Wait between attempts. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** For the jitter. */
  readonly random?: () => number;
  /** Milliseconds now. */
  readonly now?: () => number;
  /** A new HTTP client per attempt (default {@linkcode freshHttpClient}). */
  readonly httpClient?: () => Deno.HttpClient | null;
}

/**
 * Run a download's `attempt` until it succeeds, retrying a stalled or broken connection (see
 * {@linkcode retryableDownloadFailure}) on a NEW connection — a fresh `Deno.createHttpClient()`
 * per attempt, closed after it, so a dead pooled or HTTP/2 connection is never reused — after an
 * exponential, jittered wait, up to `deadlines.attempts` attempts and no new one once
 * `deadlines.totalMs` has passed. `attempt` must leave nothing behind when it throws (a partial
 * file is deleted, never kept for the next attempt).
 *
 * A failure that is not worth a retry is thrown as is, and so is a single attempt's. When several
 * attempts failed, `fail` builds the error from a report of each attempt (which deadline fired,
 * or what failed).
 *
 * @param what Names the download in the retry line.
 * @param attempt One attempt.
 * @param fetchImpl The `fetch` each attempt's own goes through.
 * @param fail The error for several failed attempts, given the report (it starts with a space).
 * @param options Seams.
 * @returns What the successful attempt returned.
 */
export async function withDownloadRetries<T>(
  what: string,
  attempt: (a: DownloadAttempt) => Promise<T>,
  fetchImpl: typeof fetch,
  fail: (report: string) => Error,
  options: DownloadRetryOptions = {},
): Promise<T> {
  const deadlines = options.deadlines ?? downloadDeadlines();
  const budget = new RetryBudget(deadlines, options.now ?? Date.now, options.random);
  for (let number = 1;; number++) {
    const client = (options.httpClient ?? freshHttpClient)();
    budget.fresh &&= client !== null;
    const fetchOnce: typeof fetch = client
      ? (input, init) => fetchImpl(input, { ...init, client } as unknown as RequestInit)
      : fetchImpl;
    let wait: number | null;
    try {
      return await attempt({ fetch: fetchOnce, number, deadlines });
    } catch (err) {
      if (!retryableDownloadFailure(err) || deadlines.attempts === 1) throw err;
      wait = budget.record(err);
    } finally {
      client?.close();
    }
    if (wait === null) break;
    options.log?.(
      `  denext: ${what}: ${budget.last}; retrying on a new connection ` +
        `(attempt ${number + 1} of ${deadlines.attempts})…`,
    );
    await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
  }
  throw fail(budget.report());
}

/** Counts a download's failed attempts against its {@linkcode DownloadDeadlines}. */
class RetryBudget {
  /** Whether every attempt so far had a new HTTP client. */
  fresh = true;
  readonly #failures: string[] = [];
  readonly #started: number;
  #stoppedByTotal = false;
  readonly #deadlines: DownloadDeadlines;
  readonly #now: () => number;
  readonly #random: (() => number) | undefined;

  /**
   * @param deadlines The attempt count and overall budget.
   * @param now Milliseconds now.
   * @param random For the jitter.
   */
  constructor(deadlines: DownloadDeadlines, now: () => number, random?: () => number) {
    this.#deadlines = deadlines;
    this.#now = now;
    this.#random = random;
    this.#started = now();
  }

  /** The last failure's summary. */
  get last(): string {
    return this.#failures.at(-1) ?? "";
  }

  /** Record a failed attempt: the wait before the next, or `null` when the budget is spent. */
  record(err: unknown): number | null {
    this.#failures.push(attemptSummary(err));
    const retries = this.#failures.length;
    if (retries >= this.#deadlines.attempts) return null;
    const wait = retryWaitMs(retries, this.#random);
    if (this.#now() - this.#started + wait < this.#deadlines.totalMs) return wait;
    this.#stoppedByTotal = true;
    return null;
  }

  /** The per-attempt report (it starts with a space). */
  report(): string {
    const count = this.#failures.length;
    const lines = this.#failures.map((f, i) => `\n    attempt ${i + 1}: ${f}`).join("");
    const total = this.#stoppedByTotal
      ? `\n    no more attempts after ${seconds(this.#deadlines.totalMs)} ` +
        "(DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS)"
      : "";
    return ` (${count} ${count === 1 ? "attempt" : "attempts"}` +
      `${this.fresh ? ", each on a new connection" : ""}):${lines}${total}\n    ` +
      "(DENEXT_DOWNLOAD_ATTEMPTS and the DENEXT_DOWNLOAD_*_TIMEOUT_MS deadlines change this; " +
      "0 turns a deadline off)";
  }
}
