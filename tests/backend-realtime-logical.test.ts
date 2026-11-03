// `realtime({ source: "logical" })`: the pgoutput decoder over hand-built protocol-v1 messages
// (begin, relation, insert / update / delete with and without old tuples, truncate, unchanged
// TOAST and NULL cells, key respelling, old-row typing), `byteaOf`, and the slot reader against a
// fake reserved connection — start, read, emit, refusals, a failed read reopening the slot with a
// resync, and stop dropping it. The real thing runs in
// tests/backend-supabase-realtime-integration.test.ts against Postgres with wal_level = logical.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  byteaOf,
  keyText,
  type LogicalEvent,
  LogicalSource,
  LogicalUnsupportedError,
  PgoutputDecoder,
} from "../packages/backend/src/realtime-logical.ts";
import type { ResolvedTable } from "../packages/backend/src/realtime-sql.ts";
import type { SqlClient, SqlQuery } from "../src/server/postgres.ts";

import { begin, del, insert, Msg, relation, truncate, update } from "./helpers/pgoutput.ts";

const table = (name: string, key: string, old: "key" | "full" = "key", schema?: string) =>
  ({
    name,
    table: name.split(".").at(-1)!,
    events: ["insert", "update", "delete", "truncate"],
    key,
    ...(schema ? { schema } : {}),
    qualified: `"${name}"`,
    old,
  }) as ResolvedTable;

const NOTES = table("notes", "id");
const THINGS = table("app.things", "at", "full", "app");

function decoder() {
  const events: LogicalEvent[] = [];
  const d = new PgoutputDecoder(
    (schema, name) =>
      schema === "public" && name === "notes"
        ? NOTES
        : schema === "app" && name === "things"
        ? THINGS
        : null,
    (event) => events.push(event),
  );
  return { d, events };
}

Deno.test("pgoutput decoder: inserts, updates, deletes and truncates as keys-only events", () => {
  const { d, events } = decoder();
  const at = Date.UTC(2026, 9, 13, 12, 0, 0);
  d.decode(begin(at));
  d.decode(relation(100, "public", "notes", [["id", 20], ["body", 25]]));
  d.decode(relation(200, "app", "things", [
    ["at", 1114],
    ["ok", 16],
    ["n", 23],
    ["doc", 3802],
    [
      "tz",
      1184,
    ],
    ["label", 25],
    ["big", 1700],
  ]));
  d.decode(relation(300, "public", "other", [["id", 23]]));
  d.decode(insert(100, ["1", "hello"]));
  d.decode(update(100, ["2", "moved"], { kind: "K", cells: ["1", null] }));
  d.decode(update(100, ["2", undefined])); // unchanged TOAST body, no old tuple
  d.decode(del(100, "K", ["2", null]));
  d.decode(insert(300, ["9"])); // not a realtime table
  d.decode(insert(999, ["9"])); // unknown relation
  d.decode(new Msg().char("C").u8(0).i64(1n).i64(2n).i64(3n).done()); // commit: nothing
  d.decode(new Msg().char("Y").i32(1).str("x").str("y").done()); // type: nothing
  assertEquals(events, [
    { table: "notes", op: "insert", key: "1", ts: at },
    { table: "notes", op: "update", key: "2", oldKey: "1", ts: at },
    { table: "notes", op: "update", key: "2", ts: at },
    { table: "notes", op: "delete", key: "2", ts: at },
  ]);

  // A full old row (REPLICA IDENTITY FULL) on an `old: "full"` table, typed as to_jsonb types it.
  events.length = 0;
  const old = ["2026-01-02 03:04:05.5", "t", "42", '{"a":1}', "2026-01-02 03:04:05+00", null, "x"];
  d.decode(
    update(200, ["2026-01-02 03:04:06", "f", "43", "[]", "2026-01-02 03:04:05+00", "l", "1.5"], {
      kind: "O",
      cells: [...old.slice(0, 6), undefined],
    }),
  );
  d.decode(del(200, "O", old));
  assertEquals(events[0], {
    table: "app.things",
    op: "update",
    key: "2026-01-02T03:04:06",
    oldKey: "2026-01-02T03:04:05.5",
    ts: at,
    old: {
      at: "2026-01-02T03:04:05.5",
      ok: true,
      n: 42,
      doc: { a: 1 },
      tz: "2026-01-02T03:04:05+00:00",
      label: null,
    },
  });
  assertEquals(events[1].op, "delete");
  assertEquals(events[1].old?.big, "x", "a number that does not parse stays text");

  // A delete without the key (REPLICA IDENTITY NOTHING-like), an update whose new tuple lacks it.
  events.length = 0;
  d.decode(del(100, "K", [null, null]));
  d.decode(update(100, [null, "x"]));
  assertEquals(events, [{ table: "notes", op: "resync" }, { table: "notes", op: "resync" }]);

  // Truncate: one event per realtime table among the relations.
  events.length = 0;
  d.decode(truncate([100, 300, 200, 999]));
  assertEquals(events, [
    { table: "notes", op: "truncate", ts: at },
    { table: "app.things", op: "truncate", ts: at },
  ]);

  // reset(): relations are forgotten (a new slot sends them again); no commit time yet.
  d.reset();
  events.length = 0;
  d.decode(insert(100, ["5", "x"]));
  assertEquals(events, []);
  d.decode(relation(100, "public", "notes", [["id", 20], ["body", 25]]));
  d.decode(insert(100, ["5", "x"]));
  d.decode(truncate([100]));
  assertEquals(events, [
    { table: "notes", op: "insert", key: "5" },
    { table: "notes", op: "truncate" },
  ]);
});

