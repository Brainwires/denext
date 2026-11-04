// `useTableChanges` from `@denext/backend/client` against a fake WebSocket and the in-memory DOM:
// the subscribe frame (the realtime channel, a key naming the table, a fresh nonce and the
// filter), rows kept from `initial` as changes arrive, `stale` + `onResync` on a gap, a resync
// frame or a reconnect the server does not answer with `resumed` (one it does is replayed, not
// stale), a new `initial` clearing it, and a refused subscription. Plus
// `applyTableChanges` and `fromPostgresJs`'s `listen` mapping.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";
import { applyTableChanges, useTableChanges } from "../packages/backend/client.ts";
import type { TableChangesState } from "../packages/backend/client.ts";
import {
  decodeSubscriptionKey,
  qualifiedTableName,
  REALTIME_CHANNEL_ID,
} from "../packages/backend/src/realtime-shared.ts";
import { fromPostgresJs, type PostgresJsLike } from "../src/server/postgres.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

class FakeWS {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function withFakeSocket(body: () => void): void {
  const g = globalThis as Any;
  const priorWS = g.WebSocket;
  const priorLoc = g.location;
  FakeWS.instances = [];
  g.WebSocket = FakeWS;
  g.location = { protocol: "http:", host: "localhost", href: "http://localhost/" };
  try {
    body();
  } finally {
    g.WebSocket = priorWS;
    g.location = priorLoc;
  }
}

type Note = { id: number; body: string };

/**
 * Take over the 10-second resume waits the hook arms (every other timer runs as usual):
 * `fire()` runs those still armed, as if the wait ended; `armed` counts them; `restore()` undoes it.
 */
function resumeWaits(): { readonly armed: number; fire(): void; restore(): void } {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const waits = new Map<number, () => void>();
  let next = 1_000_000;
  globalThis.setTimeout = ((cb: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== 10_000) return set(cb, ms, ...rest);
    waits.set(++next, cb);
    return next;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined && waits.has(id)) waits.delete(id);
    else clear(id);
  }) as typeof clearTimeout;
  return {
    get armed() {
      return waits.size;
    },
    fire() {
      const due = [...waits.values()];
      waits.clear();
      for (const cb of due) cb();
    },
    restore() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

Deno.test("useTableChanges: subscribes with a fresh key and keeps rows from initial", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    let state!: TableChangesState<Note>;
    let setInitial!: (rows: Note[]) => void;
    const resyncs: number[] = [];
    const batches: number[] = [];
    function App() {
      const [initial, set] = useState<Note[]>([{ id: 1, body: "one" }]);
      setInitial = set;
      state = useTableChanges<Note>("notes", {
        initial,
        filter: { list: 3 },
        onResync: () => resyncs.push(1),
        onChange: (changes) => batches.push(changes.length),
      });
      return h("span", null, state.rows.map((r) => r.body).join(","));
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    assertEquals(container.textContent, "one");
    assertEquals(state.status, "idle");
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const sent = JSON.parse(ws.sent.find((s) => s.includes("channel-subscribe"))!);
    assertEquals(sent.channelId, REALTIME_CHANNEL_ID);
    const key = decodeSubscriptionKey(sent.key)!;
    assertEquals([key.table, key.filter], ["notes", { column: "list", value: "3" }]);
    assert(key.nonce.length >= 22);

    ws.deliver({ type: "channel-ready", subId: sent.subId });
    flushSync();
    assertEquals(state.status, "subscribed");
    const frame = (seq: number, value: unknown) =>
      ws.deliver({ type: "channel", subId: sent.subId, seq, value });
    frame(1, {
      seq: 1,
      changes: [
        { op: "insert", key: "2", row: { id: 2, body: "two" } },
        { op: "update", key: "1", row: { id: 1, body: "uno" } },
      ],
    });
    flushSync();
    assertEquals(container.textContent, "uno,two");
    assertEquals([state.status, state.stale, batches], ["live", false, [2]]);
    frame(2, { seq: 2, changes: [{ op: "delete", key: "2" }] });
    flushSync();
    assertEquals(container.textContent, "uno");

    // A gap in the sequence: changes were lost.
    frame(3, { seq: 4, changes: [{ op: "insert", key: "5", row: { id: 5, body: "five" } }] });
    flushSync();
    assertEquals([state.stale, resyncs.length], [true, 1]);
    assertEquals(container.textContent, "uno,five");
    // The app re-reads and passes the rows as `initial`: stale clears.
    setInitial([{ id: 1, body: "uno" }, { id: 5, body: "five" }, { id: 6, body: "six" }]);
    flushSync();
    assertEquals([state.stale, container.textContent], [false, "uno,five,six"]);
    // A resync frame marks it stale.
    frame(4, { seq: 5, resync: true });
    flushSync();
    assertEquals(resyncs.length, 2);
    setInitial([{ id: 1, body: "uno" }]);
    flushSync();
    // A second ack (a reconnect) answered by `resumed`: the server replays what was missed, so it
    // is not stale, and the replayed changes (numbered on) apply.
    const waits = resumeWaits();
    try {
      ws.deliver({ type: "channel-ready", subId: sent.subId });
      flushSync();
      assertEquals(waits.armed, 1, "the re-subscribe waits for the server's answer");
      frame(5, { seq: 6, resumed: true });
      frame(6, { seq: 7, changes: [{ op: "insert", key: "7", row: { id: 7, body: "seven" } }] });
      flushSync();
      assertEquals(waits.armed, 0, "answered");
      assertEquals([state.stale, resyncs.length, container.textContent], [false, 2, "uno,seven"]);
      // A reconnect the server does not answer (it lost the subscription): stale once the wait
      // ends, not before.
      ws.deliver({ type: "channel-ready", subId: sent.subId });
      flushSync();
      assertEquals([waits.armed, state.stale], [1, false]);
      waits.fire();
      flushSync();
      assertEquals([state.stale, resyncs.length], [true, 3]);
    } finally {
      waits.restore();
    }
    // Refused: the error is reported.
    ws.deliver({
      type: "error",
      code: "denied",
      reason: "channel access revoked",
      subId: sent.subId,
    });
    flushSync();
    assertEquals([state.status, state.error?.code], ["error", "denied"]);
    root.unmount();
    assert(ws.sent.some((s) => s.includes("channel-unsubscribe")));
  });
});

