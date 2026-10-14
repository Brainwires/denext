// denext's own realtime client (`RealtimeClient`, `SharedChannel`) and its hooks
// (`useBroadcast`, `useRealtimePresence`) against the REAL hub of the backend's Supabase Realtime
// endpoint, over an in-memory socket pair (strings and binary frames both ways): joins, shared
// channels, ack'd sends with echo suppression, binary payloads, presence (diffs buffered before the
// state), a dropped socket failing pending pushes then reconnecting and re-tracking, refused
// private joins, `phx_close`, and the hooks rendered with denext's reconciler.

import { assert, assertEquals } from "@std/assert";
import { h as jsx } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  type ClientSocket,
  RealtimeClient,
  realtimeClient,
  SharedChannel,
  useBroadcast,
  useRealtimePresence,
} from "../packages/backend/client.ts";
import type { BroadcastState, RealtimePresenceResult } from "../packages/backend/client.ts";
import { createHub, type RealtimeHub } from "../packages/backend/src/realtime-socket.ts";
import type {
  BusHandlers,
  PresenceEntry,
  RealtimeBus,
} from "../packages/backend/src/realtime-bus.ts";
import {
  type ChannelPermissions,
  PUBLIC_PERMISSIONS,
} from "../packages/backend/src/realtime-authz.ts";
import type { RealtimeEngine } from "../packages/backend/src/realtime.ts";
import {
  ANON_SOCKET_IDENTITY,
  type SocketIdentity,
} from "../packages/backend/src/realtime-identity.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
const user = (sub: string): SocketIdentity => ({
  scope: { role: "authenticated", claims: JSON.stringify({ sub, role: "authenticated" }) },
});

/** A bus that delivers to this hub at once (private broadcasts are stored with an id). */
function memoryBus(handlers: BusHandlers): RealtimeBus {
  const rows = new Map<string, PresenceEntry[]>();
  const id = (topic: string, pr: boolean) => `${pr}:${topic}`;
  return {
    start: () => Promise.resolve(),
    broadcast(message) {
      handlers.broadcast(message.private ? { ...message, id: crypto.randomUUID() } : message);
      return Promise.resolve();
    },
    track(topic, pr, entry, replaces) {
      const list = (rows.get(id(topic, pr)) ?? []).filter((e) =>
        !replaces.some((r) => r.ref === e.ref)
      );
      rows.set(id(topic, pr), [...list, entry]);
      handlers.presence({ topic, private: pr, joins: [entry], leaves: replaces });
      return Promise.resolve();
    },
    untrack(topic, pr, entries) {
      rows.set(id(topic, pr), (rows.get(id(topic, pr)) ?? []).filter((e) => !entries.includes(e)));
      if (entries.length > 0) handlers.presence({ topic, private: pr, joins: [], leaves: entries });
      return Promise.resolve();
    },
    presenceState: (topic, pr) => Promise.resolve(rows.get(id(topic, pr)) ?? []),
    replay: () => Promise.resolve([]),
    stop: () => Promise.resolve(),
  };
}

/** A hub with no tables (broadcast and presence only), and adjustable private permissions. */
function hub(): { hub: RealtimeHub; perms: { value: ChannelPermissions } } {
  const perms = { value: PUBLIC_PERMISSIONS };
  const engine = {
    config: { tables: new Map() },
    start: () => Promise.resolve(),
    columns: () => Promise.resolve([]),
    bind: () => Promise.resolve(null),
  } as unknown as RealtimeEngine;
  return {
    hub: createHub({
      engine,
      bus: memoryBus,
      permissions: () => Promise.resolve(perms.value),
    }),
    perms,
  };
}

/** An in-memory socket pair: the client's end, wired to `hub.attach`. */
class Bridge implements ClientSocket {
  binaryType = "blob";
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Hold server → client frames (a stalled network). */
  paused = false;
  #server!: { message(data: string | ArrayBuffer | Uint8Array): void; close(): void };