Deno.test("pgoutput decoder: an old row with bad JSON stays text; keyText respells types", () => {
  const { d, events } = decoder();
  d.decode(relation(200, "app", "things", [["at", 1114], ["doc", 114]]));
  d.decode(del(200, "O", ["2026-01-01 00:00:00", "{not json"]));
  assertEquals(events[0].old, { at: "2026-01-01T00:00:00", doc: "{not json" });
  assertEquals(keyText("t", 16), "true");
  assertEquals(keyText("f", 16), "false");
  assertEquals(keyText("2026-01-02 03:04:05", 1114), "2026-01-02T03:04:05");
  assertEquals(keyText("2026-01-02 03:04:05.25+00", 1184), "2026-01-02T03:04:05.25");
  assertEquals(keyText("2026-01-02 03:04:05+00:00", 1184), "2026-01-02T03:04:05");
  assertEquals(keyText("abc", 25), "abc");
});

Deno.test("byteaOf: bytes, Postgres hex text, other views; anything else throws", () => {
  const bytes = new Uint8Array([1, 2, 255]);
  assertEquals(byteaOf(bytes), bytes);
  assertEquals([...byteaOf("\\x0102ff")], [1, 2, 255]);
  assertEquals([...byteaOf(new DataView(bytes.buffer, 1, 2))], [2, 255]);
  assertThrows(() => byteaOf("plain"), TypeError);
  assertThrows(() => byteaOf(42), TypeError);
});

// ── the slot reader ──────────────────────────────────────────────────────────

interface FakeConn {
  statements: string[];
  released: number;
}

