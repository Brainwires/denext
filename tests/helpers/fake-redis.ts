// A small in-process Redis server for tests: real RESP2 over a real TCP socket, so denext's
// client (src/server/redis.ts) is exercised end to end — AUTH, SELECT, pipelining, MULTI/EXEC,
// errors, a dropped connection — and the Redis stores run their contract suites on every Deno
// without a server. It implements only the commands those stores send, with Redis's semantics
// for them (lazy key expiry, WRONGTYPE, NX/XX/GT on expiry, sorted-set order). The same suites
// run against a real Redis in tests/redis-integration.test.ts.

import { RespReader } from "../../src/server/redis.ts";

type Value =
  | { type: "string"; value: string }
  | { type: "hash"; value: Map<string, string> }
  | { type: "set"; value: Set<string> }
  | { type: "zset"; value: Map<string, number> };
type Item = Value & { expireAt?: number };
type ValueOf = {
  string: string;
  hash: Map<string, string>;
  set: Set<string>;
  zset: Map<string, number>;
};
type Db = Map<string, Item>;

/** A reply to encode. */
type Reply = string | number | null | Reply[] | { ok: string } | { error: string };

const OK = { ok: "OK" };
const WRONGTYPE = { error: "WRONGTYPE Operation against a key holding the wrong kind of value" };
const encoder = new TextEncoder();

function encode(reply: Reply): string {
  if (reply === null) return "$-1\r\n";
  if (typeof reply === "number") return `:${reply}\r\n`;
  if (typeof reply === "string") return `$${encoder.encode(reply).length}\r\n${reply}\r\n`;
  if (Array.isArray(reply)) return `*${reply.length}\r\n${reply.map(encode).join("")}`;
  if ("ok" in reply) return `+${reply.ok}\r\n`;
  return `-${reply.error}\r\n`;
}

/** Options for {@linkcode fakeRedis}. */
export interface FakeRedisOptions {
  /** Require `AUTH` with this password. */
  password?: string;
  /** …and this ACL user name (else the `default` user). */
  username?: string;
}

/** A running fake server. */
export interface FakeRedis {
  /** `redis://127.0.0.1:<port>` (no credentials). */
  url: string;
  port: number;
  /** Every command received, upper-cased name first. */
  log: string[][];
  /** Drop every open connection (the client sees the server go away). */
  dropConnections(): void;
  /** The raw item at `key` in database `db`, for assertions. */
  peek(key: string, db?: number): Item | undefined;
  /** Stop the server and close every connection. */
  close(): Promise<void>;
}

/** Per-connection state. */
interface Session {
  db: number;
  authed: boolean;
  queue: string[][] | undefined;
  /** Pub/sub channels this connection is subscribed to. */
  channels: Set<string>;
  /** Write to this connection (in order, also from another connection's PUBLISH). */
  write(text: string): Promise<void>;
}

/**
 * Start a fake Redis server on a free loopback port.
 *
 * @param options Credentials to require.
 * @returns The running server.
 */