Deno.test("useTableChanges: a filter too long for a key is an error, not a subscription", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    let state!: TableChangesState<Note>;
    function App() {
      state = useTableChanges<Note>("notes", { filter: { tag: "v".repeat(200) } });
      return h("span", null, state.status);
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    assertEquals([state.status, state.error?.code], ["error", "bad-filter"]);
    const opened = FakeWS.instances.at(-1);
    assert(!opened || !opened.sent.some((s) => s.includes("channel-subscribe")));
    root.unmount();
  });
});

Deno.test("applyTableChanges: upserts, renames and deletes by the key column", () => {
  const rows = [{ sku: "a", n: 1 }, { sku: "b", n: 2 }];
  const out = applyTableChanges(rows, [
    { op: "update", key: "c", oldKey: "a", row: { sku: "c", n: 1 } },
    { op: "delete", key: "b" },
    { op: "insert", key: "d", truncated: true },
    { op: "insert", key: "e", row: { sku: "e", n: 5 } },
  ], "sku");
  assertEquals(out, [{ sku: "c", n: 1 }, { sku: "e", n: 5 }]);
  assertEquals(rows.length, 2, "the input is not modified");
});

Deno.test("applyTableChanges: a truncate empties the rows; later changes apply after it", () => {
  const out = applyTableChanges([{ id: 1 }, { id: 2 }], [
    { op: "truncate" },
    { op: "insert", key: "3", row: { id: 3 } },
  ]);
  assertEquals(out, [{ id: 3 }]);
});

Deno.test("useTableChanges: events keeps only the kinds of change asked for; operator filters key", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    let state!: TableChangesState<Note>;
    const batches: string[][] = [];
    const initial = [{ id: 1, body: "one" }];
    function App() {
      state = useTableChanges<Note>("notes", {
        initial,
        filter: "id=gte.1",
        events: ["insert", "truncate"],
        onChange: (changes) => batches.push(changes.map((c) => c.op)),
      });
      return h("span", null, state.rows.map((r) => r.body).join(","));
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const sent = JSON.parse(ws.sent.find((s) => s.includes("channel-subscribe"))!);
    assertEquals(decodeSubscriptionKey(sent.key)!.filter, { column: "id", op: "gte", value: "1" });
    ws.deliver({ type: "channel-ready", subId: sent.subId });
    flushSync();
    const frame = (seq: number, value: unknown) =>
      ws.deliver({ type: "channel", subId: sent.subId, seq, value });
    frame(1, {
      seq: 1,
      changes: [
        { op: "update", key: "1", row: { id: 1, body: "uno" } },
        { op: "insert", key: "2", row: { id: 2, body: "two" } },
      ],
    });
    flushSync();
    assertEquals(container.textContent, "one,two", "the update was not asked for");
    frame(2, { seq: 2, changes: [{ op: "delete", key: "1" }] });
    flushSync();
    assertEquals(container.textContent, "one,two");
    frame(3, { seq: 3, changes: [{ op: "truncate" }] });
    flushSync();
    assertEquals(container.textContent, "");
    assertEquals(batches, [["insert"], ["truncate"]]);
    root.unmount();
  });
});

