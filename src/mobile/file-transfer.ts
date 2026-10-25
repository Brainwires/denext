/**
 * File transfers with progress for `denext/mobile`: the engine behind `downloadToFile()` and
 * `uploadFile()` (in the filesystem module), and the controls every transfer shares —
 * {@linkcode pauseFileTransfer}, {@linkcode resumeFileTransfer}, {@linkcode cancelFileTransfer},
 * {@linkcode fileTransfers}, {@linkcode forgetFileTransfer} and {@linkcode onFileTransfer}.
 *
 * - In the iOS/Android shell with denext's `DenextTransfer` plugin (`denext mobile add
 *   file-transfer`), a transfer runs natively and outlives the page: a `URLSession` background
 *   session on iOS, a WorkManager job on Android. It carries on while the app is in the
 *   background (and, on iOS, after the system terminates it), and the plugin keeps its record, so
 *   {@linkcode fileTransfers} reports a transfer that finished while the page was gone.
 * - In a Deno Desktop window the runtime runs a download (`fs.download`); the page tracks it
 *   (listed, evented, cancelled through `fs.cancelDownload`), but it cannot pause.
 * - Elsewhere it runs in the page: `fetch` with the body read as a stream (download progress,
 *   pause and a range-request resume) and `XMLHttpRequest` for uploads (upload progress), so it
 *   lasts as long as the page does.
 *
 * @module
 */

import { withLocalNetworkHint } from "./local-network.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** A transfer's direction. */
export type FileTransferKind = "download" | "upload";

/** Where a transfer is: running, paused, or settled (done, failed, cancelled). */
export type FileTransferState = "running" | "paused" | "done" | "failed" | "cancelled";

/** Bytes moved so far, for an `onProgress` callback. */
export interface FileTransferProgress {
  /** The transfer's id. */
  readonly id: string;
  /** Download or upload. */
  readonly kind: FileTransferKind;
  /** Bytes so far. */
  readonly bytes: number;
  /** The size, when the server (or the file) says; `null` when unknown. */
  readonly total: number | null;
}

/** A transfer as {@linkcode fileTransfers} reports it. */
export interface FileTransferInfo extends FileTransferProgress {
  /** The URL. */
  readonly url: string;
  /** The app folder of the file (`"data"`, `"documents"`, `"cache"`), or `"picked"`. */
  readonly directory: string;
  /** The file's path inside it. */
  readonly path: string;
  /** Where it is. */
  readonly state: FileTransferState;
  /** Whether a paused or failed download can continue where it stopped. */
  readonly resumable: boolean;
  /** The HTTP status, once the server answered. */
  readonly status?: number;
  /** A failure's code (`"HTTP"`, `"NETWORK"`, `"IO"`, …) and message. */
  readonly code?: string;
  /** A failure's message. */
  readonly error?: string;
  /** A finished download: the file's native path (the shell) or its OPFS path (the web). */
  readonly file?: string;
}

/** One transfer event, for {@linkcode onFileTransfer}. */
export interface FileTransferEvent extends FileTransferInfo {
  /** What happened. */
  readonly type: "started" | "progress" | "paused" | "done" | "failed" | "cancelled";
  /** A finished (or failed) upload: the response body (up to 1 MiB). */
  readonly body?: string;
  /** A finished transfer: the response headers, names lower-cased. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Options every transfer takes (with `directory`, the file's folder). */
export interface FileTransferOptions {
  /**
   * The transfer's id: give one to find it again after a relaunch ({@linkcode fileTransfers}).
   * Default: a random UUID.
   */
  readonly id?: string;
  /** Request headers (an `Authorization`, a signed upload's headers). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Called as bytes move: at most every 200 ms natively (100 ms in the page), and at the end. */
  readonly onProgress?: (progress: FileTransferProgress) => void;
  /** Aborting it cancels the transfer; the promise rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /**
   * In the shell, run in the OS's background transfer service (default `true`): it outlives
   * the app being suspended. `false` uses a foreground session on iOS (Android always uses
   * WorkManager).
   */
  readonly background?: boolean;
}

/** What an upload answered. */
export interface UploadFileResult {
  /** The HTTP status (2xx: anything else rejects). */
  readonly status: number;
  /** The response headers, names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** The response body as text (up to 1 MiB in the shell). */
  readonly body: string;
}

/** The codes a {@linkcode FileTransferError} carries. */
export type FileTransferErrorCode =
  | "HTTP"
  | "NETWORK"
  | "IO"
  | "INVALID"
  | "NOT_FOUND"
  | "EXISTS"
  | "CANCELLED";

/** A transfer that failed: the code, and for an HTTP failure the status and the body. */
export class FileTransferError extends Error {
  /** What went wrong. */
  readonly code: FileTransferErrorCode;
  /** The transfer's id. */
  readonly id: string;
  /** An HTTP failure's status. */
  readonly status?: number;
  /** An HTTP failure's response body, when there was one. */
  readonly body?: string;
  /** Whether {@linkcode resumeFileTransfer} can continue it where it stopped. */
  readonly resumable: boolean;

