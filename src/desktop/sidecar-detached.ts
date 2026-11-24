/**
 * Detached sidecars, the parts both sides share: the per-app registry (`<app data>/sidecars/`), the
 * mutually authenticated loopback control protocol, the start lock, and the host's helpers that
 * find, list and stop running instances.
 *
 * A detached module sidecar (`detached: true`, see `sidecar.ts`) runs as a separate OS process (the
 * app's own executable started again, headless, on the sidecar's module: `sidecar-detached-child.ts`)
 * that outlives the app. The app finds it again through its registry record and talks to it over a
 * loopback TCP control connection opened by denext's child-side code before the module runs.
 *
 * The registry: one record `<name>.json` per detached sidecar in `<app data>/sidecars/` (created
 * `0700`, records `0600`, written atomically: a temp file then a rename), holding `{ v: 1, name,
 * pid, startedAt, appVersion, control: { host, port }, key, port?, values?, secrets? }`. `key` is 32
 * random bytes the app made for this start; `pid` is informational only.
 *
 * The control protocol: newline-delimited JSON, at most 8 KiB a line, both sides proving the key
 * without sending it (HMAC-SHA256 over a label, the role and both nonces, verified with
 * `crypto.subtle.verify`, a constant-time compare):
 *
 * 1. client → `{ t: "hello", v: 1, nonce }` (16 random bytes, base64url);
 * 2. server → `{ t: "challenge", nonce, mac: HMAC(key, "denext-sidecar-v1|server|<client>|<server>") }`;
 * 3. client verifies, then → `{ t: "auth", mac: HMAC(key, "denext-sidecar-v1|client|<client>|<server>") }`;
 * 4. server verifies, then → `{ t: "ok", name, pid, startedAt, appVersion, attached, ready }`.
 *
 * Any failure closes the socket with no detail. The server finishes a handshake within 5 s and
 * holds at most 16 unauthenticated connections. After `ok`: `ping` → `pong`, `status` → `ok`,
 * `shutdown { graceMs }` → the sidecar ends (its `onShutdown` handlers, then exit; unconditionally
 * once `graceMs`, at most 30 s, passed). The server pushes `ready` once the sidecar called
 * `denextSidecar.ready()`, and `bye { code, error?, reason }` before it ends itself. An open
 * authenticated connection is an attachment.
 *
 * Security: the record holds the key and the sidecar's secrets, so any process of the same user can
 * command the sidecar (the boundary of the user's other app data; other users cannot read it; on
 * Windows the user profile's ACL is the protection, the modes have no effect there). Any local
 * process can connect to the endpoint, none can authenticate without the key, and a process that
 * took the port after the sidecar died cannot pass as it. The connection is not encrypted, so no
 * secret ever crosses it. The app never signals a process id an authenticated `ok` did not name in
 * the same connection.
 *
 * Runtime-only (imported by the sidecar host and a detached sidecar's child, never a client bundle).
 *
 * @module
 */

import { join } from "@std/path";
import { acquireOsLock } from "./os-lock.ts";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";

/** The protocol version (`hello.v`, the record's `v`). */
const DETACHED_PROTOCOL_VERSION = 1;
/** The HMAC label both macs start with. */
const MAC_LABEL = "denext-sidecar-v1";
/** The longest line either side accepts, in bytes (without the newline). */
const DETACHED_MAX_LINE_BYTES = 8 * 1024;
/** How long the server gives a connection to finish the handshake. */
const DETACHED_HANDSHAKE_MS = 5_000;
/** How many unauthenticated connections the server holds at a time. */
const DETACHED_MAX_PENDING = 16;
/** The longest `shutdown` grace the server honours. */
export const DETACHED_MAX_GRACE_MS = 30_000;
/** The registry's folder inside the app's data folder. */
const DETACHED_REGISTRY_FOLDER = "sidecars";

/** A sidecar name (as `sidecar.ts` validates it). */
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** 16 bytes, base64url without padding. */
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
/** 32 bytes, base64url without padding. */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** A registry record: what an app needs to find, authenticate and use a running detached sidecar. */
export interface DetachedRecord {
  /** The record format. */
  readonly v: 1;
  /** The sidecar's name. */
  readonly name: string;
  /** The process id the sidecar reported (informational: never signalled on its own say-so). */
  readonly pid: number;
  /** When it was started (epoch ms). */
  readonly startedAt: number;
  /** The app version that started it (`"dev"` outside a packaged app). */
  readonly appVersion: string;
  /** The control endpoint. */
  readonly control: { readonly host: "127.0.0.1"; readonly port: number };
  /** The control key (32 random bytes, base64url), made by the app for this start. */
  readonly key: string;
  /** The sidecar's own service port, when it has one. */
  readonly port?: number;
  /** The page-visible values (`expose`, secrets resolved). */
  readonly values?: Readonly<Record<string, string | number | boolean | null>>;
  /** The sidecar's resolved secrets (so a relaunched app can talk to the service). */
  readonly secrets?: Readonly<Record<string, string>>;
}

/**
 * The registry folder of an app: `<data>/sidecars`.
 *
 * @param dataDir The app's data folder.
 * @returns The folder (not created).
 */