export function fakeRedis(options: FakeRedisOptions = {}): FakeRedis {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const dbs = new Map<number, Db>();
  const conns = new Set<Deno.Conn>();
  const log: string[][] = [];
  const tasks = new Set<Promise<void>>();
  const db = (n: number): Db => {
    let d = dbs.get(n);
    if (!d) dbs.set(n, d = new Map());
    return d;
  };

  const serve = async (conn: Deno.Conn) => {
    conns.add(conn);
    let chain = Promise.resolve();
    const session: Session = {
      db: 0,
      authed: options.password === undefined,
      queue: undefined,
      channels: new Set(),
      write(text) {
        const bytes = encoder.encode(text);
        chain = chain.then(async () => {
          let at = 0;
          while (at < bytes.length) at += await conn.write(bytes.subarray(at));
        }).catch(() => {});
        return chain;
      },
    };
    sessions.add(session);
    const reader = new RespReader();
    const buffer = new Uint8Array(64 * 1024);
    try {
      while (true) {
        const n = await conn.read(buffer);
        if (n === null) break;
        reader.feed(buffer.slice(0, n));
        let out = "";
        for (let c = reader.next(); c; c = reader.next()) {
          const command = (c.value as string[]).map(String);
          log.push([command[0].toUpperCase(), ...command.slice(1)]);
          out += encode(dispatch(session, command));
        }
        if (out) await session.write(out);
      }
    } catch {
      // connection dropped
    } finally {
      conns.delete(conn);
      sessions.delete(session);
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  };

  /** The transaction commands, which act on the connection rather than the data. */
  const sessions = new Set<Session>();
  const control: Record<string, (session: Session, args: string[]) => Reply> = {
    SUBSCRIBE(session, [channel]) {
      session.channels.add(channel);
      return ["subscribe", channel, session.channels.size];
    },
    PUBLISH(_session, [channel, message]) {
      let receivers = 0;
      for (const other of sessions) {
        if (!other.channels.has(channel)) continue;
        receivers++;
        void other.write(encode(["message", channel, message]));
      }
      return receivers;
    },
    MULTI(session) {
      if (session.queue) return { error: "ERR MULTI calls can not be nested" };
      session.queue = [];
      return OK;
    },
    EXEC(session) {
      if (!session.queue) return { error: "ERR EXEC without MULTI" };
      const queued = session.queue;
      session.queue = undefined;
      return queued.map((c) => run(session, c));
    },
    DISCARD(session) {
      session.queue = undefined;
      return OK;
    },
  };

  /** Queue a command inside MULTI (an unknown one discards the transaction). */
  const enqueue = (session: Session, command: string[]): Reply => {
    if (!(command[0].toUpperCase() in COMMANDS)) {
      session.queue = undefined;
      return { error: `ERR unknown command '${command[0]}'` };
    }
    session.queue!.push(command);
    return { ok: "QUEUED" };
  };

  const dispatch = (session: Session, command: string[]): Reply => {
    const name = command[0].toUpperCase();
    if (name === "AUTH") return auth(session, command.slice(1));
    if (!session.authed) return { error: "NOAUTH Authentication required." };
    if (control[name]) return control[name](session, command.slice(1));
    return session.queue ? enqueue(session, command) : run(session, command);
  };

  const auth = (session: Session, args: string[]): Reply => {
    const [user, pass] = args.length === 2 ? args : ["default", args[0]];
    if (options.password === undefined) {
      return { error: "ERR AUTH <password> called without any password configured" };
    }
    if (pass !== options.password || user !== (options.username ?? "default")) {
      return { error: "WRONGPASS invalid username-password pair or user is disabled." };
    }
    session.authed = true;
    return OK;
  };

  const run = (session: Session, command: string[]): Reply => {
    const name = command[0].toUpperCase();
    const handler = COMMANDS[name];
    if (!handler) return { error: `ERR unknown command '${command[0]}'` };
    if (name === "SELECT") {
      session.db = Number(command[1]);
      return OK;
    }
    return handler(new Store(db(session.db)), command.slice(1));
  };

  (async () => {
    for await (const conn of listener) {
      const task = serve(conn);
      tasks.add(task);
      task.finally(() => tasks.delete(task));
    }
  })().catch(() => {});

  return {
    url: `redis://127.0.0.1:${port}`,
    port,
    log,
    dropConnections() {
      for (const conn of conns) {
        try {
          conn.close();
        } catch {
          // already closed
        }
      }
    },
    peek: (key, n = 0) => new Store(db(n)).item(key),
    async close() {
      listener.close();
      this.dropConnections();
      await Promise.all(tasks);
    },
  };
}

/** One database with lazy expiry. */
class Store {
  constructor(readonly db: Db) {}

  item(key: string): Item | undefined {
    const item = this.db.get(key);
    if (item?.expireAt !== undefined && item.expireAt <= Date.now()) {
      this.db.delete(key);
      return undefined;
    }
    return item;
  }

  /** The value of `type` at key, `undefined` when absent, or WRONGTYPE. */
  get<T extends keyof ValueOf>(key: string, type: T): ValueOf[T] | undefined | typeof WRONGTYPE {
    const item = this.item(key);
    if (!item) return undefined;
    if (item.type !== type) return WRONGTYPE;
    return item.value as ValueOf[T];
  }

  /** The value of `type` at key, created empty when absent. */
  ensure<T extends keyof ValueOf>(
    key: string,
    type: T,
    empty: () => ValueOf[T],
  ): ValueOf[T] | typeof WRONGTYPE {
    const current = this.get(key, type);
    if (current !== undefined) return current;
    const value = empty();
    this.db.set(key, { type, value } as Item);
    return value;
  }

  /** Drop an emptied collection, as Redis does. */
  prune(key: string): void {
    const item = this.db.get(key);
    if (item && item.type !== "string" && item.value.size === 0) this.db.delete(key);
  }
}

const isError = (v: unknown): v is { error: string } =>
  typeof v === "object" && v !== null && "error" in v;

/** Sorted-set members in Redis order: by score, then member. */
function ordered(z: Map<string, number>): [string, number][] {
  return [...z].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const score = (s: string): number =>
  s === "-inf" ? -Infinity : s === "+inf" || s === "inf" ? Infinity : Number(s);

/** PEXPIREAT's conditions; a key with no expiry counts as an infinite one for GT / LT. */
const EXPIRY_FLAGS: Record<string, (current: number | undefined, next: number) => boolean> = {
  "": () => true,
  NX: (current) => current === undefined,
  XX: (current) => current !== undefined,
  GT: (current, next) => current !== undefined && next > current,
  LT: (current, next) => current === undefined || next < current,
};

const COMMANDS: Record<string, (s: Store, a: string[]) => Reply> = {
  SELECT: () => OK,
  PING: () => ({ ok: "PONG" }),
  FLUSHDB: (s) => {
    s.db.clear();
    return OK;
  },
  GET: (s, [k]) => {
    const v = s.get(k, "string");
    return isError(v) ? v : v ?? null;
  },
  SET: (s, [k, v, ...flags]) => {
    const upper = flags.map((f) => f.toUpperCase());
    const exists = s.item(k) !== undefined;
    if ((upper.includes("NX") && exists) || (upper.includes("XX") && !exists)) return null;
    let expireAt: number | undefined;
    const pxat = upper.indexOf("PXAT");
    const px = upper.indexOf("PX");
    if (pxat >= 0) expireAt = Number(flags[pxat + 1]);
    else if (px >= 0) expireAt = Date.now() + Number(flags[px + 1]);
    s.db.set(k, { type: "string", value: v, expireAt });
    if (expireAt !== undefined && expireAt <= Date.now()) s.db.delete(k);
    return OK;
  },
  DEL: (s, keys) => keys.filter((k) => s.item(k) !== undefined && s.db.delete(k)).length,
  EXISTS: (s, keys) => keys.filter((k) => s.item(k) !== undefined).length,
  PTTL: (s, [k]) => {
    const item = s.item(k);
    return !item ? -2 : item.expireAt === undefined ? -1 : item.expireAt - Date.now();
  },
  PEXPIREAT: (s, [k, at, flag]) => {
    const item = s.item(k);
    const next = Number(at);
    if (!item || !EXPIRY_FLAGS[flag?.toUpperCase() ?? ""](item.expireAt, next)) return 0;
    item.expireAt = next;
    if (next <= Date.now()) s.db.delete(k);
    return 1;
  },
  HSET: (s, [k, ...pairs]) => {
    const h = s.ensure(k, "hash", () => new Map());
    if (isError(h)) return h;
    let added = 0;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (!h.has(pairs[i])) added++;
      h.set(pairs[i], pairs[i + 1]);
    }
    return added;
  },
  HSETNX: (s, [k, f, v]) => {
    const h = s.ensure(k, "hash", () => new Map());
    if (isError(h)) return h;
    if (h.has(f)) return 0;
    h.set(f, v);
    return 1;
  },
  HGET: (s, [k, f]) => {
    const h = s.get(k, "hash");
    return isError(h) ? h : h?.get(f) ?? null;
  },
  HMGET: (s, [k, ...fields]) => {
    const h = s.get(k, "hash");
    return isError(h) ? h : fields.map((f) => h?.get(f) ?? null);
  },
  HGETALL: (s, [k]) => {
    const h = s.get(k, "hash");
    return isError(h) ? h : [...(h ?? [])].flat();
  },
  HINCRBY: (s, [k, f, by]) => {
    const h = s.ensure(k, "hash", () => new Map());
    if (isError(h)) return h;
    const current = Number(h.get(f) ?? "0");
    if (!Number.isInteger(current)) return { error: "ERR hash value is not an integer" };
    h.set(f, String(current + Number(by)));
    return current + Number(by);
  },
  SADD: (s, [k, ...members]) => {
    const set = s.ensure(k, "set", () => new Set());
    if (isError(set)) return set;
    const before = set.size;
    for (const m of members) set.add(m);
    return set.size - before;
  },
  SREM: (s, [k, ...members]) => {
    const set = s.get(k, "set");
    if (isError(set) || !set) return set ? set : 0;
    const removed = members.filter((m) => set.delete(m)).length;
    s.prune(k);
    return removed;
  },
  SMEMBERS: (s, [k]) => {
    const set = s.get(k, "set");
    return isError(set) ? set : [...(set ?? [])];
  },
  ZADD: (s, [k, ...pairs]) => {
    const z = s.ensure(k, "zset", () => new Map());
    if (isError(z)) return z;
    let added = 0;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (!z.has(pairs[i + 1])) added++;
      z.set(pairs[i + 1], score(pairs[i]));
    }
    return added;
  },
  ZREM: (s, [k, ...members]) => {
    const z = s.get(k, "zset");
    if (isError(z) || !z) return z ? z : 0;
    const removed = members.filter((m) => z.delete(m)).length;
    s.prune(k);
    return removed;
  },
  ZCARD: (s, [k]) => {
    const z = s.get(k, "zset");
    return isError(z) ? z : z?.size ?? 0;
  },
  ZRANGE: (s, [k, start, stop]) => {
    const z = s.get(k, "zset");
    if (isError(z)) return z;
    const all = ordered(z ?? new Map()).map(([m]) => m);
    const from = Number(start) < 0 ? all.length + Number(start) : Number(start);
    const to = Number(stop) < 0 ? all.length + Number(stop) : Number(stop);
    return all.slice(Math.max(0, from), to + 1);
  },
  ZRANGEBYSCORE: (s, [k, min, max]) => {
    const z = s.get(k, "zset");
    if (isError(z)) return z;
    return ordered(z ?? new Map())
      .filter(([, sc]) => sc >= score(min) && sc <= score(max))
      .map(([m]) => m);
  },
};