  constructor(readonly hub: RealtimeHub, readonly identity: SocketIdentity) {
    setTimeout(() => {
      const server = {
        readyState: 0,
        bufferedAmount: 0,
        send: (data: string | Uint8Array) => {
          if (this.paused || this.readyState !== 1) return;
          const out = typeof data === "string"
            ? data
            : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          queueMicrotask(() => this.onmessage?.({ data: out }));
        },
        close: () => this.drop(),
      };
      Object.defineProperty(server, "readyState", { get: () => this.readyState });
      this.#server = hub.attach(server, "2.0.0", {}, identity, null);
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string | ArrayBufferLike | Uint8Array): void {
    this.#server.message(
      typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer),
    );
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#server?.close();
  }

  /** The server side went away. */
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#server?.close();
    this.onclose?.({});
  }
}

function client(h: RealtimeHub, identity: SocketIdentity = ANON_SOCKET_IDENTITY) {
  const sockets: Bridge[] = [];
  const c = new RealtimeClient("ws://app.test/realtime/v1/websocket?vsn=2.0.0", () => {
    const socket = new Bridge(h, identity);
    sockets.push(socket);
    return socket;
  });
  return { c, sockets };
}

// The deadline only bounds a failure (a loaded coverage run is slow), so it is generous.
const until = async (done: () => boolean, ms = 15_000, what = "condition") => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

Deno.test({
  name: "native client: shared channels, ack'd broadcasts, echoes, binary payloads, release",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { hub: h } = hub();
    const one = client(h);
    const two = client(h);
    try {
      const a = one.c.acquire("room");
      const again = one.c.acquire("room");
      assertEquals([a === again, a.refs], [true, 2]);
      const statuses: string[] = [];
      a.onStatus((s) => statuses.push(s));
      const b = two.c.acquire("room", { self: true });
      await until(() => a.status === "joined" && b.status === "joined", 15_000, "the joins");
      const atA: unknown[] = [];
      const atB: unknown[] = [];
      a.onBroadcast((m) => atA.push(m));
      const offB = b.onBroadcast((m) => atB.push(m));

      assertEquals(await a.send("hi", { n: 1 }), "ok");
      await until(() => atB.length === 1);
      assertEquals(atB[0], { event: "hi", payload: { n: 1 } });
      // Another sender's identical message still reaches A (only its own echo is dropped).
      await b.send("hi", { n: 1 });
      await until(() => atA.length >= 1 && atB.length === 2, 15_000, "b's own echo (self: true)");

      // Binary.
      await b.send("bin", new Uint8Array([7, 8, 9]));
      const events = () => atA.map((m) => (m as { event: string }).event);
      await until(() => events().includes("bin"), 15_000, "the binary broadcast");
      // A's socket is ordered: had its own "hi" been echoed, it would have arrived first.
      assertEquals(events(), ["hi", "bin"], "self: false — its own echo is dropped");
      assertEquals([...((atA[1] as { payload: Uint8Array }).payload)], [7, 8, 9]);
      offB();

      // Release: the last holder leaves; an idle client closes its socket.
      one.c.release(again);
      assertEquals(a.status, "joined", "still held once");
      one.c.release(a);
      assertEquals(a.status, "closed");
      assertEquals(one.sockets[0].readyState, 3);
      assertEquals(await a.send("late", 1), "error", "not joined");
      assert(statuses.includes("joined") && statuses.at(-1) === "closed");
    } finally {
      one.c.close();
      two.c.close();
      await h.stop();
    }
  },
});

Deno.test({
  name: "native client: presence with supabase-shaped state; diffs before the state are buffered",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { hub: h } = hub();
    const one = client(h);
    const two = client(h);
    try {
      const a = one.c.acquire("lobby", { presenceKey: "alice" });
      const b = two.c.acquire("lobby", { presenceKey: "bob" });
      const seen: Array<Record<string, unknown>> = [];
      b.onPresence((state) => seen.push(state));
      assertEquals(await a.track({ status: "online" }), "error", "not joined yet: kept for later");
      await until(() => a.status === "joined" && b.status === "joined");
      await until(() => "alice" in b.presenceState(), 15_000, "the deferred track");
      const [alice] = b.presenceState<{ status: string }>().alice;
      assertEquals(alice.status, "online");
      assert(typeof alice.presence_ref === "string");
      assertEquals(await a.track({ status: "away" }), "ok");
      await until(() => b.presenceState<{ status: string }>().alice?.[0]?.status === "away");
      assertEquals(b.presenceState().alice.length, 1, "re-tracking replaces");
      assertEquals(await a.untrack(), "ok");
      await until(() => !("alice" in b.presenceState()));
      // A late listener gets the current state at once.
      const late: unknown[] = [];
      b.onPresence((state) => late.push(state));
      assertEquals(late.length, 1);
      assert(seen.length >= 3);
    } finally {
      one.c.close();
      two.c.close();
      await h.stop();
    }
  },
});

