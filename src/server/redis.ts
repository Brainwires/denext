/**
 * A zero-npm Redis client: RESP2 over `Deno.connect` (or `Deno.connectTls` for `rediss://`),
 * with `AUTH` (password or ACL user + password) and `SELECT`. It is what denext's Redis stores
 * ({@linkcode redisCacheStore}, {@linkcode redisSessionStore}, {@linkcode redisRateLimitStore})
 * run on, and it works with any Redis 7+ or Valkey server.
 *
 * ```ts
 * import { redisClient } from "denext/server";
 * const redis = redisClient(Deno.env.get("REDIS_URL")); // redis://user:pass@host:6379/0
 * await redis.command("SET", "greeting", "hello");
 * const [a, b] = await redis.pipeline([["GET", "greeting"], ["INCR", "visits"]]);
 * await redis.close();
 * ```
 *
 * One client holds one connection and pipelines every command on it, so many requests share
 * it without waiting on one another; a {@linkcode RedisClient.transaction} is written as one
 * `MULTI` … `EXEC` block, which no other command can interleave. The connection opens on the
 * first command and reopens on the next one after it drops (commands in flight when it dropped
 * reject). Pub/sub and blocking commands are not supported: they would hold the shared
 * connection.
 *
 * @module
 */

import { inRootContext } from "./root-context.ts";

/** A RESP2 reply: a simple or bulk string, an integer, a nil, or an array of replies. */
export type RedisReply = string | number | null | RedisReply[];

/** One command: its name and arguments (numbers are sent as their decimal text). */
export type RedisCommand = readonly (string | number)[];

/** Options for {@linkcode redisClient}. */
export interface RedisClientOptions {
  /**
   * `redis://[user[:password]@]host[:port][/db]`, or `rediss://…` for TLS. Defaults to the
   * `REDIS_URL` environment variable, then `redis://127.0.0.1:6379`. The fields below override
   * the URL's parts.
   */
  url?: string;
  /** The server's host name. */
  hostname?: string;
  /** The server's port (default 6379). */
  port?: number;
  /** An ACL user name (`AUTH user password`); omit for the `default` user. */
  username?: string;
  /** The password sent with `AUTH`. */
  password?: string;
  /** The database `SELECT`ed after connecting (default 0). */
  db?: number;
  /**
   * TLS: `true` (what `rediss://` implies), or extra CA certificates (PEM) for a server whose
   * certificate the system store does not trust.
   */
  tls?: boolean | { caCerts?: string[] };
  /** Give up on a connection attempt after this many ms (default 10000). */
  connectTimeoutMs?: number;
}

/** An error reply from the server (`-ERR …`, `-WRONGTYPE …`, `-NOAUTH …`). */
export class RedisError extends Error {
  /** The reply's first word: `ERR`, `WRONGTYPE`, `NOAUTH`, `WRONGPASS`, … */
  readonly code: string;

  /**
   * Create the error.
   *
   * @param message The server's error text.
   */
  constructor(message: string) {
    super(message);
    this.name = "RedisError";
    this.code = message.split(" ", 1)[0];
  }
}

/** The connection failed or dropped; the command's effect on the server is unknown. */
export class RedisConnectionError extends Error {
  /**
   * Create the error.
   *
   * @param message What happened.
   * @param options The underlying error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisConnectionError";
  }
}

/** A Redis connection shared by its callers (see the module docs). */
export interface RedisClient {
  /**
   * Run one command.
   *
   * @param args The command name and its arguments.
   * @returns The reply.
   * @throws {RedisError} When the server answers with an error.
   */
  command(...args: RedisCommand): Promise<RedisReply>;
  /**
   * Send several commands in one write and read their replies in order. Not atomic: another
   * client's commands may run between them (use {@linkcode RedisClient.transaction} for that).
   *
   * @param commands The commands.
   * @returns One reply per command.
   * @throws {RedisError} The first error reply, after every reply has been read.
   */
  pipeline(commands: readonly RedisCommand[]): Promise<RedisReply[]>;
  /**
   * Run commands atomically as one `MULTI` … `EXEC` block.
   *
   * @param commands The commands.
   * @returns One reply per command.
   * @throws {RedisError} When a command is refused or fails inside the block.
   */
  transaction(commands: readonly RedisCommand[]): Promise<RedisReply[]>;
  /** Close the connection; later commands reject. Idempotent. */
  close(): Promise<void>;
}

const CRLF = "\r\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode one command as a RESP array of bulk strings.
 *
 * @param command The command.
 * @returns Its bytes.
 */
export function encodeCommand(command: RedisCommand): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(`*${command.length}${CRLF}`)];
  for (const arg of command) {
    const bytes = encoder.encode(String(arg));
    parts.push(encoder.encode(`$${bytes.length}${CRLF}`), bytes, encoder.encode(CRLF));
  }
  return concat(parts);
}