  /**
   * A failed transfer's error.
   *
   * @param message The message.
   * @param init The code, the transfer's id, and the HTTP status / body / resumability.
   */
  constructor(
    message: string,
    init: {
      code: FileTransferErrorCode;
      id: string;
      status?: number;
      body?: string;
      resumable?: boolean;
    },
  ) {
    super(message);
    this.name = "FileTransferError";
    this.code = init.code;
    this.id = init.id;
    if (init.status !== undefined) this.status = init.status;
    if (init.body !== undefined) this.body = init.body;
    this.resumable = init.resumable === true;
  }
}

// --- the native plugin --------------------------------------------------------------------

/** A record or event as the plugin sends it. */
interface RawTransfer {
  id?: unknown;
  type?: unknown;
  kind?: unknown;
  url?: unknown;
  directory?: unknown;
  path?: unknown;
  state?: unknown;
  bytes?: unknown;
  total?: unknown;
  status?: unknown;
  code?: unknown;
  error?: unknown;
  resumable?: unknown;
  file?: unknown;
  body?: unknown;
  headers?: unknown;
}

/** What `start` takes. */
export interface NativeTransferStart {
  id: string;
  kind: FileTransferKind;
  url: string;
  directory: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  multipart?: { field: string; fileName: string; mimeType: string; fields: Record<string, string> };
  mimeType?: string;
  background: boolean;
}

/** denext's `DenextTransfer` plugin (`denext mobile add file-transfer`). */
export interface TransferPlugin {
  start(options: NativeTransferStart): Promise<{ id?: string }>;
  pause(options: { id: string }): Promise<{ paused?: boolean }>;
  resume(options: { id: string }): Promise<{ resumed?: boolean }>;
  cancel(options: { id: string }): Promise<{ cancelled?: boolean }>;
  forget(options: { id: string }): Promise<{ forgotten?: boolean }>;
  list(): Promise<{ transfers?: RawTransfer[] }>;
  addListener(
    event: "transfer",
    fn: (event: RawTransfer) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/**
 * The `DenextTransfer` plugin, when the shell has it.
 *
 * @returns The plugin, or undefined.
 */
export function transferPlugin(): TransferPlugin | undefined {
  return nativePlugin<TransferPlugin>("DenextTransfer", [
    "start",
    "pause",
    "resume",
    "cancel",
    "forget",
    "list",
    "addListener",
  ]);
}

/** The plugin's directory names, back to the app's. */
const DIRECTORY_NAMES: Readonly<Record<string, string>> = {
  DATA: "data",
  DOCUMENTS: "documents",
  CACHE: "cache",
};

const EVENT_TYPES = ["started", "progress", "paused", "done", "failed", "cancelled"] as const;
const STATES = ["running", "paused", "done", "failed", "cancelled"] as const;

/** A number, or `fallback`. */
function num(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A string field, when it is one. */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The response headers as a plain record of strings. */
function headerRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

/** `value` when it is one of `allowed`, else `fallback`. */
function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.find((v) => v === value) ?? fallback;
}

/** The plugin's directory name as the app's (`DATA` → `data`). */
function directoryName(value: unknown): string {
  const name = str(value) ?? "DATA";
  return DIRECTORY_NAMES[name] ?? name.toLowerCase();
}

/** The fields a record carries only sometimes, each with its reader. */
const OPTIONAL_FIELDS: Readonly<Record<string, (value: unknown) => unknown>> = {
  status: (v) => num(v, null) ?? undefined,
  code: str,
  error: str,
  file: str,
  body: str,
  headers: headerRecord,
};

/** A plugin record as a {@linkcode FileTransferEvent} (an info when it has no `type`). */
function fromNative(raw: RawTransfer): FileTransferEvent {
  const out: Record<string, unknown> = {
    id: String(raw.id ?? ""),
    type: pick(EVENT_TYPES, raw.type, "progress"),
    kind: raw.kind === "upload" ? "upload" : "download",
    url: String(raw.url ?? ""),
    directory: directoryName(raw.directory),
    path: String(raw.path ?? ""),
    state: pick(STATES, raw.state, "running"),
    bytes: num(raw.bytes, 0),
    total: num(raw.total, null),
    resumable: raw.resumable === true,
  };
  for (const [key, read] of Object.entries(OPTIONAL_FIELDS)) {
    const value = read(raw[key as keyof RawTransfer]);
    if (value !== undefined) out[key] = value;
  }
  if (typeof out.error === "string") {
    out.error = withLocalNetworkHint(out.error, String(out.url), out.error);
  }
  return out as unknown as FileTransferEvent;
}

/** Drop the event-only fields. */
function infoOf(event: FileTransferEvent): FileTransferInfo {
  const { type: _type, body: _body, headers: _headers, ...info } = event;
  return info;
}

// --- events ---------------------------------------------------------------------------------

const listeners = new Set<(event: FileTransferEvent) => void>();
/** Per-id waiters (a running `downloadToFile` / `uploadFile` promise). */
const waiters = new Map<string, Set<(event: FileTransferEvent) => void>>();
/** The plugin listener, once added, and the plugin it listens to. */
let nativeSubscription: (() => void) | null = null;
let subscribedTo: TransferPlugin | null = null;

/** Send `event` to every listener and to the transfer's own waiters. */
function dispatch(event: FileTransferEvent): void {
  for (const fn of [...(waiters.get(event.id) ?? [])]) fn(event);
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (err) {
      // A listener that throws must not stop the others (or the transfer).
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}

/** Listen to the plugin's events (once per page). */
function subscribeNative(plugin: TransferPlugin): void {
  if (nativeSubscription && subscribedTo === plugin) return;
  nativeSubscription?.();
  subscribedTo = plugin;
  nativeSubscription = listenerDisposer(
    plugin.addListener("transfer", (raw) => dispatch(fromNative(raw ?? {}))),
  );
}

/** Wait on transfer `id`'s events until the returned function is called. */
function watch(id: string, fn: (event: FileTransferEvent) => void): () => void {
  const set = waiters.get(id) ?? new Set();
  waiters.set(id, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) waiters.delete(id);
  };
}

/**
 * Receive every transfer's events — those started from this page and, in the shell, those
 * running natively from before a reload or a relaunch — until the returned function is called.
 *
 * @example
 * ```ts
 * import { fileTransfers, onFileTransfer } from "denext/mobile";
 *
 * // After a relaunch: pick up the transfers the plugin carried on with.
 * for (const t of await fileTransfers()) if (t.state === "done") showDone(t);
 * const stop = onFileTransfer((e) => {
 *   if (e.type === "progress") setBar(e.id, e.total ? e.bytes / e.total : null);
 * });
 * ```
 *
 * @param listener Called with each {@linkcode FileTransferEvent}.
 * @returns A function that stops listening.
 */
export function onFileTransfer(listener: (event: FileTransferEvent) => void): () => void {
  listeners.add(listener);
  const plugin = transferPlugin();
  if (plugin) subscribeNative(plugin);
  return () => void listeners.delete(listener);
}

// --- the transfers running in the page ------------------------------------------------------

/** A transfer the page runs itself (no native plugin). */
interface PageTransfer {
  info: FileTransferInfo;
  /** Abort the current request; the reason says why (pause, cancel, the caller's signal). */
  abort(reason: AbortWhy): void;
  /** Continue a paused download. */
  resume?(): void;
  /** Cancel it while paused (no request is running): settle its promise. */
  cancelPaused?(why: "cancel" | "caller"): void;
  /** The rejection for a pause, when the transfer's engine cannot pause one. */
  refusePause?(): unknown;
}

/** Why a page transfer's request was aborted. */
type AbortWhy = "pause" | "cancel" | "caller";

const pageTransfers = new Map<string, PageTransfer>();

/** Update a page transfer's record and send the event. */
function pageEvent(
  t: PageTransfer,
  type: FileTransferEvent["type"],
  patch: Partial<FileTransferEvent> = {},
): void {
  const { body, headers, ...info } = patch;
  t.info = { ...t.info, ...info } as FileTransferInfo;
  const event: Record<string, unknown> = { ...t.info, type };
  if (body !== undefined) event.body = body;
  if (headers !== undefined) event.headers = headers;
  dispatch(event as unknown as FileTransferEvent);
}

/** A new transfer id. */
function newId(): string {
  return crypto.randomUUID();
}

/** The id from the options, checked (and not one already running). */
function transferId(fn: string, id: string | undefined): string {
  if (id === undefined) return newId();
  if (typeof id !== "string" || id === "") {
    throw new TypeError(`${fn}: id must be a non-empty string`);
  }
  const running = pageTransfers.get(id);
  if (running && (running.info.state === "running" || running.info.state === "paused")) {
    throw new FileTransferError(`${fn}: transfer ${id} is already ${running.info.state}`, {
      code: "EXISTS",
      id,
    });
  }
  return id;
}

/** Throttle progress callbacks to one per `ms`, the last always delivered by `flush`. */
function throttled(ms: number, fn: (bytes: number, total: number | null) => void) {
  let last = -Infinity;
  return {
    report(bytes: number, total: number | null) {
      const now = Date.now();
      if (now - last < ms) return;
      last = now;
      fn(bytes, total);
    },
    flush(bytes: number, total: number | null) {
      last = Date.now();
      fn(bytes, total);
    },
  };
}

/** Where a page download writes: opened anew, or to append at `at` bytes. */
export interface DownloadSink {
  open(at: number): Promise<{
    write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
    close(): Promise<void>;
  }>;
}

/** The parts of a page transfer the filesystem module passes in. */
export interface PageTransferSpec {
  readonly id: string | undefined;
  readonly url: string;
  readonly directory: string;
  readonly path: string;
  readonly options: FileTransferOptions;
}

/**
 * The validator a resumed download's `If-Range` carries: a strong `ETag`, else `Last-Modified`,
 * else none (the download then starts over). A weak `ETag` never matches in `If-Range`
 * (RFC 9110 §13.1.5), so sending one would restart every resume from byte zero.
 *
 * @param headers The response's headers.
 * @returns The validator, or `null` when the response has none `If-Range` can use.
 */
export function ifRangeValidator(headers: Headers): string | null {
  const etag = headers.get("etag")?.trim();
  if (etag && !etag.startsWith("W/")) return etag;
  return headers.get("last-modified");
}
/** The total a response announces for the rest of the body, plus where it starts. */
function announced(res: Response, from: number): number | null {
  const range = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
  if (range) return Number(range[1]);
  const length = Number(res.headers.get("content-length") ?? NaN);
  return Number.isFinite(length) ? from + length : null;
}

/** Whether a 206 answer continues exactly at `from`. */
function continuesAt(res: Response, from: number): boolean {
  const range = /^bytes\s+(\d+)-/.exec(res.headers.get("content-range") ?? "");
  return res.status === 206 && range !== null && Number(range[1]) === from;
}

/** A response's headers, names lower-cased. */
function responseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => (out[key.toLowerCase()] = value));
  return out;
}

/** A failure writing the file (as opposed to receiving it). */
class WriteFailure extends Error {
  constructor(cause: unknown) {
    super(String((cause as Error)?.message ?? cause), { cause });
  }
}

/** Run a write step, its failure marked as one. */
async function writing<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new WriteFailure(err);
  }
}

