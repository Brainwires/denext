// The stock `@supabase/supabase-js` client's `supabase.channel(…)` against a denext app on a REAL
// Postgres: two app replicas (separate processes sharing only the database) serve
// `/realtime/v1/websocket` (Phoenix channels, vsn 2.0.0 and 1.0.0) and the REST broadcast, and the
// suite checks what a Supabase app relies on —
//   - postgres_changes: per-user row-level security, event and operator filters, UPDATE/DELETE old
//     records (the key; the whole row with `old: "full"`), TRUNCATE, the payload's shape;
//   - broadcast: across replicas, `self`, `ack`, binary payloads, REST (`httpSend`), and from the
//     database (`realtime.send`, `realtime.broadcast_changes` from a trigger);
//   - presence: track / untrack / sync / join / leave across replicas, and a replica's clean stop;
//   - private channels authorized by `realtime.messages` policies; an expired token closing a
//     channel.
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-supabase-realtime-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL; the protocol and the hub are unit-tested
// in tests/backend-realtime-socket.test.ts.

import { assert, assertEquals } from "@std/assert";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { builtinSql } from "../src/server/postgres.ts";
import {
  generateSupabaseKeys,
  resolveSupabaseKeys,
  signSupabaseJwt,
  type SupabaseKeys,
} from "../src/server/auth/gotrue/keys.ts";
import { migratePostgres } from "../src/server/postgres-migrate.ts";
import { rlsMigrations } from "../packages/backend/src/rls.ts";
import { realtimeMigrations } from "../packages/backend/src/realtime-sql.ts";
import { postgresEnvironment } from "./helpers/postgres-env.ts";
import { type ClientSocket, RealtimeClient } from "../packages/backend/src/realtime-client.ts";
import { cookieFor, settle, until } from "./helpers/realtime-harness.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";

const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
const B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000b";
// Real Supabase keys (`backend({ supabase })`): the publishable key every client sends, users'
// access tokens signed with the ES256 key, the secret key for the service role.
const GENERATED = await generateSupabaseKeys({ legacy: true });
const KEYS_CONFIG = {
  publishableKey: GENERATED.publishableKey,
  secretKey: GENERATED.secretKey,
  jwtSecret: GENERATED.jwtSecret,
  signingKeys: GENERATED.signingKey,
};
const ANON_KEY = GENERATED.publishableKey;
let keys: SupabaseKeys | undefined;

/** A user's access token, as `/auth/v1` would mint it. */
async function accessToken(sub: string, ttlSeconds = 600): Promise<string> {
  keys ??= await resolveSupabaseKeys(KEYS_CONFIG);
  const now = Math.floor(Date.now() / 1000);
  return signSupabaseJwt(keys, {
    sub,
    role: "authenticated",
    aud: "authenticated",
    email: `${sub.slice(-4)}@x.test`,
    iat: now,
    exp: now + ttlSeconds,
  });
}

const REALTIME = {
  tables: { notes: {}, items: { old: "full" } },
};

const DDL = `
  create table notes (id bigserial primary key, owner uuid not null, body text not null,
    priority int not null default 0);
  alter table notes enable row level security;
  create policy "read own" on notes for select using (auth.uid() = owner);
  grant select on notes to anon, authenticated;
  create table items (id int primary key, label text not null);
  grant select on items to anon, authenticated;
  create table logs (id serial primary key, msg text not null);
  create function logs_broadcast() returns trigger security definer language plpgsql as $$
  begin
    perform realtime.broadcast_changes('logs', TG_OP, TG_OP, TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD);
    return null;
  end $$;
  create trigger logs_broadcast after insert on logs for each row execute function logs_broadcast();
  create policy "own topic read" on realtime.messages for select to authenticated
    using (realtime.topic() = 'private-' || auth.uid()::text or realtime.topic() = 'logs');
  create policy "own topic write" on realtime.messages for insert to authenticated
    with check (realtime.topic() = 'private-' || auth.uid()::text);
  -- Opted in the Supabase way: by the publication, not realtime({ tables }).
  create table pubnotes (id int primary key, body text not null);
  grant select on pubnotes to anon, authenticated;
  create schema app;
  grant usage on schema app to anon, authenticated;
  create table app.things (id int primary key, label text not null);
  alter table app.things replica identity full;
  grant select on app.things to anon, authenticated;
  alter publication supabase_realtime add table pubnotes, app.things;
`;