/** Join byte arrays. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A parsed reply, or an error reply, and where it ended. */
type Parsed = { value: RedisReply | RedisError; end: number };

/**
 * An incremental RESP2 reader: feed it bytes as they arrive and take whole replies out.
 */
export class RespReader {
  #buffer: Uint8Array = new Uint8Array(0);

  /**
   * Append received bytes.
   *
   * @param chunk The bytes.
   */
  feed(chunk: Uint8Array): void {
    this.#buffer = this.#buffer.length ? concat([this.#buffer, chunk]) : chunk;
  }

  /**
   * Take the next complete reply.
   *
   * @returns `{ value }` (a {@linkcode RedisError} for an error reply), or `undefined` until
   *   the rest of the reply has arrived.
   * @throws {RedisConnectionError} On bytes that are not RESP2.
   */
  next(): { value: RedisReply | RedisError } | undefined {
    const parsed = this.#parse(0);
    if (!parsed) return undefined;
    this.#buffer = this.#buffer.subarray(parsed.end);
    return { value: parsed.value };
  }

  /** The `\r\n`-terminated line starting at `at`, or undefined while incomplete. */
  #line(at: number): { text: string; end: number } | undefined {
    const buffer = this.#buffer;
    for (let i = at; i + 1 < buffer.length; i++) {
      if (buffer[i] === 13 && buffer[i + 1] === 10) {
        return { text: decoder.decode(buffer.subarray(at, i)), end: i + 2 };
      }
    }
    return undefined;
  }

  #parse(at: number): Parsed | undefined {
    if (at >= this.#buffer.length) return undefined;
    const type = this.#buffer[at];
    const line = this.#line(at + 1);
    if (!line) return undefined;
    switch (type) {
      case 43: // +
        return { value: line.text, end: line.end };
      case 45: // -
        return { value: new RedisError(line.text), end: line.end };
      case 58: // :
        return { value: Number(line.text), end: line.end };
      case 36: // $
        return this.#bulk(Number(line.text), line.end);
      case 42: // *
        return this.#array(Number(line.text), line.end);
      default:
        throw new RedisConnectionError(`redis: unexpected reply type byte ${type}`);
    }
  }

  #bulk(length: number, at: number): Parsed | undefined {
    if (length < 0) return { value: null, end: at };
    if (this.#buffer.length < at + length + 2) return undefined;
    return { value: decoder.decode(this.#buffer.subarray(at, at + length)), end: at + length + 2 };
  }

  #array(length: number, at: number): Parsed | undefined {
    if (length < 0) return { value: null, end: at };
    const items: RedisReply[] = [];
    let end = at;
    let error: RedisError | undefined;
    for (let i = 0; i < length; i++) {
      const item = this.#parse(end);
      if (!item) return undefined;
      end = item.end;
      // An EXEC reply carries a failed command's error in its slot.
      if (item.value instanceof RedisError) error ??= item.value;
      items.push(item.value instanceof RedisError ? null : item.value);
    }
    return { value: error ?? items, end };
  }
}

/** Where to connect and how to authenticate, resolved from the options and the URL. */
export interface Target {
  hostname: string;
  port: number;
  tls: boolean;
  caCerts?: string[];
  username?: string;
  password?: string;
  db: number;
  connectTimeoutMs: number;
}

/** The `REDIS_URL` environment variable, when readable. */
function envUrl(): string | undefined {
  try {
    return Deno.env.get("REDIS_URL") || undefined;
  } catch {
    return undefined; // no --allow-env: fall back to the default
  }
}

/**
 * Resolve the connection target from a URL and explicit options.
 *
 * @param options The client options.
 * @returns Host, port, TLS, credentials and database.
 * @throws {TypeError} For a URL that is not `redis://` / `rediss://`, or a bad database number.
 */
export function resolveRedisTarget(options: RedisClientOptions): Target {
  const url = new URL(options.url ?? envUrl() ?? "redis://127.0.0.1:6379");
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new TypeError(`redisClient: expected a redis:// or rediss:// URL, got ${url.protocol}`);
  }
  const target: Target = {
    ...urlTarget(url),
    ...tlsTarget(options.tls ?? url.protocol === "rediss:"),
    ...definedOnly({
      hostname: options.hostname,
      port: options.port,
      username: options.username,
      password: options.password,
      db: options.db,
    }),
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
  };
  if (!Number.isInteger(target.db) || target.db < 0) {
    throw new TypeError(`redisClient: the database must be a non-negative integer`);
  }
  return target;
}