/** A client whose reserve() hands out a connection that answers the slot statements. */
function slotClient(options: {
  walLevel?: string;
  batches?: Uint8Array[][];
  failRead?: () => boolean;
  failCreate?: boolean;
  noReserve?: boolean;
}) {
  const conns: FakeConn[] = [];
  const batches = options.batches ?? [];
  const query = <T>(rows: unknown[] | (() => unknown[])): SqlQuery<T> => {
    const p = Promise.resolve().then(() => typeof rows === "function" ? rows() : rows) as Promise<
      T[]
    >;
    p.catch(() => {});
    return { then: (ok, fail) => p.then(ok, fail), simple: () => p };
  };
  const reserve = () => {
    const conn: FakeConn = { statements: [], released: 0 };
    conns.push(conn);
    const client = {
      unsafe: <T>(text: string) => {
        conn.statements.push(text);
        if (text === "show wal_level") {
          return query<T>([{ wal_level: options.walLevel ?? "logical" }]);
        }
        if (text.includes("pg_create_logical_replication_slot") && options.failCreate) {
          return query<T>(() => {
            throw new Error("permission denied to create replication slot");
          });
        }
        if (text.includes("pg_logical_slot_get_binary_changes")) {
          return query<T>(() => {
            if (options.failRead?.()) throw new Error("terminating connection");
            return (batches.shift() ?? []).map((data) => ({ data }));
          });
        }
        return query<T>([]);
      },
      release: () => void conn.released++,
    };
    return Promise.resolve(client as unknown as SqlClient & { release(): void });
  };
  const sql = { ...(options.noReserve ? {} : { reserve }) } as unknown as SqlClient;
  return { sql, conns };
}

function source(sql: SqlClient, emit: (e: LogicalEvent) => void, resync = () => {}) {
  return new LogicalSource({
    client: () => sql,
    publications: () => ["denext_realtime", "supabase_realtime"],
    tableOf: (schema, name) => (schema === "public" && name === "notes" ? NOTES : null),
    emit,
    resync,
    pollMs: 5,
    maxChanges: 2,
  });
}

// The deadline only bounds a failure (a loaded coverage run is slow), so it is generous.
const until = async (done: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

Deno.test({
  name: "logical source: a temporary slot, read in batches, decoded, dropped on stop",
  async fn() {
    const rel = relation(100, "public", "notes", [["id", 20], ["body", 25]]);
    const { sql, conns } = slotClient({
      batches: [[rel, insert(100, ["1", "a"])], [insert(100, ["2", "b"])]],
    });
    const events: LogicalEvent[] = [];
    const s = source(sql, (e) => events.push(e));
    await s.start();
    await until(() => events.length === 2);
    assertEquals(events.map((e) => e.key), ["1", "2"]);
    assert(s.reads >= 2, "a full batch is followed at once, then polled");
    await s.stop();
    const [conn] = conns;
    assert(conn.statements.includes("set TimeZone = 'UTC'"));
    assert(conn.statements.some((t) => t.includes("pg_create_logical_replication_slot")));
    assert(conn.statements.some((t) => t.includes("pg_drop_replication_slot")));
    assertEquals(conn.released, 1);
    await s.stop(); // twice: nothing more
  },
});

Deno.test({
  name: "logical source: refusals — no reserve(), wal_level, a slot that cannot be made",
  async fn() {
    await assertRejects(
      () => source(slotClient({ noReserve: true }).sql, () => {}).start(),
      LogicalUnsupportedError,
      "no reserve()",
    );
    const replica = slotClient({ walLevel: "replica" });
    await assertRejects(
      () => source(replica.sql, () => {}).start(),
      LogicalUnsupportedError,
      "wal_level is replica",
    );
    assertEquals(replica.conns[0].released, 1, "the connection goes back");
    const denied = slotClient({ failCreate: true });
    await assertRejects(
      () => source(denied.sql, () => {}).start(),
      LogicalUnsupportedError,
      "permission denied",
    );
    assertEquals(denied.conns[0].released, 1);
  },
});

Deno.test({
  name: "logical source: a failed read reopens the slot on a new connection and resyncs",
  async fn() {
    let fail = 1;
    const { sql, conns } = slotClient({ failRead: () => fail-- > 0 });
    let resyncs = 0;
    const errors = console.error;
    console.error = () => {};
    try {
      const s = source(sql, () => {}, () => resyncs++);
      await s.start();
      await until(() => resyncs === 1);
      assertEquals(conns.length, 2, "a new connection, a new slot");
      assertEquals(conns[0].released, 1);
      await s.stop();
      assertEquals(conns[1].released, 1);
    } finally {
      console.error = errors;
    }
  },
});