/** The reason an abort carries: the caller's signal's, or an AbortError. */
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The transfer was aborted.", "AbortError");
}

/** A transfer's error for a cancel: the caller's signal's reason, or `CANCELLED`. */
function cancelError(
  fn: string,
  id: string,
  why: "cancel" | "caller",
  signal: AbortSignal | undefined,
): unknown {
  return why === "caller"
    ? abortReason(signal)
    : new FileTransferError(`${fn}: the transfer was cancelled`, { code: "CANCELLED", id });
}

/** A new page transfer's record. */
function pageInfo(spec: PageTransferSpec, id: string, kind: FileTransferKind): FileTransferInfo {
  return {
    id,
    kind,
    url: spec.url,
    directory: spec.directory,
    path: spec.path,
    state: "running",
    bytes: 0,
    total: null,
    resumable: false,
  };
}

/**
 * The failure of an attempt at `url`: a write (IO) or the network, resumable when bytes are
 * kept. A network failure iOS's Local Network permission may cause carries the hint.
 */
function attemptFailure(err: unknown, canResume: boolean, url: string): {
  code: FileTransferErrorCode;
  message: string;
  resumable: boolean;
} {
  const code = err instanceof WriteFailure ? "IO" : "NETWORK";
  const message = String((err as Error)?.message ?? err);
  return {
    code,
    message: code === "NETWORK" ? withLocalNetworkHint(message, url, err) : message,
    resumable: code === "NETWORK" && canResume,
  };
}