/** A URL-encoded credential, or `undefined` when empty. */
const credential = (text: string): string | undefined =>
  text ? decodeURIComponent(text) : undefined;

/** Host, port, credentials and database from a `redis://` URL. */
function urlTarget(url: URL): Omit<Target, "tls" | "connectTimeoutMs"> {
  const path = url.pathname.replace(/^\//, "");
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
    port: url.port ? Number(url.port) : 6379,
    username: credential(url.username),
    password: credential(url.password),
    db: path ? Number(path) : 0,
  };
}

/** The TLS fields from the `tls` option. */
function tlsTarget(tls: boolean | { caCerts?: string[] }): Pick<Target, "tls" | "caCerts"> {
  if (typeof tls !== "object") return { tls };
  return tls.caCerts ? { tls: true, caCerts: tls.caCerts } : { tls: true };
}

/** The entries of `record` that are not `undefined`. */
function definedOnly<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** A pending reply's settlers. */
interface Waiter {
  resolve(value: RedisReply): void;
  reject(error: Error): void;
}

/** Open the socket (TLS or not), giving up after the timeout. */
export async function dial(target: Target): Promise<Deno.Conn> {
  const opening = target.tls
    ? Deno.connectTls({
      hostname: target.hostname,
      port: target.port,
      ...(target.caCerts ? { caCerts: target.caCerts } : {}),
    })
    : Deno.connect({ hostname: target.hostname, port: target.port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RedisConnectionError(`redis: connecting to ${where(target)} timed out`)),
      target.connectTimeoutMs,
    );
  });
  try {
    return await Promise.race([opening, timeout]);
  } catch (error) {
    // A socket that opens after the timeout is closed, not leaked.
    opening.then((conn) => conn.close(), () => {});
    if (error instanceof RedisConnectionError) throw error;
    throw new RedisConnectionError(`redis: cannot connect to ${where(target)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** `host:port` for messages (never the credentials). */
const where = (target: Target): string => `${target.hostname}:${target.port}`;

/** One socket: writes queued in order, replies matched to waiters first-in first-out. */
class Connection {
  readonly #conn: Deno.Conn;
  readonly #waiters: Waiter[] = [];
  readonly #reader = new RespReader();
  #writing: Promise<unknown> = Promise.resolve();
  #dead: Error | undefined;
  readonly #onDead: () => void;
  readonly done: Promise<void>;

  constructor(conn: Deno.Conn, onDead: () => void) {
    this.#conn = conn;
    this.#onDead = onDead;
    this.done = this.#readLoop();
  }

  get dead(): boolean {
    return this.#dead !== undefined;
  }

  /**
   * Queue the commands' bytes as one write and one waiter per reply, in order.
   *
   * @returns One promise per reply.
   */
  send(commands: readonly RedisCommand[]): Promise<RedisReply>[] {
    if (this.#dead) return commands.map(() => Promise.reject(this.#dead));
    const replies = commands.map(() =>
      new Promise<RedisReply>((resolve, reject) => this.#waiters.push({ resolve, reject }))
    );
    const bytes = concat(commands.map(encodeCommand));
    this.#writing = this.#writing.then(() => this.#writeAll(bytes)).catch((error) =>
      this.#fail(new RedisConnectionError("redis: write failed", { cause: error }))
    );
    return replies;
  }

  async #writeAll(bytes: Uint8Array): Promise<void> {
    let at = 0;
    while (at < bytes.length) at += await this.#conn.write(bytes.subarray(at));
  }

  async #readLoop(): Promise<void> {
    const chunk = new Uint8Array(64 * 1024);
    try {
      while (!this.#dead) {
        const n = await this.#conn.read(chunk);
        if (n === null) throw new RedisConnectionError("redis: the server closed the connection");
        this.#reader.feed(chunk.slice(0, n));
        this.#drain();
      }
    } catch (error) {
      this.#fail(
        error instanceof RedisConnectionError
          ? error
          : new RedisConnectionError("redis: connection lost", { cause: error }),
      );
    }
  }

  /** Settle a waiter per complete reply. */
  #drain(): void {
    for (let reply = this.#reader.next(); reply; reply = this.#reader.next()) {
      const waiter = this.#waiters.shift();
      if (!waiter) throw new RedisConnectionError("redis: a reply nobody asked for");
      if (reply.value instanceof RedisError) waiter.reject(reply.value);
      else waiter.resolve(reply.value);
    }
  }

  /** Mark the connection dead and reject everything waiting on it. */
  #fail(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
    this.#onDead();
  }

  /** Close on purpose. */
  async close(): Promise<void> {
    this.#fail(new RedisConnectionError("redis: the client is closed"));
    await this.done;
  }
}

/** The handshake run before any caller's command: `AUTH` and `SELECT` when configured. */
export function handshake(target: Target): RedisCommand[] {
  const commands: RedisCommand[] = [];
  if (target.password !== undefined) {
    commands.push(
      target.username ? ["AUTH", target.username, target.password] : ["AUTH", target.password],
    );
  }
  if (target.db !== 0) commands.push(["SELECT", target.db]);
  return commands;
}

/** The {@linkcode RedisClient} behind {@linkcode redisClient}. */
class Client implements RedisClient {
  readonly #target: Target;
  #connection: Promise<Connection> | undefined;
  #closed = false;

  constructor(target: Target) {
    this.#target = target;
  }

  /** The live connection, opening (and authenticating) one when there is none. */
  #connect(): Promise<Connection> {
    if (this.#closed) {
      return Promise.reject(new RedisConnectionError("redis: the client is closed"));
    }
    // Shared by every request, so opened in the root context (see root-context.ts).
    const opening = this.#connection ??= inRootContext(() => this.#open());
    return opening.catch((error) => {
      if (this.#connection === opening) this.#connection = undefined; // retry next time
      throw error;
    });
  }

  async #open(): Promise<Connection> {
    const socket = await dial(this.#target);
    const connection = new Connection(socket, () => {
      if (this.#connection === settled) this.#connection = undefined;
    });
    const settled = Promise.resolve(connection);
    const steps = handshake(this.#target);
    if (steps.length) {
      try {
        await Promise.all(connection.send(steps));
      } catch (error) {
        await connection.close();
        throw error;
      }
    }
    if (this.#closed) {
      await connection.close();
      throw new RedisConnectionError("redis: the client is closed");
    }
    this.#connection = settled;
    return connection;
  }

  async command(...args: RedisCommand): Promise<RedisReply> {
    const [reply] = (await this.#connect()).send([args]);
    return await reply;
  }

  async pipeline(commands: readonly RedisCommand[]): Promise<RedisReply[]> {
    if (!commands.length) return [];
    const settled = await Promise.allSettled((await this.#connect()).send(commands));
    const failed = settled.find((s) => s.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
    return settled.map((s) => (s as PromiseFulfilledResult<RedisReply>).value);
  }

  async transaction(commands: readonly RedisCommand[]): Promise<RedisReply[]> {
    if (!commands.length) return [];
    const replies = await this.pipeline([["MULTI"], ...commands, ["EXEC"]]);
    const exec = replies[replies.length - 1];
    if (!Array.isArray(exec)) throw new RedisError("EXECABORT the transaction was discarded");
    return exec;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) await connection.then((c) => c.close(), () => {});
  }
}

/**
 * Open a Redis client (lazily: the first command connects).
 *
 * @param options A `redis://` / `rediss://` URL, or {@linkcode RedisClientOptions}. With
 *   neither, `REDIS_URL` or `redis://127.0.0.1:6379`.
 * @returns The client; `close()` it when done (a server closes the stores' own clients on
 *   drain).
 * @throws {TypeError} For a URL that is not `redis://` / `rediss://`.
 */
export function redisClient(options: string | RedisClientOptions = {}): RedisClient {
  return new Client(resolveRedisTarget(typeof options === "string" ? { url: options } : options));
}

/** Options shared by the Redis stores: a client of your own, or a URL to open one. */
export interface RedisConnectionOptions {
  /** A client the app owns (the store never closes it). */
  client?: RedisClient;
  /**
   * A `redis://` / `rediss://` URL (or full {@linkcode RedisClientOptions}) the store opens and
   * closes itself. With neither `client` nor `url`: `REDIS_URL`, then `redis://127.0.0.1:6379`.
   */
  url?: string | RedisClientOptions;
  /**
   * Prefix for every key the store writes, so several apps (or stores) share one database.
   * Each store has its own default (`denext:cache:`, `denext:session:`, `denext:ratelimit:`).
   * Use a hash tag (`{myapp}:cache:`) to keep a store's keys in one Redis Cluster slot.
   */
  prefix?: string;
}

/**
 * The store's client and whether it owns (and so closes) it.
 *
 * @param options The store's options.
 * @param feature The store's name, for errors.
 * @returns The client and ownership.
 * @throws {TypeError} When both `client` and `url` are given.
 */
export function resolveRedis(
  options: RedisConnectionOptions,
  feature: string,
): { client: RedisClient; owned: boolean } {
  if (options.client && options.url !== undefined) {
    throw new TypeError(`${feature}: pass either \`client\` or \`url\`, not both`);
  }
  if (options.client) return { client: options.client, owned: false };
  return { client: redisClient(options.url ?? {}), owned: true };
}
