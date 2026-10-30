/**
 * The records of the Deno Desktop `fs` capability's downloads, kept across restarts as the
 * `DenextTransfer` plugin keeps its own on iOS and Android, so `fileTransfers()` lists a download
 * a restart stopped (and `resumeFileTransfer()` continues it from its partial file).
 *
 * One JSON file, `<data>/denext-transfers/transfers.json`, replaced atomically (a temp file renamed
 * over it) and readable by the user only. The folder is one of the runtime's reserved names under
 * the data directory (`path-scope.ts`), so the page's `fs` calls never read, list, write or delete
 * it: a live record holds the download's request headers (an `Authorization`, say), dropped once it
 * is over for good (done, cancelled, or failed with nothing to resume), as the plugin drops them.
 *
 * Every change is keyed by the download's attempt (a new one per `download` / `resumeDownload`
 * call), so an attempt that stopped never writes over the record of the one that replaced it.
 *
 * Runtime-only (imported by the `fs` capability).
 *
 * @module
 */

import { join } from "@std/path";

/** The data-directory sub-folder holding the records (reserved: see `path-scope.ts`). */
export const TRANSFER_RECORDS_DIR = "denext-transfers";

/** The records file inside {@link TRANSFER_RECORDS_DIR}. */
const RECORDS_FILE = "transfers.json";

/**
 * How long a download that is over for good (done, or failed with nothing to resume) stays listed
 * after it settled, unless `forgetFileTransfer` drops it first: 7 days. A cancelled download's
 * record is dropped at once.
 */
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The largest records file read back (bytes); a larger one is not ours. */
const MAX_RECORDS_BYTES = 4 * 1024 * 1024;

/** A download's state as a record holds it (a cancelled one is not kept). */
type TransferRecordState = "running" | "paused" | "done" | "failed";

/** One download's record. */
export interface TransferRecord {
  readonly id: string;
  readonly url: string;
  /** The app folder (`"data"`, `"cache"`, `"documents"`); a picked file is never recorded. */
  readonly directory: "data" | "cache" | "documents";
  readonly path: string;
  /** The request headers, while the download may still run (else `{}`). */
  readonly headers: Readonly<Record<string, string>>;
  readonly state: TransferRecordState;
  readonly bytes: number;
  readonly total: number | null;
  readonly resumable: boolean;
  /** A failure's HTTP status. */
  readonly status?: number;
  /** A failure's code, as the page's `FileTransferError` codes (`"HTTP"`, `"NETWORK"`, …). */
  readonly code?: string;
  /** A failure's message. */
  readonly error?: string;
  /** A done download's absolute path. */
  readonly file?: string;
  /** The attempt that last wrote it. */
  readonly attempt: string;
  /** When it last changed (ms since the epoch). */
  readonly updatedAt: number;
}

/** A record as `fs.listDownloads` hands it to the page (no headers, attempt or timestamp). */
interface TransferRecordInfo {
  readonly id: string;
  readonly kind: "download";
  readonly url: string;
  readonly directory: string;
  readonly path: string;
  readonly state: TransferRecordState;
  readonly bytes: number;
  readonly total: number | null;
  readonly resumable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly error?: string;
  readonly file?: string;
}

/**
 * Whether a record is over for good: done, or failed with nothing to resume. Its headers go, and
 * {@link SETTLED_RETENTION_MS} after it settled, the record.
 *
 * @param r The record.
 * @returns Whether nothing can run it on.
 */
function settledRecord(r: Pick<TransferRecord, "state" | "resumable">): boolean {
  return r.state === "done" || (r.state === "failed" && !r.resumable);
}

/** Whether `value` is a string. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Whether `value` is a byte count. */
function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A plain record of strings, or `undefined`. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!isString(v)) return undefined;
    out[k] = v;
  }
  return out;
}

const STATES: readonly TransferRecordState[] = ["running", "paused", "done", "failed"];
const DIRECTORIES = ["data", "cache", "documents"] as const;

/** The optional fields a record carries, each with its check. */
const OPTIONAL: Readonly<Record<string, (value: unknown) => boolean>> = {
  status: isSize,
  code: isString,
  error: isString,
  file: isString,
};

/** The fields every record carries, each with its check. */
const REQUIRED: Readonly<Record<string, (value: unknown) => boolean>> = {
  id: (v) => isString(v) && v !== "",
  url: isString,
  path: isString,
  directory: (v) => DIRECTORIES.some((d) => d === v),
  state: (v) => STATES.some((s) => s === v),
  bytes: isSize,
  total: (v) => v === null || isSize(v),
  resumable: (v) => typeof v === "boolean",
  attempt: isString,
  updatedAt: isSize,
};

/** `raw` as a {@link TransferRecord}, when it is a well-formed one. */
function parseRecord(raw: unknown): TransferRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const headers = stringRecord(r.headers);
  const ok = headers !== undefined &&
    Object.entries(REQUIRED).every(([k, check]) => check(r[k])) &&
    Object.entries(OPTIONAL).every(([k, check]) => r[k] === undefined || check(r[k]));
  return ok ? { ...(r as unknown as TransferRecord), headers } : undefined;
}