/** One page download: its record, its current request, and its promise's settlement. */
class PageDownload implements PageTransfer {
  info: FileTransferInfo;
  #controller = new AbortController();
  #validator: string | null = null;
  #progress;
  #settle: { resolve(bytes: number): void; reject(err: unknown): void };
  #onAbort = () => cancelPage(this.info.id, "caller");

  constructor(
    readonly spec: PageTransferSpec,
    readonly sink: DownloadSink,
    id: string,
    settle: { resolve(bytes: number): void; reject(err: unknown): void },
  ) {
    this.info = pageInfo(spec, id, "download");
    this.#settle = settle;
    this.#progress = throttled(100, (bytes, total) => {
      pageEvent(this, "progress", { bytes, total });
      spec.options.onProgress?.({ id, kind: "download", bytes, total });
    });
  }

  start(): void {
    const { signal } = this.spec.options;
    pageTransfers.set(this.info.id, this);
    if (signal?.aborted) {
      pageEvent(this, "cancelled", { state: "cancelled" });
      return this.#fail(abortReason(signal));
    }
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    pageEvent(this, "started");
    void this.#run();
  }

  abort(reason: AbortWhy): void {
    this.#controller.abort(reason);
  }

  resume(): void {
    this.#controller = new AbortController();
    pageEvent(this, "started", { state: "running" });
    void this.#run();
  }

  cancelPaused(why: "cancel" | "caller"): void {
    pageEvent(this, "cancelled", { state: "cancelled", resumable: false });
    this.#fail(cancelError("downloadToFile", this.info.id, why, this.spec.options.signal));
  }

  #fail(err: unknown): void {
    this.spec.options.signal?.removeEventListener("abort", this.#onAbort);
    this.#settle.reject(err);
  }

  /** The request: the rest of the file (a range) when bytes are kept and there is a validator. */
  #request(): Promise<Response> {
    const from = this.info.bytes;
    const headers = new Headers(this.spec.options.headers);
    if (from > 0 && this.#validator) {
      headers.set("range", `bytes=${from}-`);
      headers.set("if-range", this.#validator);
    }
    return fetch(this.spec.url, { headers, signal: this.#controller.signal });
  }

  async #run(): Promise<void> {
    try {
      const res = await this.#request();
      if (!res.ok) return await this.#httpError(res);
      const bytes = await this.#receive(res);
      this.spec.options.signal?.removeEventListener("abort", this.#onAbort);
      this.#settle.resolve(bytes);
    } catch (err) {
      this.#stopped(err);
    }
  }

  async #httpError(res: Response): Promise<void> {
    const body = await res.text().catch(() => "");
    pageEvent(this, "failed", {
      state: "failed",
      status: res.status,
      code: "HTTP",
      error: `the server answered ${res.status}`,
      resumable: false,
    });
    this.#fail(
      new FileTransferError(`downloadToFile: ${this.spec.url} answered ${res.status}`, {
        code: "HTTP",
        id: this.info.id,
        status: res.status,
        body,
      }),
    );
  }

  /** Stream the body into the sink (appending when the answer continues the kept bytes). */
  async #receive(res: Response): Promise<number> {
    const from = this.info.bytes;
    const start = from > 0 && continuesAt(res, from) ? from : 0;
    this.#validator = ifRangeValidator(res.headers);
    const total = announced(res, start);
    const writer = await writing(() => this.sink.open(start));
    let bytes = start;
    try {
      this.#progress.flush(bytes, total);
      const chunks = (res.body ?? []) as AsyncIterable<Uint8Array<ArrayBuffer>>;
      for await (const chunk of chunks) {
        await writing(() => writer.write(chunk));
        bytes += chunk.byteLength;
        this.info = { ...this.info, bytes };
        this.#progress.report(bytes, total);
      }
    } finally {
      await writer.close();
    }
    this.#progress.flush(bytes, total ?? bytes);
    pageEvent(this, "done", {
      state: "done",
      status: res.status,
      bytes,
      total: bytes,
      headers: responseHeaders(res),
      file: `${this.spec.directory}/${this.spec.path}`,
    });
    return bytes;
  }

  /** The request stopped: a pause, a cancel, or a failure. */
  #stopped(err: unknown): void {
    const reason = this.#controller.signal.reason;
    if (reason === "pause") {
      pageEvent(this, "paused", { state: "paused", resumable: this.#validator !== null });
      return;
    }
    if (reason === "cancel" || reason === "caller") {
      pageEvent(this, "cancelled", { state: "cancelled", resumable: false });
      return this.#fail(
        cancelError("downloadToFile", this.info.id, reason, this.spec.options.signal),
      );
    }
    const { code, message, resumable } = attemptFailure(
      err,
      this.#validator !== null && this.info.bytes > 0,
      this.spec.url,
    );
    pageEvent(this, "failed", { state: "failed", code, error: message, resumable });
    this.#fail(
      new FileTransferError(`downloadToFile: ${message}`, { code, id: this.info.id, resumable }),
    );
  }
}