export function detachedRegistryDir(dataDir: string): string {
  return join(dataDir, DETACHED_REGISTRY_FOLDER);
}

/**
 * The record file of one sidecar.
 *
 * @param registryDir The registry folder.
 * @param name The sidecar's name.
 * @returns `<registryDir>/<name>.json`.
 */
export function detachedRecordPath(registryDir: string, name: string): string {
  return join(registryDir, `${name}.json`);
}

/** `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole number within `[min, max]`. */
function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether every value of `obj` is a string. */
function allStrings(obj: Record<string, unknown>): boolean {
  return Object.values(obj).every((v) => typeof v === "string");
}

/** Whether `value` is an optional record field of page values. */
function valuesOk(value: unknown): boolean {
  return value === undefined || (isObject(value) &&
    Object.values(value).every((v) =>
      v === null || ["string", "number", "boolean"].includes(typeof v)
    ));
}

/**
 * A record parsed and checked, or `null` when the text is not one (or names another sidecar).
 *
 * @param text The file's text.
 * @param name The sidecar it must name, when known.
 * @returns The record, or `null`.
 */
export function parseDetachedRecord(text: string, name?: string): DetachedRecord | null {
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(r) || r.v !== 1 || typeof r.name !== "string" || !NAME_RE.test(r.name)) return null;
  if (name !== undefined && r.name !== name) return null;
  return requiredFieldsOk(r) && optionalFieldsOk(r) ? r as unknown as DetachedRecord : null;
}

/** A record's required fields: `pid`, `startedAt`, `appVersion`, `control`, `key`. */
function requiredFieldsOk(r: Record<string, unknown>): boolean {
  const control = r.control;
  return isInt(r.pid, 1, 2 ** 32) && isInt(r.startedAt, 0, Number.MAX_SAFE_INTEGER) &&
    typeof r.appVersion === "string" && isObject(control) && control.host === "127.0.0.1" &&
    isInt(control.port, 1, 65535) && typeof r.key === "string" && KEY_RE.test(r.key);
}

/** A record's optional fields: `port`, `values`, `secrets`. */
function optionalFieldsOk(r: Record<string, unknown>): boolean {
  const secretsOk = r.secrets === undefined || (isObject(r.secrets) && allStrings(r.secrets));
  return (r.port === undefined || isInt(r.port, 1, 65535)) && valuesOk(r.values) && secretsOk;
}

/**
 * Read one record; `null` when there is none or it is not a valid record.
 *
 * @param registryDir The registry folder.
 * @param name The sidecar's name.
 * @returns The record, or `null`.
 */
export async function readDetachedRecord(
  registryDir: string,
  name: string,
): Promise<DetachedRecord | null> {
  try {
    return parseDetachedRecord(
      await Deno.readTextFile(detachedRecordPath(registryDir, name)),
      name,
    );
  } catch {
    return null;
  }
}

/** Make the registry folder (`0700`). */
async function ensureRegistryDir(registryDir: string): Promise<void> {
  await Deno.mkdir(registryDir, { recursive: true, mode: 0o700 });
  if (Deno.build.os !== "windows") await Deno.chmod(registryDir, 0o700).catch(() => {});
}

/**
 * Write a record atomically: a temp file (`0600`, created new) in the registry folder (`0700`),
 * then renamed over `<name>.json`.
 *
 * @param registryDir The registry folder.
 * @param record The record.
 */
