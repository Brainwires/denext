// `useTableChanges` from `@denext/backend/client` against a fake WebSocket and the in-memory DOM:
// the subscribe frame (the realtime channel, a key naming the table, a fresh nonce and the
// filter), rows kept from `initial` as changes arrive, `stale` + `onResync` on a gap, a resync
// frame or a reconnect, a new `initial` clearing it, and a refused subscription. Plus
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
    // A resync frame, and a second ack (a reconnect), each mark it stale.
    frame(4, { seq: 5, resync: true });
    flushSync();
    assertEquals(resyncs.length, 2);
    ws.deliver({ type: "channel-ready", subId: sent.subId });
    flushSync();
    assertEquals([state.stale, resyncs.length], [true, 3]);
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