Deno.test("shared channel: buffered diffs, phx_close, system errors, sends while not joined", async () => {
  let ref = 0;
  const stub = {
    nextRef: () => String(++ref),
    push: () => Promise.resolve({ status: "ok" as const, response: {} }),
  } as unknown as RealtimeClient;
  const channel = new SharedChannel(stub, "t", {});
  assertEquals(await channel.track({ a: 1 }), "error");
  assertEquals(await channel.untrack(), "error");
  channel.join();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(channel.status, "joined");
  const states: Array<Record<string, unknown>> = [];
  channel.onPresence((s) => states.push(s));
  const metas = (ref: string, extra: Record<string, unknown> = {}) => ({
    metas: [{ phx_ref: ref, ...extra }],
  });
  // A diff before the state: held, then applied on top of it.
  channel.receive({
    joinRef: "1",
    ref: null,
    topic: "realtime:t",
    event: "presence_diff",
    payload: { joins: { k2: metas("r2") }, leaves: { k1: metas("r1") } },
  });
  assertEquals(states, []);
  channel.receive({
    joinRef: "1",
    ref: null,
    topic: "realtime:t",
    event: "presence_state",
    payload: { k1: metas("r1", { x: 1 }) },
  });
  assertEquals(Object.keys(channel.presenceState()), ["k2"]);
  channel.receive({
    joinRef: "1",
    ref: null,
    topic: "realtime:t",
    event: "presence_diff",
    payload: { joins: { k2: metas("r3") }, leaves: {} },
  });
  assertEquals(channel.presenceState().k2.map((p) => p.presence_ref), ["r2", "r3"]);
  // A system error, then the server closing the channel.
  channel.receive({
    joinRef: "1",
    ref: null,
    topic: "realtime:t",
    event: "system",
    payload: { extension: "system", status: "error", message: "Token has expired" },
  });
  assertEquals([channel.status, channel.reason], ["error", "Token has expired"]);
  channel.receive({
    joinRef: "9",
    ref: null,
    topic: "realtime:t",
    event: "phx_close",
    payload: {},
  });
  assertEquals(channel.status, "error", "another join's close is not ours");
  channel.receive({
    joinRef: "1",
    ref: null,
    topic: "realtime:t",
    event: "phx_close",
    payload: {},
  });
  assertEquals(channel.status, "closed");
  channel.disconnected();
  channel.receive({ joinRef: "1", ref: null, topic: "realtime:t", event: "other", payload: null });
});

Deno.test({
  name:
    "native client: a refused private join; a dropped socket fails pushes, reconnects, re-tracks",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { hub: h, perms } = hub();
    perms.value = {
      readBroadcast: false,
      readPresence: false,
      writeBroadcast: false,
      writePresence: false,
    };
    const one = client(h, user(A));
    const watcher = client(h);
    try {
      const refused = one.c.acquire("secret", { private: true });
      await until(() => refused.status === "error");
      assert(refused.reason?.includes("Unauthorized"), refused.reason);
      perms.value = PUBLIC_PERMISSIONS;

      const room = one.c.acquire("room", { presenceKey: "me" });
      const eye = watcher.c.acquire("room");
      await until(() => room.status === "joined" && eye.status === "joined");
      await room.track({ here: true });
      await until(() => "me" in eye.presenceState());

      // The network stalls, then the socket drops: the pending push fails at once.
      one.sockets[0].paused = true;
      const pending = room.send("lost", 1);
      one.sockets[0].drop();
      assertEquals(await pending, "error");
      assertEquals(room.status, "joining");
      await until(() => !("me" in eye.presenceState()), 15_000, "the leave");
      // Reconnected (backoff) and rejoined, presence tracked again.
      await until(() => one.sockets.length === 2 && room.status === "joined", 5_000, "rejoin");
      await until(() => "me" in eye.presenceState(), 15_000, "re-tracked");
    } finally {
      one.c.close();
      watcher.c.close();
      await h.stop();
    }
  },
});