/** A replica process. */
interface Replica {
  origin: string;
  /** Close its stdin: a clean shutdown (teardown runs). */
  stop(): Promise<void>;
  /** SIGKILL it: a crashed instance (nothing runs). */
  kill(): Promise<void>;
}

async function replica(
  url: string,
  realtime: Record<string, unknown> = REALTIME,
): Promise<Replica> {
  const script = new URL("./helpers/realtime-replica.ts", import.meta.url).pathname;
  const config = new URL("../deno.json", import.meta.url).pathname;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", config, script],
    env: {
      REPLICA_DB_URL: url,
      REPLICA_REALTIME: JSON.stringify(realtime),
      REPLICA_SUPABASE: JSON.stringify(KEYS_CONFIG),
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let port = 0;
  const deadline = Date.now() + 60_000;
  while (!port) {
    if (Date.now() > deadline) throw new Error("the replica did not start");
    const { value, done } = await lines.read();
    if (done) throw new Error("the replica exited before it was ready");
    buffer += value;
    const match = /READY (\d+)/.exec(buffer);
    if (match) port = Number(match[1]);
  }
  // Keep draining its output.
  (async () => {
    try {
      while (!(await lines.read()).done) { /* drain */ }
    } catch { /* closed */ }
  })();
  const writer = child.stdin.getWriter();
  return {
    origin: `http://127.0.0.1:${port}`,
    async stop() {
      await writer.close().catch(() => {});
      await child.status;
    },
    async kill() {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      await child.status;
      await writer.close().catch(() => {});
    },
  };
}

/**
 * A supabase-js client against a replica: signed in by a session cookie, or by an access token
 * (supabase-js's `accessToken` option, as with a third-party auth provider), when given.
 */
function client(
  origin: string,
  options: {
    cookie?: string;
    token?: () => Promise<string>;
    key?: string;
    vsn?: "1.0.0" | "2.0.0";
  } = {},
) {
  const { cookie } = options;
  class CookieSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(
        url,
        // Deno's WebSocket takes request headers: the browser would send the cookie itself.
        (cookie ? { protocols, headers: { cookie } } : protocols) as string[],
      );
    }
  }
  return createClient(origin, options.key ?? ANON_KEY, {
    ...(options.token ? { accessToken: options.token } : {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
    realtime: {
      transport: CookieSocket as unknown as typeof WebSocket,
      heartbeatIntervalMs: 5_000,
      ...(options.vsn ? { vsn: options.vsn } : {}),
    },
    global: cookie ? { headers: { cookie } } : {},
  });
}

/** Subscribe; resolves on SUBSCRIBED, rejects on an error, a timeout or a close. */
function subscribed(channel: RealtimeChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, error) => {
      if (status === "SUBSCRIBED") resolve();
      else reject(error ?? new Error(status));
    });
  });
}