/** The page's view of a record. */
export function recordInfo(r: TransferRecord): TransferRecordInfo {
  const out: Record<string, unknown> = {
    id: r.id,
    kind: "download",
    url: r.url,
    directory: r.directory,
    path: r.path,
    state: r.state,
    bytes: r.bytes,
    total: r.total,
    resumable: r.resumable,
  };
  for (const key of Object.keys(OPTIONAL)) {
    const value = r[key as keyof TransferRecord];
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as TransferRecordInfo;
}

/** A change to a record: the fields to set, `undefined` removing an optional one. */
export type TransferRecordPatch = {
  [K in keyof Omit<TransferRecord, "id" | "attempt" | "updatedAt">]?: TransferRecord[K] | undefined;
};

/**
 * The records of one data directory: loaded once (see {@linkcode TransferRecords.ready}), changed
 * in memory and saved after each change, one save at a time.
 */
export class TransferRecords {
  readonly #dir: string;
  readonly #file: string;
  readonly #now: () => number;
  #records = new Map<string, TransferRecord>();
  #loading: Promise<void> | undefined;
  #saving: Promise<void> = Promise.resolve();

  /**
   * @param dataDir The app-support (`data`) directory.
   * @param now The clock (tests move it).
   */
  constructor(dataDir: string, now: () => number = Date.now) {
    this.#dir = join(dataDir, TRANSFER_RECORDS_DIR);
    this.#file = join(this.#dir, RECORDS_FILE);
    this.#now = now;
  }

  /**
   * Load the records once (a missing, oversized or malformed file is none), then let `restore`
   * bring each back as this launch sees it: a record that was running when the app stopped is no
   * longer running. `restore` answers the record to keep, or `undefined` to drop it. A record over
   * for good past {@link SETTLED_RETENTION_MS} is dropped first, through `expire`.
   *
   * @param restore Brings a loaded record into this launch.
   * @param expire Called with each record dropped for its age (its partial file to clean up).
   * @returns Once loaded.
   */
  ready(
    restore: (r: TransferRecord) => Promise<TransferRecord | undefined>,
    expire: (r: TransferRecord) => Promise<void>,
  ): Promise<void> {
    this.#loading ??= this.#load(restore, expire);
    return this.#loading;
  }

  async #load(
    restore: (r: TransferRecord) => Promise<TransferRecord | undefined>,
    expire: (r: TransferRecord) => Promise<void>,
  ): Promise<void> {
    const loaded = await this.#read();
    let changed = false;
    const now = this.#now();
    for (const record of loaded) {
      if (settledRecord(record) && now - record.updatedAt >= SETTLED_RETENTION_MS) {
        await expire(record).catch(() => {});
        changed = true;
        continue;
      }
      const kept = await restore(record).catch(() => record);
      if (kept !== record) changed = true;
      if (kept) this.#records.set(kept.id, kept);
    }
    if (changed) await this.#save();
  }

  /** The records file's records (none when it is missing, oversized or malformed). */
  async #read(): Promise<TransferRecord[]> {
    try {
      const info = await Deno.lstat(this.#file);
      if (!info.isFile || info.size > MAX_RECORDS_BYTES) return [];
      const raw = JSON.parse(await Deno.readTextFile(this.#file));
      if (!Array.isArray(raw)) return [];
      return raw.map(parseRecord).filter((r): r is TransferRecord => r !== undefined);
    } catch {
      return [];
    }
  }

  /** Every record. */
  all(): TransferRecord[] {
    return [...this.#records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  /** Record `id`, if there is one. */
  get(id: string): TransferRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * Start record `id` for `attempt` (replacing any record of that id).
   *
   * @param record The record's fields.
   * @returns Once saved.
   */
  start(record: Omit<TransferRecord, "updatedAt">): Promise<void> {
    this.#records.set(record.id, { ...record, updatedAt: this.#now() });
    return this.#save();
  }

  /**
   * Change record `id`, only while `attempt` is the one that wrote it last. A record that is now
   * over for good loses its headers.
   *
   * @param id The download's id.
   * @param attempt The attempt making the change.
   * @param patch The fields to change.
   * @returns Whether it changed.
   */
  async update(id: string, attempt: string, patch: TransferRecordPatch): Promise<boolean> {
    const current = this.#records.get(id);
    if (!current || current.attempt !== attempt) return false;
    const next: Record<string, unknown> = { ...current, ...patch, updatedAt: this.#now() };
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
    const record = next as unknown as TransferRecord;
    this.#records.set(id, settledRecord(record) ? { ...record, headers: {} } : record);
    await this.#save();
    return true;
  }

  /**
   * Drop record `id` (with `attempt`, only while that attempt wrote it last).
   *
   * @param id The download's id.
   * @param attempt The attempt dropping it, or `undefined` for any.
   * @returns Whether a record was dropped.
   */
  async remove(id: string, attempt?: string): Promise<boolean> {
    const current = this.#records.get(id);
    if (!current || (attempt !== undefined && current.attempt !== attempt)) return false;
    this.#records.delete(id);
    await this.#save();
    return true;
  }

  /** Queue a save of the records as they are now (one save at a time, in order). */
  #save(): Promise<void> {
    const list = this.all();
    this.#saving = this.#saving.then(() => this.#write(list)).catch(() => {});
    return this.#saving;
  }

  /**
   * Write `list` atomically: a temp file (the user's only) renamed over the records file. No
   * records: the file (and the folder, once empty) is removed.
   */
  async #write(list: TransferRecord[]): Promise<void> {
    if (list.length === 0) {
      await Deno.remove(this.#file).catch(() => {});
      await Deno.remove(this.#dir).catch(() => {});
      return;
    }
    await Deno.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(temp, JSON.stringify(list), { createNew: true, mode: 0o600 });
      await Deno.rename(temp, this.#file);
    } catch (err) {
      await Deno.remove(temp).catch(() => {});
      throw err;
    }
  }
}