Deno.test("fromPostgresJs maps listen() (and leaves it out when the driver has none)", async () => {
  const calls: unknown[] = [];
  const pg = Object.assign(() => Promise.resolve([]), {
    unsafe: () => Promise.resolve([]),
    begin: () => Promise.resolve(),
    listen: (channel: string, fn: (p: string) => void, onlisten?: () => void) => {
      calls.push(channel);
      fn("payload");
      onlisten?.();
      return Promise.resolve({
        state: {},
        unlisten: () => Promise.resolve(calls.push("unlisten")),
      });
    },
  }) as unknown as PostgresJsLike;
  const client = fromPostgresJs(pg);
  const got: string[] = [];
  let listened = 0;
  const listener = await client.listen!("ch", (p) => got.push(p), () => listened++);
  assertEquals([calls, got, listened], [["ch"], ["payload"], 1]);
  await listener.unlisten();
  assertEquals(calls, ["ch", "unlisten"]);
  const without = fromPostgresJs(Object.assign(() => Promise.resolve([]), {
    unsafe: () => Promise.resolve([]),
    begin: () => Promise.resolve(),
  }) as unknown as PostgresJsLike);
  assertEquals(without.listen, undefined);
});

Deno.test("fromPostgresJs maps reserve(): queries on the reserved connection, release returns it", async () => {
  const calls: string[] = [];
  const reserved = Object.assign(() => Promise.resolve([]), {
    unsafe: (text: string) => {
      calls.push(`reserved: ${text}`);
      return Promise.resolve([{ owner: true }]);
    },
    begin: () => Promise.resolve(),
    release: () => void calls.push("release"),
  });
  const pg = Object.assign(() => Promise.resolve([]), {
    unsafe: () => Promise.resolve([]),
    begin: () => Promise.resolve(),
    reserve: () => {
      calls.push("reserve");
      return Promise.resolve(reserved);
    },
    end: () => Promise.resolve(void calls.push("end")),
  }) as unknown as PostgresJsLike;
  const conn = await fromPostgresJs(pg).reserve!();
  assertEquals(await conn.unsafe("select 1"), [{ owner: true }]);
  await conn.release();
  await conn.close();
  assertEquals(
    calls,
    ["reserve", "reserved: select 1", "release", "release"],
    "never ends the pool",
  );
  const without = fromPostgresJs(Object.assign(() => Promise.resolve([]), {
    unsafe: () => Promise.resolve([]),
    begin: () => Promise.resolve(),
  }) as unknown as PostgresJsLike);
  assertEquals(without.reserve, undefined);
});

Deno.test("useTableChanges: `schema` subscribes `schema.table`; keys accept it, not deeper", () => {
  assertEquals(qualifiedTableName("notes"), "notes");
  assertEquals(qualifiedTableName("notes", "public"), "notes");
  assertEquals(qualifiedTableName("things", "app"), "app.things");
  const nonce = "abcdefghijklmnopqrstuv";
  assertEquals(decodeSubscriptionKey(`app.things|${nonce}`), { table: "app.things", nonce });
  assertEquals(decodeSubscriptionKey(`a.b.c|${nonce}`), null);
  assertEquals(decodeSubscriptionKey(`.things|${nonce}`), null);
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    function App() {
      useTableChanges("things", { schema: "app" });
      useTableChanges("notes", { schema: "public" });
      return h("span", null, "x");
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const tables = ws.sent.filter((s) => s.includes("channel-subscribe")).map((s) =>
      decodeSubscriptionKey(JSON.parse(s).key)!.table
    );
    assertEquals(tables.sort(), ["app.things", "notes"]);
    root.unmount();
  });
});