/** A JWT (unsigned) with `exp` in the past. */
function expiredJwt(): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: "HS256", typ: "JWT" })}.${
    part({ sub: A, role: "authenticated", exp: now - 120, iat: now - 3600 })
  }.c2ln`;
}

type Change =
  & { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }
  & Record<string, unknown>;

Deno.test({
  name: `supabase-js realtime against two denext replicas on a real Postgres${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    const clients: SupabaseClient[] = [];
    const replicas: Replica[] = [];
    try {
      await migratePostgres(env.app, { migrations: rlsMigrations(), table: "backend_migrations" });
      // The realtime schema now (the policies below are on realtime.messages); the tables'
      // triggers come with the replicas' own migration, once the tables exist.
      await migratePostgres(env.app, {
        migrations: realtimeMigrations(REALTIME as never).filter((m) =>
          !m.name.startsWith("backend_realtime_t_")
        ),
        table: "backend_migrations",
      });
      await env.app.unsafe(DDL).simple!();
      replicas.push(await replica(env.url), await replica(env.url));
      const [r1, r2] = replicas;
      const cookieA = await cookieFor(A);
      const cookieB = await cookieFor(B);
      const make = (origin: string, options?: Parameters<typeof client>[1]) => {
        const c = client(origin, options);
        clients.push(c);
        return c;
      };

      await t.step("postgres_changes: RLS per user, filters, old records, truncate", async () => {
        // A by an access token, B by a session cookie: both are their user under RLS.
        const tokenA = await accessToken(A);
        const a = make(r1.origin, { token: () => Promise.resolve(tokenA) });
        // supabase-js sets a callback token asynchronously: let it land before the join.
        await a.realtime.setAuth(tokenA);
        const b = make(r2.origin, { cookie: cookieB, vsn: "1.0.0" });
        const anon = make(r1.origin);
        const seenA: Change[] = [];
        const seenB: Change[] = [];
        const seenAnon: Change[] = [];
        await subscribed(
          a.channel("a-notes").on(
            "postgres_changes",
            { event: "*", schema: "public", table: "notes" },
            (p) => seenA.push(p as unknown as Change),
          ),
        );
        await subscribed(
          b.channel("b-notes").on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "notes", filter: "priority=gte.5" },
            (p) => seenB.push(p as unknown as Change),
          ),
        );
        await subscribed(
          anon.channel("anon-notes").on(
            "postgres_changes",
            { event: "*", schema: "public", table: "notes" },
            (p) => seenAnon.push(p as unknown as Change),
          ),
        );
        await env.app.unsafe(
          `insert into notes (owner, body, priority) values
             ($1, 'a low', 1), ($2, 'b low', 1), ($2, 'b high', 9)`,
          [A, B],
        );
        await until(() => seenA.length === 1 && seenB.length === 1, 10_000, "the inserts");
        assertEquals(seenA[0].eventType, "INSERT");
        assertEquals(seenA[0].schema, "public");
        assertEquals(seenA[0].table, "notes");
        assertEquals(seenA[0].new.owner, A);
        assertEquals(seenA[0].new.body, "a low");
        assertEquals(typeof seenA[0].new.id, "number", "typed by the columns");
        assert(typeof seenA[0].commit_timestamp === "string");
        assertEquals(seenB[0].new.body, "b high", "B's operator filter");
        const id = seenA[0].new.id as number;

        await env.app.unsafe("update notes set body = 'a edited' where id = $1", [id]);
        await until(() => seenA.length === 2, 10_000, "the update");
        assertEquals(seenA[1].eventType, "UPDATE");
        assertEquals(seenA[1].new.body, "a edited");
        assertEquals(seenA[1].old, { id }, "the key, as Supabase sends under RLS");

        await env.app.unsafe("delete from notes where id = $1", [id]);
        await until(() => seenA.length === 3, 10_000, "the delete");
        assertEquals(seenA[2].eventType, "DELETE");
        assertEquals(seenA[2].old, { id: Number(id) });
        assertEquals(seenB.length, 1, "B: INSERTs only");

        // TRUNCATE reaches a subscriber who could see rows of the table (A has one again).
        await env.app.unsafe("insert into notes (owner, body) values ($1, 'a again')", [A]);
        await until(() => seenA.length === 4, 10_000, "the insert");
        await env.app.unsafe("truncate notes");
        await until(() => seenA.length === 5, 10_000, "the truncate");
        assertEquals(seenA[4].eventType, "TRUNCATE");
        await settle(300);
        assertEquals(seenAnon, [], "anon's policies see no note");

        // A table without RLS, configured `old: "full"`: the whole old row.
        const seenItems: Change[] = [];
        await subscribed(
          anon.channel("items").on(
            "postgres_changes",
            { event: "*", schema: "public", table: "items", filter: "id=in.(1,2)" },
            (p) => seenItems.push(p as unknown as Change),
          ),
        );
        await env.app.unsafe("insert into items values (1, 'one'), (2, 'two'), (3, 'three')");
        await until(() => seenItems.length === 2, 10_000, "two of three items");
        await env.app.unsafe("update items set label = 'uno' where id = 1");
        await env.app.unsafe("delete from items where id = 2");
        await until(() => seenItems.length === 4, 10_000, "the item update and delete");
        assertEquals(seenItems[2].old, { id: 1, label: "one" });
        assertEquals(seenItems[3].old, { id: 2, label: "two" });
      });

      await t.step(
        "broadcast: across replicas, self, ack, binary, REST and the database",
        async () => {
          const x = make(r1.origin);
          const y = make(r2.origin, { vsn: "1.0.0" });
          const z = make(r2.origin);
          const atX: unknown[] = [];
          const atY: unknown[] = [];
          const atZ: unknown[] = [];
          const cx = x.channel("room1", { config: { broadcast: { self: false, ack: true } } })
            .on("broadcast", { event: "*" }, (m) => atX.push(m));
          const cy = y.channel("room1").on("broadcast", { event: "hello" }, (m) => atY.push(m));
          const cz = z.channel("room1", { config: { broadcast: { self: true } } })
            .on("broadcast", { event: "*" }, (m) => atZ.push(m));
          await Promise.all([subscribed(cx), subscribed(cy), subscribed(cz)]);

          assertEquals(
            await cx.send({ type: "broadcast", event: "hello", payload: { n: 1 } }),
            "ok",
          );
          await until(() => atY.length === 1 && atZ.length === 1, 10_000, "the broadcast");
          assertEquals((atY[0] as { payload: unknown }).payload, { n: 1 });
          await settle(200);
          assertEquals(atX, [], "self: false");

          await cz.send({ type: "broadcast", event: "hello", payload: { n: 2 } });
          await until(() => atZ.length === 2 && atX.length === 1, 10_000, "self: true");

          // Binary (vsn 2.0.0 only): bytes in, bytes out.
          const bytes = new Uint8Array([1, 2, 3, 250]);
          await cz.send({ type: "broadcast", event: "bin", payload: bytes.buffer });
          await until(() => atX.length === 2, 10_000, "the binary broadcast");
          assertEquals(
            [...new Uint8Array((atX[1] as { payload: ArrayBuffer }).payload)],
            [1, 2, 3, 250],
          );

          // REST, and a payload too large for a NOTIFY (it travels through realtime.messages).
          const big = "x".repeat(20_000);
          const sent = await cy.httpSend("hello", { big });
          assertEquals(sent, { success: true });
          await until(() => atX.length === 3, 10_000, "the REST broadcast");
          assertEquals((atX[2] as { payload: { big: string } }).payload.big.length, 20_000);

          // From the database.
          await env.app.unsafe(
            `select realtime.send('{"from":"sql"}'::jsonb, 'hello', 'room1', false)`,
          );
          await until(
            () => atY.some((m) => (m as { payload: { from?: string } }).payload.from === "sql"),
            10_000,
            "realtime.send",
          );
        },
      );

      await t.step("presence: track, sync, join, leave across replicas", async () => {
        const p = make(r1.origin);
        const q = make(r2.origin);
        const joins: string[] = [];
        const leaves: string[] = [];
        const cp = p.channel("lobby", { config: { presence: { key: "p" } } })
          .on("presence", { event: "join" }, ({ key }) => joins.push(key))
          .on("presence", { event: "leave" }, ({ key }) => leaves.push(key));
        const cq = q.channel("lobby", { config: { presence: { key: "q" } } })
          .on("presence", { event: "sync" }, () => {});
        await Promise.all([subscribed(cp), subscribed(cq)]);
        assertEquals(await cp.track({ online: "p" }), "ok");
        assertEquals(await cq.track({ online: "q" }), "ok");
        await until(() => Object.keys(cp.presenceState()).length === 2, 10_000, "p sees both");
        await until(() => Object.keys(cq.presenceState()).length === 2, 10_000, "q sees both");
        assertEquals(cp.presenceState<{ online: string }>().q[0].online, "q");
        assert(joins.includes("q"));
        await cq.untrack();
        await until(() => leaves.includes("q"), 10_000, "q's leave");
        assertEquals(Object.keys(cp.presenceState()), ["p"]);
        await cq.track({ online: "again" });
        await until(() => Object.keys(cp.presenceState()).length === 2, 10_000, "q back");
      });

      await t.step(
        "private channels: realtime.messages policies, as the joining user",
        async () => {
          const a = make(r1.origin, { cookie: cookieA });
          const b = make(r2.origin, { cookie: cookieB });
          const anon = make(r2.origin);
          const got: unknown[] = [];
          const mine = a.channel(`private-${A}`, {
            config: { private: true, broadcast: { self: true } },
          })
            .on("broadcast", { event: "*" }, (m) => got.push(m));
          await subscribed(mine);
          await mine.send({ type: "broadcast", event: "note", payload: { ok: true } });
          await until(() => got.length === 1, 10_000, "the private broadcast");
          const refused = (await subscribed(
            b.channel(`private-${A}`, { config: { private: true } }),
          ).catch((error) => error)) as Error;
          assert(refused instanceof Error && /Unauthorized/.test(refused.message), String(refused));
          const anonRefused = await subscribed(
            anon.channel(`private-${A}`, { config: { private: true } }),
          ).then(() => false, () => true);
          assert(anonRefused, "anon cannot join");

          // realtime.broadcast_changes from a trigger (a private topic by default).
          const logs: unknown[] = [];
          await subscribed(
            a.channel("logs", { config: { private: true } })
              .on("broadcast", { event: "INSERT" }, (m) => logs.push(m)),
          );
          await env.app.unsafe("insert into logs (msg) values ('written')");
          await until(() => logs.length === 1, 10_000, "broadcast_changes");
          const payload = (logs[0] as { payload: Record<string, unknown> }).payload;
          assertEquals(payload.operation, "INSERT");
          assertEquals(payload.table, "logs");
          assertEquals((payload.record as { msg: string }).msg, "written");
        },
      );

      await t.step(
        "an expired access token is refused at join and closes a joined channel",
        async () => {
          const c = make(r1.origin);
          const states: string[] = [];
          const channel = c.channel("expiring");
          await new Promise<void>((resolve) =>
            channel.subscribe((status) => {
              states.push(status);
              if (status === "SUBSCRIBED") resolve();
            })
          );
          await c.realtime.setAuth(expiredJwt());
          await until(() => states.includes("CLOSED"), 10_000, "the close");
          const d = make(r1.origin);
          await d.realtime.setAuth(expiredJwt());
          const refused = await subscribed(d.channel("late")).then(() => null, (error) => error);
          assert(refused instanceof Error && /expired/.test(refused.message), String(refused));
        },
      );

      await t.step(
        "keys: the apikey is checked; tokens are verified, refreshed, expire",
        async () => {
          // A socket without a valid API key is refused at the upgrade (401).
          const ws = new URL(
            "/realtime/v1/websocket?vsn=1.0.0&apikey=sb_publishable_nope",
            r1.origin,
          );
          const refused = await fetch(ws, {
            headers: { upgrade: "websocket", connection: "upgrade" },
          });
          assertEquals(refused.status, 401);
          await refused.body?.cancel();

          // A forged token (the wrong key) is refused at join.
          const forged = (await accessToken(A)).replace(/\.[^.]+$/, ".AAAA");
          const f = make(r1.origin, { token: () => Promise.resolve(forged) });
          await f.realtime.setAuth(forged);
          const bad = await subscribed(f.channel("forged")).then(() => null, (error) => error);
          assert(bad instanceof Error && /InvalidJWTToken/.test(bad.message), String(bad));

          // A token that expires while joined closes the channel; a refresh before keeps it.
          let current = await accessToken(A, 3);
          const e = make(r1.origin, { token: () => Promise.resolve(current) });
          await e.realtime.setAuth(current);
          const states: string[] = [];
          const short = e.channel(`private-${A}`, { config: { private: true } });
          await new Promise<void>((resolve) =>
            short.subscribe((status) => {
              states.push(status);
              if (status === "SUBSCRIBED") resolve();
            })
          );
          await until(() => states.includes("CLOSED"), 15_000, "the expiry close");
          current = await accessToken(A, 600);
          const g = make(r1.origin, { token: () => Promise.resolve(current) });
          await g.realtime.setAuth(current);
          const kept: string[] = [];
          const fresh = g.channel(`private-${A}`, { config: { private: true } });
          await new Promise<void>((resolve) =>
            fresh.subscribe((status) => {
              kept.push(status);
              if (status === "SUBSCRIBED") resolve();
            })
          );
          current = await accessToken(A, 600);
          await g.realtime.setAuth(current); // re-verified on the access_token push
          await settle(500);
          assertEquals(kept, ["SUBSCRIBED"]);

          // The secret key is the service role: past the realtime.messages policies.
          const s = make(r2.origin, {
            key: GENERATED.secretKey,
            token: () => Promise.resolve(GENERATED.secretKey),
          });
          await s.realtime.setAuth(GENERATED.secretKey);
          await subscribed(s.channel(`private-${B}`, { config: { private: true } }));
        },
      );

      await t.step("the supabase_realtime publication opts tables in, live", async () => {
        const c = make(r1.origin);
        const got: Change[] = [];
        await subscribed(
          c.channel("published")
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "pubnotes" },
              (p) => got.push(p as unknown as Change),
            )
            .on(
              "postgres_changes",
              { event: "*", schema: "app", table: "things" },
              (p) => got.push(p as unknown as Change),
            ),
        );
        await env.app.unsafe("insert into pubnotes values (1, 'x')");
        await env.app.unsafe("insert into app.things values (1, 'a')");
        await env.app.unsafe("update app.things set label = 'b' where id = 1");
        await until(() => got.length === 3, 10_000, "the publication's changes");
        // In order within a table; two tables' bursts may interleave either way.
        assertEquals(got.map((p) => `${p.schema}.${p.table}:${p.eventType}`).sort(), [
          "app.things:INSERT",
          "app.things:UPDATE",
          "public.pubnotes:INSERT",
        ]);
        const things = got.filter((p) => p.table === "things");
        assertEquals(
          things[1].old,
          { id: 1, label: "a" },
          "REPLICA IDENTITY FULL, no RLS: the old row",
        );

        // Added while the app runs: picked up by the next read of the publication.
        await env.app.unsafe(
          "create table late (id int primary key); grant select on late to anon, authenticated; " +
            "alter publication supabase_realtime add table late",
        ).simple!();
        await settle(11_000);
        const late: Change[] = [];
        await subscribed(
          make(r2.origin).channel("late")
            .on(
              "postgres_changes",
              { event: "INSERT", schema: "public", table: "late" },
              (p) => late.push(p as unknown as Change),
            ),
        );
        await env.app.unsafe("insert into late values (7)");
        await until(() => late.length === 1, 10_000, "the late table's insert");
        assertEquals(late[0].new, { id: 7 });
      });

      await t.step("broadcast replay and replication_ready on a private channel", async () => {
        const tokenA = await accessToken(A);
        const a = make(r1.origin, { token: () => Promise.resolve(tokenA) });
        await a.realtime.setAuth(tokenA);
        const since = Date.now() - 500;
        const sender = a.channel(`private-${A}`, {
          config: { private: true, broadcast: { self: true, ack: true } },
        });
        await subscribed(sender);
        assertEquals(
          await sender.send({ type: "broadcast", event: "r1", payload: { n: 1 } }),
          "ok",
        );
        assertEquals(
          await sender.send({ type: "broadcast", event: "r2", payload: { n: 2 } }),
          "ok",
        );
        const b = make(r2.origin, { token: () => Promise.resolve(tokenA) });
        await b.realtime.setAuth(tokenA);
        const replayed: Array<{ event: string; payload: unknown; meta?: Record<string, unknown> }> =
          [];
        const system: Array<Record<string, unknown>> = [];
        const late = b.channel(`private-${A}`, {
          config: {
            private: true,
            broadcast: { replay: { since, limit: 10 }, replication_ready: true },
          },
        })
          .on("broadcast", { event: "*" }, (m) => replayed.push(m as never))
          .on("system", {}, (p) => system.push(p));
        await subscribed(late);
        await until(() => replayed.length >= 2, 10_000, "the replay");
        assertEquals(replayed.map((m) => m.event), ["r1", "r2"]);
        assert(replayed.every((m) => m.meta?.replayed === true && typeof m.meta?.id === "string"));
        await until(
          () => system.some((p) => p.message === "Replication connection established"),
          10_000,
          "replication_ready",
        );
      });

      await t.step(
        "denext's own client: broadcast and presence with supabase-js, across replicas",
        async () => {
          const url = `${r1.origin.replace("http", "ws")}/realtime/v1/websocket?vsn=2.0.0`;
          // Same origin (no Origin header here), so no key: the session cookie is the identity.
          const native = new RealtimeClient(
            url,
            (u) =>
              new WebSocket(
                u,
                { headers: { cookie: cookieB } } as never,
              ) as unknown as ClientSocket,
          );
          try {
            const room = native.acquire("native-room");
            const got: Array<{ event: string; payload: unknown }> = [];
            room.onBroadcast((m) => got.push(m));
            await until(
              () => room.status === "joined",
              10_000,
              "the native join",
            );
            assertEquals(await room.track({ who: "native" }), "ok");
            const s = make(r2.origin);
            const sGot: Array<{ payload: unknown }> = [];
            const sRoom = s.channel("native-room", {
              config: { presence: { key: "sb", enabled: true } },
            })
              .on("broadcast", { event: "*" }, (m) => sGot.push(m as never));
            await subscribed(sRoom);
            await until(
              () =>
                Object.values(sRoom.presenceState<{ who?: string }>()).some((list) =>
                  list.some((p) => p.who === "native")
                ),
              10_000,
              "supabase-js sees the native presence",
            );
            await sRoom.send({ type: "broadcast", event: "hi", payload: { from: "sb" } });
            await until(() => got.some((m) => m.event === "hi"), 10_000, "native receives");
            assertEquals(await room.send("yo", { from: "native" }), "ok");
            await until(() => sGot.length === 1, 10_000, "supabase-js receives");
            await sRoom.track({ who: "sb" });
            await until(() => "sb" in room.presenceState(), 10_000, "native sees supabase-js");
            native.release(room);
          } finally {
            native.close();
          }
        },
      );

      await t.step("a replica's clean stop announces its presences' leaves", async () => {
        const p = make(r1.origin);
        const q = make(r2.origin);
        const cp = p.channel("hall", { config: { presence: { key: "p", enabled: true } } });
        const cq = q.channel("hall", { config: { presence: { key: "q" } } });
        await Promise.all([subscribed(cp), subscribed(cq)]);
        await cq.track({ here: true });
        await until(() => Object.keys(cp.presenceState()).includes("q"), 10_000, "q tracked");
        await replicas.pop()!.stop();
        await until(() => !Object.keys(cp.presenceState()).includes("q"), 15_000, "q gone");
      });

      await t.step("a crashed replica's presences are swept by the survivors", async () => {
        const crashing = await replica(env.url);
        replicas.push(crashing);
        const p = make(r1.origin);
        const q = make(crashing.origin);
        const cp = p.channel("yard", { config: { presence: { key: "p", enabled: true } } });
        const cq = q.channel("yard", { config: { presence: { key: "q" } } });
        await Promise.all([subscribed(cp), subscribed(cq)]);
        await cq.track({ here: true });
        await until(() => Object.keys(cp.presenceState()).includes("q"), 10_000, "q tracked");
        await crashing.kill();
        replicas.pop();
        // No teardown ran: the survivor's sweep removes q once its instance stops heartbeating.
        await until(() => !Object.keys(cp.presenceState()).includes("q"), 60_000, "q swept");
      });
    } finally {
      for (const c of clients) await c.removeAllChannels().catch(() => {});
      for (const r of replicas) await r.stop();
      await env.drop();
    }
  },
});