/**
 * Download `spec.url` in the page into `sink`, with progress, pause (an aborted request; the
 * bytes written are kept) and resume (a range request guarded by `If-Range`; a server that
 * answers 200 starts it over).
 *
 * @param spec The transfer.
 * @param sink Where the bytes go.
 * @returns The bytes written, once done.
 */
export function pageDownload(spec: PageTransferSpec, sink: DownloadSink): Promise<number> {
  const id = transferId("downloadToFile", spec.id);
  return new Promise<number>((resolve, reject) => {
    new PageDownload(spec, sink, id, { resolve, reject }).start();
  });
}

// --- downloads an engine outside the page runs (the Deno Desktop runtime) --------------------

/** What a tracked download's engine is handed: the id, the signal that cancels it, progress. */
export interface TrackedDownloadHooks {
  /** The transfer's id. */
  readonly id: string;
  /** Aborted when the transfer is cancelled ({@linkcode cancelFileTransfer} or the caller's signal). */
  readonly signal: AbortSignal;
  /** Report the bytes so far. */
  readonly onProgress: (bytes: number, total: number | null) => void;
}

/** A download another engine runs: how to start it and how to read its failures. */
export interface TrackedDownloadEngine {
  /** Run the download; resolves the file's path. */
  run(hooks: TrackedDownloadHooks): Promise<{ path: string }>;
  /** The engine's failure as the caller's error (a {@linkcode FileTransferError} for a transfer's). */
  error(err: unknown, id: string): unknown;
  /** Whether `err` means the engine is not there: the record is dropped and the caller falls back. */
  absent(err: unknown): boolean;
  /** The rejection for {@linkcode pauseFileTransfer}: the engine cannot pause a download. */
  pauseRefusal(id: string): unknown;
}

/** A failed transfer's record fields from its error: the code, the message, an HTTP status. */
function failedPatch(error: unknown): Partial<FileTransferEvent> {
  const raw = error as { code?: unknown; message?: unknown; status?: unknown } | null;
  const patch: Record<string, unknown> = {
    state: "failed",
    code: typeof raw?.code === "string" ? raw.code : "NETWORK",
    error: String(raw?.message ?? error),
  };
  if (typeof raw?.status === "number") patch.status = raw.status;
  return patch as Partial<FileTransferEvent>;
}

/** A download an outside engine runs, tracked like a page transfer (listed, evented, cancelled). */
class TrackedDownload implements PageTransfer {
  info: FileTransferInfo;
  #controller = new AbortController();

  constructor(
    readonly spec: PageTransferSpec,
    readonly engine: TrackedDownloadEngine,
    id: string,
  ) {
    this.info = pageInfo(spec, id, "download");
  }