Deno.test("realtimeClient(): one per page, replaceable", () => {
  const mine = new RealtimeClient("ws://x/realtime/v1/websocket", () => {
    throw new Error("not opened");
  });
  assertEquals(realtimeClient(mine), mine);
  assertEquals(realtimeClient(), mine);
  const fresh = realtimeClient(null);
  assert(fresh !== mine && fresh instanceof RealtimeClient);
  assertEquals(realtimeClient(), fresh);
  realtimeClient(null);
});

Deno.test({
  name: "useBroadcast / useRealtimePresence: status, messages, send, peers, untrack, unmount",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { hub: h } = hub();
    const page = client(h);
    const other = client(h);
    realtimeClient(page.c);
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    let broadcast!: BroadcastState<{ n: number }>;
    let presence!: RealtimePresenceResult<{ mood: string }>;
    let setMood!: (mood: string | undefined) => void;
    const received: number[] = [];
    function App() {
      const [mood, set] = useState<string | undefined>("happy");
      setMood = set;
      // The first holder's options shape the shared channel: presence first, for its key.
      presence = useRealtimePresence<{ mood: string }>(
        "hooks",
        mood === undefined ? undefined : { mood },
        { presenceKey: "page" },
      );
      broadcast = useBroadcast<{ n: number }>("hooks", {
        event: "tick",
        onMessage: (m) => received.push(m.payload.n),
      });
      return jsx("span", null, broadcast.status);
    }
    const root = createRoot(container as Any);
    try {
      root.render(jsx(App, null));
      flushSync();
      const flushUntil = async (done: () => boolean, what: string) => {
        await until(
          () => {
            flushSync();
            return done();
          },
          15_000,
          what,
        );
      };
      await flushUntil(() => broadcast.status === "joined", "joined");
      assertEquals(container.textContent, "joined");
      await flushUntil(() => presence.peers.page?.[0]?.mood === "happy", "tracked");

      const o = other.c.acquire("hooks");
      await until(() => o.status === "joined");
      await o.send("other-event", { n: 0 });
      await o.send("tick", { n: 5 });
      await flushUntil(() => broadcast.last?.payload.n === 5, "the message");
      assertEquals(received, [5], "only the hook's event");
      const atOther: unknown[] = [];
      o.onBroadcast((m) => atOther.push(m));
      assertEquals(await broadcast.send("tick", { n: 6 }), "ok");
      await until(() => atOther.length === 1);

      setMood(undefined);
      await flushUntil(() => !("page" in presence.peers), "untracked");
      setMood("calm");
      await flushUntil(() => presence.peers.page?.[0]?.mood === "calm", "tracked again");
      root.unmount();
      flushSync();
      assertEquals(page.sockets[0].readyState, 3, "the last channel released: socket closed");
      other.c.release(o);
    } finally {
      page.c.close();
      other.c.close();
      realtimeClient(null);
      await h.stop();
    }
  },
});

Deno.test("useBroadcast / useRealtimePresence: enabled false stays idle; send fails", async () => {
  const opened: string[] = [];
  realtimeClient(
    new RealtimeClient("ws://x/realtime/v1/websocket", (url) => {
      opened.push(url);
      throw new Error("must not open");
    }),
  );
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let broadcast!: BroadcastState<unknown>;
  let presence!: RealtimePresenceResult<Record<string, unknown>>;
  function App() {
    broadcast = useBroadcast("idle", { enabled: false });
    presence = useRealtimePresence("idle", { a: 1 }, { enabled: false });
    return jsx("span", null, broadcast.status);
  }
  const root = createRoot(container as Any);
  try {
    root.render(jsx(App, null));
    flushSync();
    assertEquals([broadcast.status, presence.status, opened], ["closed", "closed", []]);
    assertEquals(await broadcast.send("e", 1), "error");
    root.unmount();
  } finally {
    realtimeClient(null);
  }
});