export async function writeDetachedRecord(
  registryDir: string,
  record: DetachedRecord,
): Promise<void> {
  await ensureRegistryDir(registryDir);
  const temp = join(registryDir, `.${record.name}.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(temp, JSON.stringify(record) + "\n", { mode: 0o600, createNew: true });
    // The process umask may have narrowed the mode, never widened it; set it exactly.
    if (Deno.build.os !== "windows") await Deno.chmod(temp, 0o600);
    await Deno.rename(temp, detachedRecordPath(registryDir, record.name));
  } catch (err) {
    await Deno.remove(temp).catch(() => {});
    throw err;
  }
}

/**
 * Remove a record. With `key`, only when the record on disk still holds that key (another start may
 * have replaced it meanwhile).
 *
 * @param registryDir The registry folder.
 * @param name The sidecar's name.
 * @param key The key the record must hold.
 */
export async function removeDetachedRecord(
  registryDir: string,
  name: string,
  key?: string,
): Promise<void> {
  const path = detachedRecordPath(registryDir, name);
  if (key !== undefined) {
    const text = await Deno.readTextFile(path).catch(() => undefined);
    if (text === undefined) return;
    const current = parseDetachedRecord(text, name);
    // A record that is not valid any more is removed as well; another key's record is kept.
    if (current && current.key !== key) return;
  }
  await Deno.remove(path).catch(() => {});
}

/**
 * Every valid record of the registry, by name.
 *
 * @param registryDir The registry folder.
 * @returns The records (none when the folder does not exist).
 */
export async function listDetachedRecords(registryDir: string): Promise<DetachedRecord[]> {
  const out: DetachedRecord[] = [];
  try {
    for await (const entry of Deno.readDir(registryDir)) {
      const m = /^([a-z][a-z0-9-]{0,63})\.json$/.exec(entry.name);
      if (!entry.isFile || !m) continue;
      const record = await readDetachedRecord(registryDir, m[1]);
      if (record) out.push(record);
    }
  } catch { /* no registry */ }
  return out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Options for {@linkcode withDetachedLock}. */
export interface DetachedLockOptions {
  /** How long to wait for the lock before giving up (default 60 000 ms). */
  readonly timeoutMs?: number;
  /** How often a held lock is tried again (default 50 ms). */
  readonly pollMs?: number;
}

/**
 * Run `fn` holding the start lock of one sidecar: an exclusive OS advisory lock on
 * `<registryDir>/<name>.lock` (`os-lock.ts`), so two instances of the app (or two starts in one)
 * never start two detached sidecars of one name. The OS releases it when its holder exits, so a
 * crashed start never leaves a lock to wait out, and a held lock is never broken (a holder whose
 * timers stalled, a machine that slept, stays the holder). The file is kept for the next start.
 *
 * @param registryDir The registry folder.
 * @param name The sidecar's name.
 * @param fn What runs under the lock.
 * @param options The timings.
 * @returns What `fn` returns.
 */
export async function withDetachedLock<T>(
  registryDir: string,
  name: string,
  fn: () => Promise<T>,
  options: DetachedLockOptions = {},
): Promise<T> {
  const path = join(registryDir, `${name}.lock`);
  await ensureRegistryDir(registryDir);
  const lock = await acquireOsLock(path, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  });
  if (!lock) {
    throw new Error(`sidecar ${name}: another instance of the app holds the start lock (${path})`);
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// ── keys and macs ──────────────────────────────────────────────────────────────────────────────

/**
 * A fresh control key: 32 random bytes, base64url.
 *
 * @returns The key.
 */
export function newDetachedKey(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A fresh nonce: 16 random bytes, base64url. */
function newNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The HMAC key of a control key.
 *
 * @param key The control key (base64url of 32 bytes).
 * @returns The key for `crypto.subtle` (sign and verify).
 */
export async function importDetachedKey(key: string): Promise<CryptoKey> {
  if (!KEY_RE.test(key)) throw new Error("a detached sidecar's key must be 32 bytes, base64url");
  return await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The bytes a mac covers. */
function macInput(role: "server" | "client", clientNonce: string, serverNonce: string) {
  return new TextEncoder().encode(`${MAC_LABEL}|${role}|${clientNonce}|${serverNonce}`);
}

/**
 * One side's mac over both nonces.
 *
 * @param key The HMAC key.
 * @param role Which side proves the key.
 * @param clientNonce The client's nonce.
 * @param serverNonce The server's nonce.
 * @returns The mac, base64url.
 */
export async function detachedMac(
  key: CryptoKey,
  role: "server" | "client",
  clientNonce: string,
  serverNonce: string,
): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, macInput(role, clientNonce, serverNonce));
  return encodeBase64Url(new Uint8Array(mac));
}

/**
 * Whether `mac` is the given side's mac over both nonces (`crypto.subtle.verify`: constant time).
 *
 * @param key The HMAC key.
 * @param role Which side's mac it must be.
 * @param clientNonce The client's nonce.
 * @param serverNonce The server's nonce.
 * @param mac The mac received (anything: a wrong shape is `false`).
 * @returns Whether it verifies.
 */
export async function verifyDetachedMac(
  key: CryptoKey,
  role: "server" | "client",
  clientNonce: string,
  serverNonce: string,
  mac: unknown,
): Promise<boolean> {
  if (typeof mac !== "string" || !KEY_RE.test(mac)) return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64Url(mac);
  } catch {
    return false;
  }
  return await crypto.subtle.verify("HMAC", key, bytes, macInput(role, clientNonce, serverNonce));
}

// ── newline-delimited JSON over a stream ───────────────────────────────────────────────────────

/** A connection as the protocol uses it (a `Deno.Conn`; tests may pass their own). */
export interface DetachedConn {
  readonly readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): Promise<number>;
  close(): void;
}

/**
 * Newline-delimited JSON over one connection. `next()` resolves the next message, or `null` at the
 * end, on a line longer than the limit, or on a line that is not a JSON object (the connection is
 * closed then).
 */
class DetachedLines {
  #conn: DetachedConn;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf = new Uint8Array(0);
  #max: number;
  #closed = false;
  #writes: Promise<unknown> = Promise.resolve();

  /**
   * @param conn The connection.
   * @param maxLineBytes The longest line accepted.
   */
  constructor(conn: DetachedConn, maxLineBytes = DETACHED_MAX_LINE_BYTES) {
    this.#conn = conn;
    this.#reader = conn.readable.getReader();
    this.#max = maxLineBytes;
  }

  /** Whether {@linkcode DetachedLines.close} ran. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * The next message.
   *
   * @returns A JSON object, or `null` (the connection is closed).
   */
  async next(): Promise<Record<string, unknown> | null> {
    while (!this.#closed) {
      const line = this.#takeLine();
      if (line === "bad") break;
      if (line !== undefined) return line;
      if (!(await this.#fill())) break;
    }
    this.close();
    return null;
  }

  /** The buffered next line as a message; `undefined` without a whole line, `"bad"` for a bad one. */
  #takeLine(): Record<string, unknown> | "bad" | undefined {
    const nl = this.#buf.indexOf(0x0a);
    if (nl < 0) return this.#buf.length > this.#max ? "bad" : undefined;
    const line = this.#buf.subarray(0, nl);
    this.#buf = this.#buf.slice(nl + 1);
    if (line.length > this.#max) return "bad";
    try {
      const msg = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      return isObject(msg) ? msg : "bad";
    } catch {
      return "bad";
    }
  }

  /** Read one more chunk into the buffer: `false` at the end. */
  async #fill(): Promise<boolean> {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await this.#reader.read();
    } catch {
      return false;
    }
    if (chunk.done || !chunk.value) return false;
    const joined = new Uint8Array(this.#buf.length + chunk.value.length);
    joined.set(this.#buf);
    joined.set(chunk.value, this.#buf.length);
    this.#buf = joined;
    return true;
  }

  /**
   * Send one message (writes are serialized). Never rejects: a failed write closes the connection.
   *
   * @param msg The message.
   * @returns Once written (or failed).
   */
  send(msg: Record<string, unknown>): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(msg) + "\n");
    const write = this.#writes.then(async () => {
      if (this.#closed) return;
      let off = 0;
      while (off < bytes.length) off += await this.#conn.write(bytes.subarray(off));
    }).catch(() => this.close());
    this.#writes = write;
    return write;
  }

  /** Close the connection (idempotent). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#reader.releaseLock();
    } catch { /* a read is pending: the close ends it */ }
    try {
      this.#conn.close();
    } catch { /* already closed */ }
  }
}

// ── the server (in the detached sidecar) ───────────────────────────────────────────────────────

/** What `ok` reports about the sidecar. */
export interface DetachedIdentity {
  /** The sidecar's name. */
  readonly name: string;
  /** Its process id. */
  readonly pid: number;
  /** When it was started (epoch ms). */
  readonly startedAt: number;
  /** The app version that started it. */
  readonly appVersion: string;
}

/** Options for {@linkcode serveDetachedControl}. */
export interface DetachedControlServerOptions {
  /** The control key. */
  readonly key: string;
  /** What `ok` reports. */
  readonly identity: DetachedIdentity;
  /** An authenticated client asked the sidecar to end (`graceMs` already capped). */
  readonly onShutdown: (graceMs: number) => void;
  /** The number of authenticated connections changed. */
  readonly onAttachedChange?: (attached: number) => void;
  /** The handshake budget (default 5 000 ms; tests shorten it). */
  readonly handshakeMs?: number;
  /** The unauthenticated connection cap (default 16). */
  readonly maxPending?: number;
}

/** A running control server. */
export interface DetachedControlServer {
  /** The loopback port it listens on. */
  readonly port: number;
  /** The open authenticated connections. */
  attached(): number;
  /** The connections still in their handshake (at most `maxPending`). */
  pending(): number;
  /** The sidecar is ready: told to every attached client now and in each later `ok`. */
  setReady(): void;
  /** Tell every attached client the sidecar is ending, and wait (briefly) for the writes. */
  bye(info: { code?: number; error?: string; reason: string }): Promise<void>;
  /** Stop listening and close every connection. */
  close(): void;
}

/**
 * Listen on `127.0.0.1:0` for the app's control connections (see the module's protocol).
 *
 * @param options The key, the identity and the callbacks.
 * @returns The server.
 */
export async function serveDetachedControl(
  options: DetachedControlServerOptions,
): Promise<DetachedControlServer> {
  const key = await importDetachedKey(options.key);
  const handshakeMs = options.handshakeMs ?? DETACHED_HANDSHAKE_MS;
  const maxPending = options.maxPending ?? DETACHED_MAX_PENDING;
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0, transport: "tcp" });
  const authed = new Set<DetachedLines>();
  const all = new Set<DetachedLines>();
  /** The handshake deadlines still armed: cleared with the server, so none outlives it. */
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  let pending = 0;
  let ready = false;
  let closing = false;
  const okPayload = () => ({
    t: "ok",
    ...options.identity,
    attached: authed.size,
    ready,
  });
  const changed = () => options.onAttachedChange?.(authed.size);

  /** The handshake: `true` once the client proved the key. */
  const handshake = async (lines: DetachedLines): Promise<boolean> => {
    const hello = await lines.next();
    const clientNonce = hello?.nonce;
    if (
      hello?.t !== "hello" || hello.v !== DETACHED_PROTOCOL_VERSION ||
      typeof clientNonce !== "string" || !NONCE_RE.test(clientNonce)
    ) return false;
    const serverNonce = newNonce();
    await lines.send({
      t: "challenge",
      nonce: serverNonce,
      mac: await detachedMac(key, "server", clientNonce, serverNonce),
    });
    const auth = await lines.next();
    return auth?.t === "auth" &&
      await verifyDetachedMac(key, "client", clientNonce, serverNonce, auth.mac);
  };

  const serve = async (lines: DetachedLines): Promise<void> => {
    authed.add(lines);
    changed();
    await lines.send(okPayload());
    for (let msg = await lines.next(); msg; msg = await lines.next()) {
      if (msg.t === "ping") await lines.send({ t: "pong" });
      else if (msg.t === "status") await lines.send(okPayload());
      else if (msg.t === "shutdown") {
        const asked = typeof msg.graceMs === "number" && msg.graceMs >= 0 ? msg.graceMs : 0;
        options.onShutdown(Math.min(Math.floor(asked), DETACHED_MAX_GRACE_MS));
      }
    }
    authed.delete(lines);
    if (!closing) changed();
  };

  const handle = async (conn: Deno.Conn): Promise<void> => {
    const lines = new DetachedLines(conn);
    all.add(lines);
    pending++;
    const timer = setTimeout(() => {
      deadlines.delete(timer);
      lines.close();
    }, handshakeMs);
    deadlines.add(timer);
    let ok = false;
    try {
      ok = await handshake(lines);
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
      deadlines.delete(timer);
      pending--;
    }
    try {
      if (ok && !lines.closed) await serve(lines);
    } finally {
      lines.close();
      all.delete(lines);
    }
  };

  (async () => {
    try {
      for await (const conn of listener) {
        if (pending >= maxPending) {
          try {
            conn.close();
          } catch { /* gone */ }
          continue;
        }
        void handle(conn);
      }
    } catch { /* the listener was closed */ }
  })();

  return {
    port: (listener.addr as Deno.NetAddr).port,
    attached: () => authed.size,
    pending: () => pending,
    setReady() {
      if (ready) return;
      ready = true;
      for (const lines of authed) void lines.send({ t: "ready" });
    },
    async bye(info) {
      const sends = [...authed].map((l) => l.send({ t: "bye", ...info }));
      await within(Promise.all(sends), 500);
    },
    close() {
      closing = true;
      try {
        listener.close();
      } catch { /* closed */ }
      for (const lines of all) lines.close();
      for (const timer of deadlines) clearTimeout(timer);
      deadlines.clear();
    },
  };
}

// ── the client (in the app) ────────────────────────────────────────────────────────────────────

/** What an authenticated `ok` reported. */
export interface DetachedStatusInfo extends DetachedIdentity {
  /** The open authenticated connections, this one included. */
  readonly attached: number;
  /** Whether the sidecar called `ready()`. */
  readonly ready: boolean;
}

/** How a control connection ended. */
export interface DetachedEnd {
  /** The sidecar's `bye`, when it said one before ending. */
  readonly bye?: { readonly code?: number; readonly error?: string; readonly reason?: string };
}

/** An authenticated control connection: the app's attachment to a detached sidecar. */
export interface DetachedSession {
  /** What the sidecar's `ok` reported in THIS connection (its `pid` is the one that may be signalled). */
  readonly info: DetachedStatusInfo;
  /** Whether the sidecar is ready. */
  readonly ready: boolean;
  /** Resolves once the sidecar is ready. */
  whenReady(): Promise<void>;
  /** Settles once the connection closed, however it closed. */
  readonly closed: Promise<DetachedEnd>;
  /** Whether the connection is still open. */
  readonly open: boolean;
  /** Ask for a `pong`; `false` once the connection closed first. */
  ping(): Promise<boolean>;
  /** Ask for the status; `null` once the connection closed first. */
  status(): Promise<DetachedStatusInfo | null>;
  /**
   * Ask the sidecar to end within `graceMs` (capped at 30 s), and wait up to that plus a second for
   * the connection to close.
   *
   * @returns Whether it closed in time.
   */
  shutdown(graceMs: number): Promise<boolean>;
  /** Close the connection (detach). */
  close(): void;
}

/** Options for {@linkcode connectDetachedControl}. */
export interface DetachedConnectOptions {
  /** The control port. */
  readonly port: number;
  /** The control key. */
  readonly key: string;
  /** The name the sidecar's `ok` must carry, when known. */
  readonly name?: string;
  /** The handshake budget (default 5 000 ms). */
  readonly timeoutMs?: number;
  /** Open the connection (tests). */
  readonly connect?: (port: number) => Promise<DetachedConn>;
}

/** Wait for `p` up to `ms`; `undefined` past it. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((r) => timer = setTimeout(() => r(undefined), ms)),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The `ok` payload as {@linkcode DetachedStatusInfo}, or `null` when it is not one. */
function statusOf(msg: Record<string, unknown> | null): DetachedStatusInfo | null {
  if (msg?.t !== "ok" || typeof msg.name !== "string" || !isInt(msg.pid, 1, 2 ** 32)) return null;
  return {
    name: msg.name,
    pid: msg.pid,
    startedAt: typeof msg.startedAt === "number" ? msg.startedAt : 0,
    appVersion: typeof msg.appVersion === "string" ? msg.appVersion : "",
    attached: typeof msg.attached === "number" ? msg.attached : 0,
    ready: msg.ready === true,
  };
}

/** The client's side of the handshake: the `ok` once both sides proved the key, else `null`. */
async function clientHandshake(
  lines: DetachedLines,
  key: CryptoKey,
): Promise<DetachedStatusInfo | null> {
  const clientNonce = newNonce();
  await lines.send({ t: "hello", v: DETACHED_PROTOCOL_VERSION, nonce: clientNonce });
  const challenge = await lines.next();
  const serverNonce = challenge?.nonce;
  if (challenge?.t !== "challenge" || typeof serverNonce !== "string") return null;
  if (!NONCE_RE.test(serverNonce)) return null;
  if (!(await verifyDetachedMac(key, "server", clientNonce, serverNonce, challenge.mac))) {
    return null;
  }
  await lines.send({ t: "auth", mac: await detachedMac(key, "client", clientNonce, serverNonce) });
  return statusOf(await lines.next());
}

/**
 * What a connection to a recorded control endpoint found:
 *
 * - `session`: it authenticated;
 * - `stale`: nothing listens there (refused), or what answered did not prove the key, named
 *   another sidecar or closed the connection: no sidecar of this record is running;
 * - `busy`: something accepted the connection (the endpoint's listening socket exists only while
 *   its process runs) but did not answer within the budget: the sidecar is alive and its event
 *   loop busy, or a silent process holds the port. Never a reason to start a second instance.
 */
export type DetachedProbe =
  | { readonly state: "session"; readonly session: DetachedSession }
  | { readonly state: "stale" }
  | { readonly state: "busy"; readonly waitedMs: number };

/**
 * Connect to a detached sidecar's control endpoint and authenticate both ways, telling a stale
 * endpoint from a busy one ({@linkcode DetachedProbe}). A connection that is accepted but not
 * answered within `timeoutMs` is kept waiting another `busyWaitMs` (default none) before it
 * reads as busy.
 *
 * @param options The port, the key, the expected name and the budgets.
 * @returns What the endpoint is.
 */
export async function probeDetachedControl(
  options: DetachedConnectOptions & { readonly busyWaitMs?: number },
): Promise<DetachedProbe> {
  const timeoutMs = options.timeoutMs ?? DETACHED_HANDSHAKE_MS;
  let key: CryptoKey;
  try {
    key = await importDetachedKey(options.key);
  } catch {
    return { state: "stale" };
  }
  const open = options.connect ??
    ((port: number) => Deno.connect({ hostname: "127.0.0.1", port, transport: "tcp" }));
  let conn: DetachedConn;
  try {
    // Loopback: a dead endpoint refuses at once; one that never connects is no sidecar either.
    const opened = await within(open(options.port), timeoutMs);
    if (!opened) return { state: "stale" };
    conn = opened;
  } catch {
    return { state: "stale" };
  }
  const lines = new DetachedLines(conn);
  const handshake = clientHandshake(lines, key).catch(() => null);
  let info = await within(handshake, timeoutMs);
  let waitedMs = timeoutMs;
  if (info === undefined && options.busyWaitMs && options.busyWaitMs > 0) {
    info = await within(handshake, options.busyWaitMs);
    waitedMs += options.busyWaitMs;
  }
  if (info === undefined) {
    lines.close();
    return { state: "busy", waitedMs };
  }
  if (!info || (options.name !== undefined && info.name !== options.name)) {
    lines.close();
    return { state: "stale" };
  }
  return { state: "session", session: detachedSession(lines, info) };
}

/**
 * Connect to a detached sidecar's control endpoint and authenticate both ways.
 *
 * @param options The port, the key and the expected name.
 * @returns The session, or `null` when nothing there proves the key within the budget (no
 *   detail; {@linkcode probeDetachedControl} tells a stale endpoint from a busy one).
 */
export async function connectDetachedControl(
  options: DetachedConnectOptions,
): Promise<DetachedSession | null> {
  const probe = await probeDetachedControl(options);
  return probe.state === "session" ? probe.session : null;
}

/** A `bye` message's fields. */
function byeOf(msg: Record<string, unknown>): NonNullable<DetachedEnd["bye"]> {
  return {
    ...(typeof msg.code === "number" ? { code: msg.code } : {}),
    ...(typeof msg.error === "string" ? { error: msg.error } : {}),
    ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}),
  };
}

/** The session over an authenticated connection: a reader that routes the server's messages. */
function detachedSession(lines: DetachedLines, info: DetachedStatusInfo): DetachedSession {
  let ready = info.ready;
  let open = true;
  let bye: DetachedEnd["bye"];
  let readyResolve!: () => void;
  const readyP = new Promise<void>((r) => readyResolve = r);
  if (ready) readyResolve();
  const pongs: Array<(ok: boolean) => void> = [];
  const statuses: Array<(s: DetachedStatusInfo | null) => void> = [];
  const route = (msg: Record<string, unknown>): void => {
    if (msg.t === "pong") pongs.shift()?.(true);
    else if (msg.t === "ok") statuses.shift()?.(statusOf(msg));
    else if (msg.t === "bye") bye = byeOf(msg);
    else if (msg.t === "ready") {
      ready = true;
      readyResolve();
    }
  };
  const closed = (async (): Promise<DetachedEnd> => {
    for (let msg = await lines.next(); msg; msg = await lines.next()) route(msg);
    open = false;
    for (const p of pongs.splice(0)) p(false);
    for (const s of statuses.splice(0)) s(null);
    return bye ? { bye } : {};
  })();
  return {
    info,
    get ready() {
      return ready;
    },
    whenReady: () => readyP,
    closed,
    get open() {
      return open;
    },
    ping() {
      if (!open) return Promise.resolve(false);
      const p = new Promise<boolean>((r) => pongs.push(r));
      void lines.send({ t: "ping" });
      return p;
    },
    status() {
      if (!open) return Promise.resolve(null);
      const p = new Promise<DetachedStatusInfo | null>((r) => statuses.push(r));
      void lines.send({ t: "status" });
      return p;
    },
    async shutdown(graceMs) {
      const grace = Math.min(Math.max(0, graceMs), DETACHED_MAX_GRACE_MS);
      if (open) void lines.send({ t: "shutdown", graceMs: grace });
      return (await within(closed, grace + 1000)) !== undefined;
    },
    close: () => lines.close(),
  };
}

// ── the host's helpers ─────────────────────────────────────────────────────────────────────────

/**
 * Authenticate a record's endpoint.
 *
 * @param record The record.
 * @param timeoutMs The handshake budget.
 * @returns The session, or `null` when nothing there proves its key within the budget.
 */
function probeDetachedRecord(
  record: DetachedRecord,
  timeoutMs = DETACHED_HANDSHAKE_MS,
): Promise<DetachedSession | null> {
  return connectDetachedControl({
    port: record.control.port,
    key: record.key,
    name: record.name,
    timeoutMs,
  });
}

/** How long a busy recorded sidecar is waited for, past the handshake budget (default). */
const DETACHED_BUSY_WAIT_MS = 30_000;

/**
 * Probe a record's endpoint, telling stale from busy ({@linkcode probeDetachedControl}).
 *
 * @param record The record.
 * @param busyWaitMs How long a connected but silent endpoint is waited for past the handshake
 *   budget (default {@linkcode DETACHED_BUSY_WAIT_MS}).
 * @param timeoutMs The handshake budget.
 * @returns What the endpoint is.
 */
export function probeDetachedRecordState(
  record: DetachedRecord,
  busyWaitMs: number = DETACHED_BUSY_WAIT_MS,
  timeoutMs: number = DETACHED_HANDSHAKE_MS,
): Promise<DetachedProbe> {
  return probeDetachedControl({
    port: record.control.port,
    key: record.key,
    name: record.name,
    timeoutMs,
    busyWaitMs,
  });
}

/**
 * Whether this process may signal other processes (`--allow-run` granted unscoped), as a forced
 * kill takes it.
 *
 * @returns Whether `Deno.kill` is permitted.
 */
function canSignalProcesses(): boolean {
  try {
    return Deno.permissions.querySync({ name: "run" }).state === "granted";
  } catch {
    return false;
  }
}

/** How {@linkcode endDetachedSession} went. */
export interface DetachedStopResult {
  /** Whether the sidecar is gone. */
  readonly ended: boolean;
  /** Whether it took a forced kill. */
  readonly killed?: boolean;
  /** Why it is still running, when it is. */
  readonly reason?: string;
}

/** Options for {@linkcode endDetachedSession}. */
export interface DetachedStopOptions {
  /** Whether a forced kill is permitted (default {@linkcode canSignalProcesses}). */
  readonly canKill?: () => boolean;
  /** The forced kill (default `Deno.kill(pid, "SIGKILL")`). */
  readonly kill?: (pid: number) => void;
  /**
   * How long a recorded sidecar that accepts its control connection but does not answer is
   * waited for before it reads as busy (default {@linkcode DETACHED_BUSY_WAIT_MS}).
   */
  readonly busyWaitMs?: number;
}

/**
 * End a detached sidecar over its authenticated session: `shutdown` with `graceMs`, and when the
 * connection is still open past it, a forced kill of the pid THIS session's `ok` named (only where
 * the app may signal processes). Never signals any other pid.
 *
 * @param session An authenticated session.
 * @param graceMs The grace (capped at 30 s).
 * @param options The kill (tests).
 * @returns Whether it ended.
 */
export async function endDetachedSession(
  session: DetachedSession,
  graceMs: number,
  options: DetachedStopOptions = {},
): Promise<DetachedStopResult> {
  if (await session.shutdown(graceMs)) return { ended: true };
  const allowed = (options.canKill ?? canSignalProcesses)();
  if (!allowed) {
    session.close();
    return {
      ended: false,
      reason: `did not end within ${graceMs} ms, and the app has no run permission to end ` +
        `process ${session.info.pid}`,
    };
  }
  try {
    (options.kill ?? ((pid) => Deno.kill(pid, "SIGKILL")))(session.info.pid);
  } catch (err) {
    session.close();
    return { ended: false, reason: `could not end process ${session.info.pid}: ${String(err)}` };
  }
  const gone = (await within(session.closed, 2_000)) !== undefined;
  session.close();
  return gone
    ? { ended: true, killed: true }
    : { ended: false, reason: `process ${session.info.pid} did not end after a forced kill` };
}

/** What {@linkcode currentAppVersion} reads of the app's executable (its size and change time). */
export type ExecutableStamp = () => { size: number; mtime: Date | null } | null;

/** The running executable's size and change time, or `null` when it cannot be read. */
function executableStamp(): { size: number; mtime: Date | null } | null {
  try {
    const { size, mtime } = Deno.statSync(Deno.execPath());
    return { size, mtime };
  } catch {
    return null;
  }
}

/**
 * The running app's build as its detached sidecars record it, so a sidecar an older build started
 * is replaced: in a packaged app the version the full-app updater reports (where it has one),
 * then the executable's size and change time, which differ for every build whether the app was
 * updated by the updater or by installing over it; `"dev"` outside a packaged app.
 *
 * @param desktop `Deno.desktop` (tests pass a fake).
 * @param standalone Whether this is a compiled app.
 * @param stamp Reads the executable (tests pass a fake).
 * @returns The version.
 */
export function currentAppVersion(
  desktop: unknown = (Deno as unknown as { desktop?: unknown }).desktop,
  standalone: boolean = (Deno.build as { standalone?: boolean }).standalone === true,
  stamp: ExecutableStamp = executableStamp,
): string {
  if (!standalone) return "dev";
  let version = "";
  try {
    const updater = (desktop as { updater?: { status?: () => { version?: unknown } } })?.updater;
    const reported = updater?.status?.()?.version;
    if (typeof reported === "string") version = reported;
  } catch { /* no updater here */ }
  const exe = stamp();
  const build = exe === null ? "" : `${exe.size}.${exe.mtime?.getTime() ?? 0}`;
  if (version === "" && build === "") return "dev";
  return build === "" ? version : `${version}+${build}`;
}

/** One entry of {@linkcode listDetachedSidecars}. */
export interface DetachedSidecarEntry {
  /** The sidecar's name. */
  readonly name: string;
  /** The process id it reported (informational). */
  readonly pid: number;
  /** When it was started (epoch ms). */
  readonly startedAt: number;
  /** The app version that started it. */
  readonly appVersion: string;
  /** Whether its endpoint authenticated just now. */
  readonly reachable: boolean;
  /** Whether the running app declares a detached sidecar of that name. */
  readonly declared: boolean;
}

/**
 * The registry's records, each probed: what an app shows to offer stopping leftovers.
 *
 * @param registryDir The registry folder.
 * @param declared The names of the app's detached sidecars.
 * @returns The entries.
 */
export async function listDetachedSidecars(
  registryDir: string,
  declared: readonly string[],
): Promise<DetachedSidecarEntry[]> {
  const records = await listDetachedRecords(registryDir);
  return await Promise.all(records.map(async (r) => {
    const session = await probeDetachedRecord(r);
    session?.close();
    return {
      name: r.name,
      pid: session?.info.pid ?? r.pid,
      startedAt: r.startedAt,
      appVersion: r.appVersion,
      reachable: session !== null,
      declared: declared.includes(r.name),
    };
  }));
}

/**
 * Stop the detached sidecar a record names and remove the record: a stale record (nothing proves
 * its key) is removed without touching its pid.
 *
 * @param registryDir The registry folder.
 * @param name The sidecar's name.
 * @param graceMs The shutdown grace.
 * @param options The kill (tests).
 * @returns Once it is gone; rejects when there is no such record, or it could not be ended (the
 *   record is removed anyway: the sidecar then ends itself at its next registry check).
 */
export async function stopDetachedRecord(
  registryDir: string,
  name: string,
  graceMs: number,
  options: DetachedStopOptions = {},
): Promise<void> {
  const record = await readDetachedRecord(registryDir, name);
  if (!record) throw new Error(`sidecar ${name}: no detached sidecar of that name is recorded`);
  const probe = await probeDetachedRecordState(record, options.busyWaitMs);
  const result: DetachedStopResult = probe.state === "session"
    ? await endDetachedSession(probe.session, graceMs, options)
    : probe.state === "busy"
    ? {
      ended: false,
      reason: `is running but did not answer within ${probe.waitedMs} ms; its record is ` +
        "removed, so it ends itself at its next registry check",
    }
    : { ended: true };
  await removeDetachedRecord(registryDir, name, record.key);
  if (!result.ended) throw new Error(`sidecar ${name}: ${result.reason}`);
}

/**
 * Stop and remove every recorded detached sidecar the app no longer declares (an update dropped
 * it), and every stale record. Failures are logged, never thrown.
 *
 * @param registryDir The registry folder.
 * @param declared The names of the app's detached sidecars.
 * @param graceMs The shutdown grace.
 * @returns The names it removed.
 */
export async function cleanDetachedLeftovers(
  registryDir: string,
  declared: readonly string[],
  graceMs: number,
): Promise<string[]> {
  const removed: string[] = [];
  for (const record of await listDetachedRecords(registryDir)) {
    if (declared.includes(record.name)) continue;
    try {
      await stopDetachedRecord(registryDir, record.name, graceMs);
      removed.push(record.name);
    } catch (err) {
      console.error(`desktop: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return removed;
}