  abort(reason: AbortWhy): void {
    this.#controller.abort(reason);
  }

  refusePause(): unknown {
    return this.engine.pauseRefusal(this.info.id);
  }

  async run(): Promise<{ path: string }> {
    const { id } = this.info;
    const { signal, onProgress } = this.spec.options;
    pageTransfers.set(id, this);
    if (signal?.aborted) {
      pageEvent(this, "cancelled", { state: "cancelled" });
      throw abortReason(signal);
    }
    const onAbort = () => cancelPage(id, "caller");
    signal?.addEventListener("abort", onAbort, { once: true });
    pageEvent(this, "started");
    const progress = (bytes: number, total: number | null) => {
      pageEvent(this, "progress", { bytes, total });
      onProgress?.({ id, kind: "download", bytes, total });
    };
    try {
      const done = await this.engine.run({
        id,
        signal: this.#controller.signal,
        onProgress: progress,
      });
      const { bytes } = this.info;
      pageEvent(this, "done", {
        state: "done",
        bytes,
        total: this.info.total ?? bytes,
        file: done.path,
      });
      return done;
    } catch (err) {
      throw this.#failure(err);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The error the download rejects with (its event sent; none when the engine is absent). */
  #failure(err: unknown): unknown {
    const reason = this.#controller.signal.reason;
    if (reason === "cancel" || reason === "caller") {
      pageEvent(this, "cancelled", { state: "cancelled" });
      return cancelError("downloadToFile", this.info.id, reason, this.spec.options.signal);
    }
    if (this.engine.absent(err)) {
      if (pageTransfers.get(this.info.id) === this) pageTransfers.delete(this.info.id);
      return err;
    }
    const mapped = this.engine.error(err, this.info.id);
    const cancelled = mapped instanceof FileTransferError && mapped.code === "CANCELLED";
    if (cancelled) pageEvent(this, "cancelled", { state: "cancelled" });
    else pageEvent(this, "failed", failedPatch(mapped));
    return mapped;
  }
}

/**
 * Track a download another engine runs (the Deno Desktop runtime's `fs.download`) like a page
 * transfer: {@linkcode fileTransfers} lists it, {@linkcode onFileTransfer} gets its `started` /
 * `progress` / `done` / `failed` / `cancelled` events, {@linkcode cancelFileTransfer} and the
 * caller's `signal` abort the signal the engine is handed, and {@linkcode pauseFileTransfer}
 * rejects with the engine's refusal.
 *
 * @param spec The transfer.
 * @param engine The engine.
 * @returns The file's path, once done.
 */
export function trackedDownload(
  spec: PageTransferSpec,
  engine: TrackedDownloadEngine,
): Promise<{ path: string }> {
  return new TrackedDownload(spec, engine, transferId("downloadToFile", spec.id)).run();
}

/** Cancel a page transfer; `caller` when the caller's own signal aborted it. */
function cancelPage(id: string, why: "cancel" | "caller"): boolean {
  const t = pageTransfers.get(id);
  if (!t || (t.info.state !== "running" && t.info.state !== "paused")) return false;
  if (t.info.state === "paused") t.cancelPaused?.(why);
  else t.abort(why);
  return true;
}

/** What a page upload sends. */
export interface PageUploadSpec extends PageTransferSpec {
  readonly method: string;
  readonly blob: Blob;
  /** Multipart framing, or none (the file is the body). */
  readonly multipart?: {
    readonly field: string;
    readonly fileName: string;
    readonly fields: Readonly<Record<string, string>>;
  };
  readonly mimeType: string;
}

/** The minimal `XMLHttpRequest` an upload uses. */
interface Xhr {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getAllResponseHeaders(): string;
  send(body: Blob | FormData): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  upload: { onprogress: ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

/** `getAllResponseHeaders()` as a record. */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

/** What an upload's server answered. */
type UploadAnswer = { status: number; headers: Record<string, string>; body: string };

/** Send a page upload: `XMLHttpRequest` (upload progress) where there is one, else `fetch`. */
function sendUpload(
  spec: PageUploadSpec,
  body: Blob | FormData,
  headers: Record<string, string>,
  progress: (bytes: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<UploadAnswer> {
  const XHR = (globalThis as { XMLHttpRequest?: new () => Xhr }).XMLHttpRequest;
  if (!XHR) {
    return fetch(spec.url, { method: spec.method, headers, body, signal }).then(async (res) => ({
      status: res.status,
      headers: responseHeaders(res),
      body: await res.text(),
    }));
  }
  return new Promise((resolve, reject) => {
    const xhr = new XHR();
    xhr.open(spec.method, spec.url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => progress(e.loaded, e.lengthComputable ? e.total : null);
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        headers: parseHeaders(xhr.getAllResponseHeaders()),
        body: xhr.responseText,
      });
    xhr.onerror = () => reject(new TypeError("the upload failed (network error)"));
    xhr.onabort = () => reject(signal.reason);
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** An upload's body and headers: a multipart form, or the file with its type. */
function uploadBody(
  spec: PageUploadSpec,
): { body: Blob | FormData; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...spec.options.headers };
  if (spec.multipart) {
    const form = new FormData();
    for (const [key, value] of Object.entries(spec.multipart.fields)) form.append(key, value);
    form.append(spec.multipart.field, spec.blob, spec.multipart.fileName);
    return { body: form, headers };
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["content-type"] = spec.mimeType;
  }
  return { body: spec.blob, headers };
}

/** One page upload: its record, its request and its outcome. */
class PageUpload implements PageTransfer {
  info: FileTransferInfo;
  #controller = new AbortController();
  #progress;
  /** The body's size as sent (multipart framing included), once the upload reports it. */
  #sent: number;

  constructor(readonly spec: PageUploadSpec, id: string) {
    this.info = { ...pageInfo(spec, id, "upload"), total: spec.blob.size };
    this.#sent = spec.blob.size;
    this.#progress = throttled(100, (bytes, total) => {
      pageEvent(this, "progress", { bytes, total });
      spec.options.onProgress?.({ id, kind: "upload", bytes, total });
    });
  }

  abort(reason: AbortWhy): void {
    this.#controller.abort(reason);
  }

  async run(): Promise<UploadFileResult> {
    const { signal } = this.spec.options;
    const onAbort = () => cancelPage(this.info.id, "caller");
    signal?.addEventListener("abort", onAbort, { once: true });
    pageTransfers.set(this.info.id, this);
    pageEvent(this, "started");
    try {
      if (signal?.aborted) this.#controller.abort("caller");
      this.#controller.signal.throwIfAborted();
      return this.#answered(await this.#send());
    } catch (err) {
      throw this.#failure(err);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #send(): Promise<UploadAnswer> {
    const { body, headers } = uploadBody(this.spec);
    this.#progress.flush(0, this.spec.blob.size);
    const report = (bytes: number, total: number | null) => {
      if (total !== null) this.#sent = total;
      this.#progress.report(bytes, total);
    };
    return sendUpload(this.spec, body, headers, report, this.#controller.signal);
  }

  #answered(res: UploadAnswer): UploadFileResult {
    if (res.status < 200 || res.status >= 300) {
      pageEvent(this, "failed", {
        state: "failed",
        status: res.status,
        code: "HTTP",
        error: `the server answered ${res.status}`,
        body: res.body,
      });
      throw new FileTransferError(`uploadFile: ${this.spec.url} answered ${res.status}`, {
        code: "HTTP",
        id: this.info.id,
        status: res.status,
        body: res.body,
      });
    }
    this.#progress.flush(this.#sent, this.#sent);
    pageEvent(this, "done", {
      state: "done",
      status: res.status,
      bytes: this.#sent,
      total: this.#sent,
      body: res.body,
      headers: res.headers,
    });
    return res;
  }

  /** The error the upload rejects with (its event sent). */
  #failure(err: unknown): unknown {
    if (err instanceof FileTransferError) return err;
    const reason = this.#controller.signal.reason;
    if (reason === "cancel" || reason === "caller") {
      pageEvent(this, "cancelled", { state: "cancelled" });
      return cancelError("uploadFile", this.info.id, reason, this.spec.options.signal);
    }
    const { message } = attemptFailure(err, false, this.spec.url);
    pageEvent(this, "failed", { state: "failed", code: "NETWORK", error: message });
    return new FileTransferError(`uploadFile: ${message}`, { code: "NETWORK", id: this.info.id });
  }
}

/**
 * Upload `spec.blob` in the page, as the body or as a `multipart/form-data` file part.
 *
 * @param spec The transfer.
 * @returns What the server answered (2xx; anything else rejects).
 */
export function pageUpload(spec: PageUploadSpec): Promise<UploadFileResult> {
  return new PageUpload(spec, transferId("uploadFile", spec.id)).run();
}

// --- the transfers the plugin runs ------------------------------------------------------------

/** A plugin failure's text, with the Local Network hint where it applies. */
function failureText(event: FileTransferEvent, url: string): string {
  const text = event.error ?? "the transfer failed";
  return withLocalNetworkHint(text, url, text);
}

/** How a plugin event settles a transfer's promise: done, an error, or not yet (null). */
function nativeOutcome(
  event: FileTransferEvent,
  start: NativeTransferStart,
  signal: AbortSignal | undefined,
): { done: FileTransferEvent } | { error: unknown } | null {
  const fn = start.kind === "download" ? "downloadToFile" : "uploadFile";
  if (event.type === "done") return { done: event };
  if (event.type === "cancelled") {
    return { error: cancelError(fn, start.id, signal?.aborted ? "caller" : "cancel", signal) };
  }
  if (event.type !== "failed") return null;
  return {
    error: new FileTransferError(`${fn}: ${start.url}: ${failureText(event, start.url)}`, {
      code: (event.code ?? "NETWORK") as FileTransferErrorCode,
      id: start.id,
      status: event.status,
      body: event.body,
      resumable: event.resumable,
    }),
  };
}

/** A refused `start` as a {@linkcode FileTransferError} (the plugin's code kept). */
function startError(fn: string, id: string, err: { code?: unknown; message?: unknown }) {
  const code = typeof err?.code === "string" ? err.code : "IO";
  return new FileTransferError(`${fn}: ${String(err?.message ?? err)}`, {
    code: code as FileTransferErrorCode,
    id,
  });
}

/**
 * Run a transfer through the native plugin: start it, report its progress, and settle with its
 * `done` event (or reject on `failed` / `cancelled`). A paused transfer keeps the promise pending
 * until it is resumed.
 *
 * @param plugin The plugin.
 * @param start What `start` takes (the id included).
 * @param options The caller's progress callback and signal.
 * @returns The `done` event.
 */
export function nativeTransfer(
  plugin: TransferPlugin,
  start: NativeTransferStart,
  options: FileTransferOptions,
): Promise<FileTransferEvent> {
  subscribeNative(plugin);
  const { id, kind } = start;
  const { signal } = options;
  return new Promise<FileTransferEvent>((resolve, reject) => {
    const onAbort = () => void plugin.cancel({ id }).catch(() => {});
    const stop = watch(id, (event) => {
      if (event.type === "progress" || event.type === "done") {
        const total = event.type === "done" ? event.total ?? event.bytes : event.total;
        options.onProgress?.({ id, kind, bytes: event.bytes, total });
      }
      const outcome = nativeOutcome(event, start, signal);
      if (!outcome) return;
      finish();
      if ("done" in outcome) resolve(outcome.done);
      else reject(outcome.error);
    });
    const finish = () => {
      stop();
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      finish();
      return reject(abortReason(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    plugin.start(start).catch((err) => {
      finish();
      reject(startError(kind === "download" ? "downloadToFile" : "uploadFile", id, err));
    });
  });
}

// --- controls -------------------------------------------------------------------------------

/**
 * Every transfer this page knows: in the shell, the plugin's records (running, paused, and
 * finished ones not yet forgotten — those that finished while the page was gone included);
 * on the web and in a Deno Desktop window, the ones this page started.
 *
 * @returns The transfers.
 */
export async function fileTransfers(): Promise<FileTransferInfo[]> {
  const plugin = transferPlugin();
  const native = plugin
    ? ((await plugin.list()).transfers ?? []).map((raw) => infoOf(fromNative(raw ?? {})))
    : [];
  return [...native, ...[...pageTransfers.values()].map((t) => t.info)];
}

/**
 * Pause a running download: the bytes so far are kept, and {@linkcode resumeFileTransfer}
 * continues from them where the server allows a range (else it starts over). Its
 * `downloadToFile` promise stays pending until then. Uploads cannot pause.
 *
 * A Deno Desktop download cannot pause (the runtime keeps no partial file to resume): this
 * rejects with code `"unsupported"`; cancel it and download it again.
 *
 * @param id The transfer's id.
 * @returns Whether it paused.
 */
export async function pauseFileTransfer(id: string): Promise<boolean> {
  const page = pageTransfers.get(id);
  if (page) {
    if (page.info.kind !== "download" || page.info.state !== "running") return false;
    if (page.refusePause) throw page.refusePause();
    page.abort("pause");
    return true;
  }
  const plugin = transferPlugin();
  return plugin ? (await plugin.pause({ id })).paused === true : false;
}

/**
 * Resume a paused download, or retry a failed transfer (a download from its bytes so far when it
 * is `resumable`).
 *
 * @param id The transfer's id.
 * @returns Whether it resumed.
 */
export async function resumeFileTransfer(id: string): Promise<boolean> {
  const page = pageTransfers.get(id);
  if (page) {
    if (page.info.state !== "paused" || !page.resume) return false;
    page.resume();
    return true;
  }
  const plugin = transferPlugin();
  return plugin ? (await plugin.resume({ id })).resumed === true : false;
}

/**
 * Cancel a running or paused transfer; a download's partial file is dropped. Its promise
 * rejects with a {@linkcode FileTransferError} of code `"CANCELLED"`.
 *
 * @param id The transfer's id.
 * @returns Whether it was cancelled.
 */
export async function cancelFileTransfer(id: string): Promise<boolean> {
  if (pageTransfers.has(id)) return cancelPage(id, "cancel");
  const plugin = transferPlugin();
  return plugin ? (await plugin.cancel({ id })).cancelled === true : false;
}

/**
 * Drop a settled transfer's record (done, failed or cancelled), once the app has dealt with it.
 *
 * @param id The transfer's id.
 * @returns Whether a record was dropped.
 */
export async function forgetFileTransfer(id: string): Promise<boolean> {
  const page = pageTransfers.get(id);
  if (page) {
    if (page.info.state === "running" || page.info.state === "paused") return false;
    pageTransfers.delete(id);
    return true;
  }
  const plugin = transferPlugin();
  return plugin ? (await plugin.forget({ id })).forgotten === true : false;
}

/** Forget every page transfer and the plugin subscription (tests). */
export function resetFileTransfersForTesting(): void {
  pageTransfers.clear();
  waiters.clear();
  listeners.clear();
  nativeSubscription?.();
  nativeSubscription = null;
  subscribedTo = null;
}