// The same, read from the WAL (`source: "logical"`): needs a server with wal_level = logical
// (`DENEXT_TEST_POSTGRES_LOGICAL=1` says it has one; CI sets it after enabling it).
const LOGICAL = Deno.env.get("DENEXT_TEST_POSTGRES_LOGICAL") === "1";
const logicalReason = reason ?? (LOGICAL ? undefined : "set DENEXT_TEST_POSTGRES_LOGICAL=1");

Deno.test({
  name: `supabase-js realtime from logical decoding (pgoutput), two replicas${
    logicalReason ? ` (skipped: ${logicalReason})` : ""
  }`,
  ignore: logicalReason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    const clients: SupabaseClient[] = [];
    const replicas: Replica[] = [];
    const realtime = { ...REALTIME, source: "logical", logical: { pollMs: 20 } };
    try {
      await env.admin.unsafe(`alter role ${new URL(env.url).username} replication`);
      await migratePostgres(env.app, { migrations: rlsMigrations(), table: "backend_migrations" });
      await migratePostgres(env.app, {
        migrations: realtimeMigrations(realtime as never).filter((m) =>
          !m.name.startsWith("backend_realtime_t_")
        ),
        table: "backend_migrations",
      });
      await env.app.unsafe(DDL).simple!();
      replicas.push(await replica(env.url, realtime), await replica(env.url, realtime));
      const [r1, r2] = replicas;
      const tokenA = await accessToken(A);
      const a = createClient(r1.origin, ANON_KEY, { accessToken: () => Promise.resolve(tokenA) });
      const b = client(r2.origin);
      clients.push(a, b);
      await a.realtime.setAuth(tokenA);
      const seenA: Change[] = [];
      const seenB: Change[] = [];
      await subscribed(
        a.channel("wal-a").on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notes" },
          (p) => seenA.push(p as unknown as Change),
        ),
      );
      await subscribed(
        b.channel("wal-b")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "notes" },
            (p) => seenB.push(p as unknown as Change),
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "app", table: "things" },
            (p) => seenB.push(p as unknown as Change),
          ),
      );
      const before = Date.now();
      const [{ id }] = await env.app.unsafe<{ id: number }>(
        "insert into notes (owner, body) values ($1, 'from the WAL') returning id",
        [A],
      );
      // One statement at a time: a row inserted and deleted within one burst (16 ms) is never
      // shown — it cannot be checked against the subscriber's policies once it is gone.
      await until(() => seenA.length === 1, 10_000, "the insert");
      await env.app.unsafe("update notes set body = 'edited' where id = $1", [id]);
      await until(() => seenA.length === 2, 10_000, "the update");
      await env.app.unsafe("delete from notes where id = $1", [id]);
      await until(() => seenA.length === 3, 10_000, "the delete");
      assertEquals(seenA.map((p) => p.eventType), ["INSERT", "UPDATE", "DELETE"]);
      assertEquals(seenA[0].new.body, "from the WAL");
      assertEquals(seenA[2].old, { id: Number(id) });
      const committed = Date.parse(String(seenA[0].commit_timestamp));
      assert(committed >= before - 5_000 && committed <= Date.now(), "the WAL's commit time");
      // The publication's tables come through the same slot; REPLICA IDENTITY FULL: the old row.
      await env.app.unsafe("insert into app.things values (5, 'x')");
      await env.app.unsafe("update app.things set label = 'y' where id = 5");
      await until(() => seenB.length === 2, 10_000, "B's app.things changes");
      assertEquals(seenB[1].old, { id: 5, label: "x" });
      assertEquals(seenB.filter((p) => p.table === "notes"), [], "B's policies see no note");
      // No trigger runs on the write path.
      const triggers = await env.app.unsafe(
        "select tgname from pg_trigger where tgname like 'denext_realtime%' and tgenabled <> 'D'",
      );
      assertEquals(triggers.length, 0);
    } finally {
      for (const c of clients) await c.removeAllChannels().catch(() => {});
      for (const r of replicas) await r.stop();
      await env.drop();
    }
  },
});
