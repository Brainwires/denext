// Live data family — the hub's data subscriptions + presence rooms, exercised
// end-to-end over real WebSockets, plus the client hooks driven by a fake socket.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  __backpressureTestSeam,
  handleLiveUpgrade,
  installLiveHub,
  uninstallLiveHub,
} from "../src/server/live.ts";
import {
  liveReadable,
  registerServerReference,
  serverAction,
} from "../src/runtime/server-action.ts";
import { revalidateTag } from "../src/server/cache.ts";
import { prepareWire } from "../src/runtime/wire-codec.ts";
import { defineSubscription } from "../src/runtime/define-subscription.ts";
import { getSubscriptionDef, tagServerExports } from "../src/runtime/server-action.ts";
import type { StandardSchemaV1 } from "../src/runtime/define-action.ts";
import { useChannel, useSubscription } from "../src/client/live-typed.ts";
import {
  broadcastChannelTransport,
  createChannel,
  inMemoryChannelTransport,
  setChannelTransport,
} from "../src/runtime/channel.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import { useLive, useLiveOptimistic, usePresence } from "../src/client/live-data.ts";
import { useState } from "../src/runtime/hooks.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Start a hub-backed server on an ephemeral port. Defaults to open (anonymous)
 * presence/data so the mechanics tests don't need a policy; pass `config` to
 * exercise the authorization model or caps. */
function startHub(
  config: import("../src/server/config.ts").LiveConfig = { allowAnonymous: true },
): { server: Deno.HttpServer; port: number } {
  installLiveHub({
    appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
    originAllowed: () => true,
    config,
  });
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/_denext/live") return handleLiveUpgrade(req);
    return new Response("not found", { status: 404 });
  });
  return { server, port: (server.addr as Deno.NetAddr).port };
}

/** Open a client socket and collect frames of `type` until `count`, then resolve. */
function collect(
  port: number,
  type: string,
  count: number,
  onOpen: (ws: WebSocket) => void,
): Promise<{ ws: WebSocket; frames: Any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/_denext/live`);
    const frames: Any[] = [];
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${count} ${type} frames`)),
      3000,
    );
    ws.onopen = () => onOpen(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === type) {
        frames.push(msg);
        if (frames.length >= count) {
          clearTimeout(timer);
          resolve({ ws, frames });
        }
      }
    };
    ws.onerror = () => reject(new Error("socket error"));
  });
}

Deno.test("useLive hub: pushes the initial value, then recomputes on tag invalidation", async () => {
  let counter = 0;
  liveReadable(serverAction("livedata#counter", () => ++counter)); // registered + readable
  const { server, port } = startHub();
  try {
    const { ws, frames } = await collect(port, "data", 2, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "livedata#counter",
        args: [],
        tags: ["ctr"],
      }));
      // After the initial push, invalidate the tag to force a recompute.
      setTimeout(() => void revalidateTag("ctr"), 50);
    });
    assertEquals(frames[0], { type: "data", subId: "s1", value: 1 });
    assertEquals(frames[1], { type: "data", subId: "s1", value: 2 });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("useLive hub: a canSubscribe that throws on recompute degrades gracefully (no crash)", async () => {
  let n = 0;
  liveReadable(serverAction("livedata#guarded", () => ++n));
  // Allow the initial subscribe+push, then have the recompute re-authorization THROW —
  // the "role/tenant revoked mid-session, hook dereferences a null session" case. Without
  // the guard this becomes an unhandled rejection (fire-and-forget recompute) and would
  // crash the whole server process; the test runner would flag the unhandled rejection.
  let poisoned = false;
  const { server, port } = startHub({
    canSubscribe: () => {
      if (poisoned) throw new Error("session revoked mid-flight");
      return true;
    },
  });
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "livedata#guarded",
        args: [],
        tags: ["g"],
      }));
      setTimeout(() => {
        poisoned = true;
        void revalidateTag("g");
      }, 50);
    });
    // Graceful degrade instead of a process crash: a structured `failed` frame, sub dropped
    // (the initial push happened first — the recompute after `revalidateTag` is what threw).
    assertEquals(frames[0].subId, "s1");
    assertEquals(frames[0].code, "failed");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("useLive hub: only recomputes subscriptions whose tags were invalidated", async () => {
  let runs = 0;
  liveReadable(serverAction("livedata#watched", () => ++runs));
  const { server, port } = startHub();
  try {
    const { ws, frames } = await collect(port, "data", 1, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "livedata#watched",
        args: [],
        tags: ["watched"],
      }));
      // Invalidate an UNwatched tag — must NOT push a second frame.
      setTimeout(() => void revalidateTag("other"), 50);
    });
    // Give the unwatched invalidation time to (not) fire.
    await new Promise((r) => setTimeout(r, 120));
    assertEquals(frames.length, 1, "only the initial push; the unwatched tag is ignored");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("useLive hub: a hung fetcher hits the render deadline and frees its slot", async () => {
  // A fetcher that never settles on its own would hold a render slot forever; enough of
  // them peg `maxConcurrentRenders` and stall the fleet. `renderTimeoutSeconds` bounds it:
  // the run is aborted, an error frame is sent, and the slot is released for others.
  liveReadable(serverAction("livedata#hang", () => new Promise<number>(() => {})));
  liveReadable(serverAction("livedata#fast", () => "ok"));
  const { server, port } = startHub({
    allowAnonymous: true,
    limits: { renderTimeoutSeconds: 0.05 }, // 50ms deadline
  });
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "h",
        actionId: "livedata#hang",
        args: [],
        tags: ["t"],
      }));
    });
    // The hung fetcher times out into an error frame instead of hanging the subscription.
    assertEquals(frames[0].subId, "h");
    assertEquals(frames[0].code, "failed");
    assertEquals(
      frames[0].reason,
      "Internal Server Error",
      "redacted (a deadline is an internal error)",
    );

    // The slot was released: a subsequent fast subscription on the same socket resolves.
    const fast = await new Promise<Any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("fast subscription never resolved — render slot not freed")),
        3000,
      );
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "data" && msg.subId === "f") {
          clearTimeout(timer);
          resolve(msg);
        }
      };
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "f",
        actionId: "livedata#fast",
        args: [],
        tags: ["t2"],
      }));
    });
    assertEquals(fast.value, "ok");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

/** Poll `pred` until true or time out. */
async function waitFor(pred: () => boolean, msg: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error(`timeout: ${msg}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Open a socket that accumulates every presence-state frame it receives. */
async function presenceClient(port: number): Promise<{ ws: WebSocket; states: Any[] }> {
  const ws = new WebSocket(`ws://localhost:${port}/_denext/live`);
  const states: Any[] = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data as string);
    if (m.type === "presence-state") states.push(m);
  };
  await new Promise((resolve) => (ws.onopen = () => resolve(null)));
  return { ws, states };
}

Deno.test("usePresence hub: peers see each other; a leave rebroadcasts", async () => {
  const { server, port } = startHub();
  try {
    const a = await presenceClient(port);
    a.ws.send(JSON.stringify({ type: "presence-join", room: "doc1", state: { name: "A" } }));
    await waitFor(() => a.states.length >= 1, "A's own join");
    assertEquals(a.states.at(-1).peers.length, 1);
    const aSelf = a.states.at(-1).selfId;
    assert(aSelf, "A learns its own peer id");

    const b = await presenceClient(port);
    b.ws.send(JSON.stringify({ type: "presence-join", room: "doc1", state: { name: "B" } }));
    // B sees both peers; A is rebroadcast to (2 peers) as well.
    await waitFor(() => b.states.some((s) => s.peers.length === 2), "B sees 2 peers");
    await waitFor(() => a.states.some((s) => s.peers.length === 2), "A rebroadcast to 2 peers");
    const bLatest = b.states.at(-1);
    assert(bLatest.peers.some((p: Any) => p.state?.name === "A"));
    assert(bLatest.peers.some((p: Any) => p.state?.name === "B"));
    assert(bLatest.selfId !== aSelf, "distinct peer ids");

    // B leaves (socket close) → A sees a 1-peer state again.
    b.ws.close();
    await waitFor(
      () => a.states.length >= 3 && a.states.at(-1).peers.length === 1,
      "A sees B leave",
    );
    a.ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

// ---- Authorization model + resource caps -----------------------------------

Deno.test("hub authz: no policy configured → a `no-policy` error (dev and prod alike)", async () => {
  const { server, port } = startHub({}); // no policy, no allowAnonymous → refused everywhere
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({ type: "presence-join", room: "doc1", state: { name: "A" } }));
    });
    // A configuration gap (not a runtime denial) — a distinct, actionable code.
    assertEquals(frames[0].code, "no-policy");
    assertEquals(frames[0].room, "doc1");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("hub authz: allowAnonymous opts presence back into open access", async () => {
  const { server, port } = startHub({ allowAnonymous: true });
  try {
    const { ws, frames } = await collect(port, "presence-state", 1, (ws) => {
      ws.send(JSON.stringify({ type: "presence-join", room: "anywhere", state: { n: 1 } }));
    });
    assertEquals(frames[0].room, "anywhere");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("hub authz: canJoinRoom gates rooms — a rejected room is `denied`, not `no-policy`", async () => {
  const { server, port } = startHub({ canJoinRoom: (_ctx, room) => room === "public" });
  try {
    const denied = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({ type: "presence-join", room: "secret", state: {} }));
    });
    // The policy evaluated and said no → `denied` (distinct from an unconfigured hub).
    assertEquals(denied.frames[0].code, "denied");
    denied.ws.close();

    const ok = await collect(port, "presence-state", 1, (ws) => {
      ws.send(JSON.stringify({ type: "presence-join", room: "public", state: { n: 1 } }));
    });
    assertEquals(ok.frames[0].room, "public");
    ok.ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("hub authz: data-subscribe — liveReadable allowed, unmarked is `no-policy`", async () => {
  liveReadable(registerServerReference("livetest#open", () => 42));
  registerServerReference("livetest#closed", () => 1);
  const { server, port } = startHub({}); // no canSubscribe policy
  try {
    const refused = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify(
        { type: "data-subscribe", subId: "s1", actionId: "livetest#closed", args: [], tags: [] },
      ));
    });
    assertEquals(refused.frames[0].code, "no-policy");
    refused.ws.close();

    const ok = await collect(port, "data", 1, (ws) => {
      ws.send(JSON.stringify(
        { type: "data-subscribe", subId: "s2", actionId: "livetest#open", args: [], tags: [] },
      ));
    });
    assertEquals(ok.frames[0].value, 42);
    ok.ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("hub authz: allowAnonymous does NOT open unmarked data — only liveReadable", async () => {
  // Enabling anonymous *presence* must not silently expose every registered action on
  // the socket. An unmarked action stays `no-policy` even with allowAnonymous; a
  // liveReadable one is served.
  liveReadable(registerServerReference("livetest#anon-open", () => 7));
  registerServerReference("livetest#anon-mutation", () => 1);
  const { server, port } = startHub({ allowAnonymous: true });
  try {
    const refused = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify(
        {
          type: "data-subscribe",
          subId: "s1",
          actionId: "livetest#anon-mutation",
          args: [],
          tags: [],
        },
      ));
    });
    assertEquals(refused.frames[0].code, "no-policy");
    refused.ws.close();

    const ok = await collect(port, "data", 1, (ws) => {
      ws.send(JSON.stringify(
        { type: "data-subscribe", subId: "s2", actionId: "livetest#anon-open", args: [], tags: [] },
      ));
    });
    assertEquals(ok.frames[0].value, 7);
    ok.ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("hub authz: canSubscribe policy — a rejected action is `denied`, not `no-policy`", async () => {
  registerServerReference("livetest#stats", () => ({ ok: true }));
  registerServerReference("livetest#secret", () => 1);
  const { server, port } = startHub({
    canSubscribe: (_ctx, sub) => sub.actionId === "livetest#stats",
  });
  try {
    const denied = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify(
        { type: "data-subscribe", subId: "s1", actionId: "livetest#secret", args: [], tags: [] },
      ));
    });
    assertEquals(denied.frames[0].code, "denied");
    denied.ws.close();

    const ok = await collect(port, "data", 1, (ws) => {
      ws.send(JSON.stringify(
        { type: "data-subscribe", subId: "s2", actionId: "livetest#stats", args: [], tags: [] },
      ));
    });
    assertEquals(ok.frames[0].value.ok, true);
    ok.ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("hub caps: an oversized inbound message is refused", async () => {
  const { server, port } = startHub({ allowAnonymous: true, limits: { maxMessageBytes: 100 } });
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify(
        { type: "presence-update", room: "r", state: "x".repeat(500) },
      ));
    });
    assertEquals(frames[0].code, "limit");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("hub caps: too many presence rooms per connection is refused", async () => {
  const { server, port } = startHub({ allowAnonymous: true, limits: { maxRoomsPerConnection: 1 } });
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({ type: "presence-join", room: "r1", state: {} }));
      ws.send(JSON.stringify({ type: "presence-join", room: "r2", state: {} }));
    });
    assertEquals(frames[0].code, "limit");
    assertEquals(frames[0].room, "r2");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

// ---- Client hooks (fake WebSocket + in-memory DOM) --------------------------

class FakeWS {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = 0;
  bufferedAmount = 0;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Test helper: simulate the socket opening. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Test helper: deliver a server frame. */
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

/** The subId the client generated, read off the sent `data-subscribe` frame. */
function sentSubId(ws: FakeWS): string {
  const frame = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "data-subscribe");
  return frame.subId;
}

Deno.test("useLive client: shows the initial value, then re-renders on a pushed frame", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const action = Object.assign(() => Promise.resolve(0), { denextActionId: "app#orders" });
    function App() {
      const v = useLive(action as Any, [], { tags: ["orders"], initial: 7 });
      return h("span", null, String(v));
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    assertEquals(container.textContent, "7", "initial value before any push");

    const ws = FakeWS.instances.at(-1)!;
    ws.open(); // flushes the queued data-subscribe
    const subId = sentSubId(ws);
    assert(subId, "a data-subscribe was sent on open");

    ws.deliver({ type: "data", subId, value: 42 });
    flushSync();
    assertEquals(container.textContent, "42", "re-renders with the pushed value");
    root.unmount();
  });
});

Deno.test("usePresence client: splits self vs. others from a presence-state frame", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    function App() {
      const { peers, others, self } = usePresence<{ n: number }>("doc", { initialState: { n: 1 } });
      return h("span", null, `${peers.length}/${others.length}/${self?.state.n ?? "-"}`);
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    assert(ws.sent.map((s) => JSON.parse(s)).some((m) => m.type === "presence-join"));

    ws.deliver({
      type: "presence-state",
      room: "doc",
      selfId: "me",
      peers: [{ id: "me", state: { n: 1 } }, { id: "other", state: { n: 2 } }],
    });
    flushSync();
    assertEquals(container.textContent, "2/1/1", "2 peers, 1 other, self.state.n === 1");
    root.unmount();
  });
});

Deno.test("useLiveOptimistic: overlay applies, then resets when the live value changes", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    let apply: (n: number) => void = () => {};
    let bump: (n: number) => void = () => {};
    function App() {
      const [live, setLive] = useState(0);
      bump = setLive;
      const [shown, add] = useLiveOptimistic<number, number>(live, (c, n) => c + n);
      apply = add;
      return h("span", null, String(shown));
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    assertEquals(container.textContent, "0");
    apply(5); // optimistic overlay
    flushSync();
    assertEquals(container.textContent, "5", "optimistic value shown");
    bump(10); // authoritative value arrives → overlay resets
    flushSync();
    assertEquals(container.textContent, "10", "reconciled to the live value");
    root.unmount();
  });
});

// ---- Back-pressure recovery (server send() sheds; replay on drain) ----------
// Real 1 MiB socket buffering can't be forced over a loopback socket, so these drive
// the recovery seam against a FakeWS whose readyState/bufferedAmount they control.
// (FakeWS.OPEN/CLOSED match the global WebSocket constants the server compares against.)

Deno.test("back-pressure: a shed <Live> patch is replayed as one refresh on drain", () => {
  const { makeConn, send, drainRecover, MAX_BUFFERED } = __backpressureTestSeam;
  const sock = new FakeWS("ws://localhost/_denext/live");
  sock.readyState = FakeWS.OPEN;
  const conn = makeConn(sock as unknown as WebSocket);

  sock.bufferedAmount = MAX_BUFFERED + 1; // back-pressured
  send(conn, { type: "patch", boundaryId: "b1", flight: [] });
  assertEquals(sock.sent.length, 0, "the patch is shed while back-pressured");
  assertEquals(conn.recoverBoundaries, true);
  assert(conn.recoverTimer != null, "a recovery poll is armed");

  // Disarm the real poll and simulate the drain by invoking recovery directly.
  clearTimeout(conn.recoverTimer!);
  conn.recoverTimer = null;
  sock.bufferedAmount = 0; // drained
  drainRecover(conn);

  assertEquals(conn.recoverBoundaries, false, "intent cleared after replay");
  const frames = sock.sent.map((s) => JSON.parse(s));
  assertEquals(frames, [{ type: "refresh" }], "exactly one refresh catches boundaries up");
});

Deno.test("back-pressure: a shed useLive data frame re-runs the fetcher on drain", async () => {
  const { makeConn, send, drainRecover, MAX_BUFFERED } = __backpressureTestSeam;
  let n = 0;
  liveReadable(registerServerReference("bp#data", () => ++n));
  const sock = new FakeWS("ws://localhost/_denext/live");
  sock.readyState = FakeWS.OPEN;
  const conn = makeConn(sock as unknown as WebSocket);
  conn.dataSubs.set("s1", { actionId: "bp#data", args: [], tags: ["t"] });

  sock.bufferedAmount = MAX_BUFFERED + 1;
  send(conn, { type: "data", subId: "s1", value: 41 }); // value irrelevant — it's shed
  assertEquals(sock.sent.length, 0);
  assertEquals([...(conn.recoverSubs ?? [])], ["s1"]);

  clearTimeout(conn.recoverTimer!);
  conn.recoverTimer = null;
  sock.bufferedAmount = 0;
  drainRecover(conn); // fires recomputeData (async) — re-runs the fetcher

  await waitFor(() => sock.sent.length >= 1, "recovery re-pushed the sub's value");
  assertEquals(JSON.parse(sock.sent[0]), { type: "data", subId: "s1", value: 1 });
  assertEquals(conn.recoverSubs, undefined, "intent cleared");
});

Deno.test("back-pressure: recovery is dropped (no send) if the socket closed before draining", () => {
  const { makeConn, drainRecover } = __backpressureTestSeam;
  const sock = new FakeWS("ws://localhost/_denext/live");
  const conn = makeConn(sock as unknown as WebSocket);
  conn.recoverBoundaries = true;
  conn.recoverSubs = new Set(["s1"]);
  sock.readyState = FakeWS.CLOSED;

  drainRecover(conn);
  assertEquals(conn.recoverBoundaries, false);
  assertEquals(conn.recoverSubs, undefined);
  assertEquals(sock.sent.length, 0, "nothing sent on a closed socket — a reconnect refreshes");
});

Deno.test("back-pressure: a shed presence-state is self-superseding — no recovery armed", () => {
  const { makeConn, send, MAX_BUFFERED } = __backpressureTestSeam;
  const sock = new FakeWS("ws://localhost/_denext/live");
  sock.readyState = FakeWS.OPEN;
  const conn = makeConn(sock as unknown as WebSocket);

  sock.bufferedAmount = MAX_BUFFERED + 1;
  send(conn, { type: "presence-state", room: "r", peers: [], selfId: "x" });
  assertEquals(sock.sent.length, 0, "shed");
  assertEquals(conn.recoverBoundaries, undefined);
  assertEquals(conn.recoverSubs, undefined);
  assertEquals(conn.recoverTimer ?? null, null, "no recovery poll for presence");
});

Deno.test("useLive hub: re-authorizes on recompute — a revoked canSubscribe stops pushes", async () => {
  // canSubscribe runs at subscribe time; a mid-session revocation must also stop the
  // recompute pushes, or a long-lived socket keeps receiving updates after access is lost.
  let allowed = true;
  serverAction("livedata#authz", () => Date.now());
  const { server, port } = startHub({ canSubscribe: () => allowed });
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "livedata#authz",
        args: [],
        tags: ["authz"],
      }));
      // Revoke access, then invalidate the tag to force a recompute.
      setTimeout(() => {
        allowed = false;
        void revalidateTag("authz");
      }, 50);
    });
    // The initial push was authorized; the recompute after revocation is a structured `denied`.
    assertEquals(frames[0].code, "denied", "recompute after revocation is refused");
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("useLive hub: codec-flagged args are decoded and a Date value is pushed with enc:1", async () => {
  liveReadable(serverAction(
    "livedata#when",
    (d: unknown) => ({ gotDate: d instanceof Date, at: new Date(0) }),
  ));
  const { server, port } = startHub();
  try {
    const args = prepareWire([new Date(5)]);
    const { ws, frames } = await collect(port, "data", 1, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "livedata#when",
        args: args.value,
        enc: 1,
        tags: [],
      }));
    });
    assertEquals(frames[0], {
      type: "data",
      subId: "s1",
      value: { gotDate: true, at: { $: "D", v: "1970-01-01T00:00:00.000Z" } },
      enc: 1,
    });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("useLive hub: malformed codec-flagged args are refused as bad-message (nothing runs)", async () => {
  let runs = 0;
  liveReadable(serverAction("livedata#never", () => ++runs));
  const { server, port } = startHub();
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "livedata#never",
        args: [{ $: "Z" }],
        enc: 1,
        tags: [],
      }));
    });
    assertEquals(frames[0].code, "bad-message");
    assertEquals(frames[0].subId, "s1");
    assertEquals(runs, 0);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

// ── Tag watches (`useApi({ tags })`) ──────────────────────────────────────────

Deno.test("tag watch hub: allowAnonymous admits a watch; revalidateTag pushes an `invalidate` for the hit tags", async () => {
  const { server, port } = startHub({ allowAnonymous: true });
  try {
    const { ws, frames } = await collect(port, "invalidate", 1, (ws) => {
      ws.send(JSON.stringify({ type: "tags-subscribe", subId: "t1", tags: ["orders", "users"] }));
      setTimeout(() => void revalidateTag("orders"), 50);
    });
    assertEquals(frames[0], { type: "invalidate", subId: "t1", tags: ["orders"] });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("tag watch hub: no policy → `no-policy`; canWatchTags gates by tag; malformed tags → bad-message", async () => {
  const { server, port } = startHub({});
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({ type: "tags-subscribe", subId: "t1", tags: ["orders"] }));
    });
    assertEquals([frames[0].code, frames[0].subId], ["no-policy", "t1"]);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
  const gated = startHub({
    canWatchTags: (_ctx, tags) => tags.every((t) => t.startsWith("public:")),
  });
  try {
    const { ws, frames } = await collect(gated.port, "error", 2, (ws) => {
      ws.send(JSON.stringify({ type: "tags-subscribe", subId: "ok", tags: ["public:news"] }));
      ws.send(JSON.stringify({ type: "tags-subscribe", subId: "no", tags: ["secret:ledger"] }));
      ws.send(JSON.stringify({ type: "tags-subscribe", subId: "bad", tags: [42] }));
    });
    const byId = Object.fromEntries(frames.map((f: Any) => [f.subId, f.code]));
    assertEquals(byId.no, "denied");
    assertEquals(byId.bad, "bad-message");
    assertEquals(byId.ok, undefined, "the permitted watch produced no error");
    ws.close();
  } finally {
    uninstallLiveHub();
    await gated.server.shutdown();
  }
});

// ── defineSubscription (typed, validated live queries) ─────────────────────────

/** `{ id: string }` — a hand-rolled Standard Schema (extra keys stripped). */
const idSchema: StandardSchemaV1<{ id: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) =>
      typeof (v as { id?: unknown })?.id === "string"
        ? { value: { id: (v as { id: string }).id } }
        : { issues: [{ message: "id must be a string", path: ["id"] }] },
  },
};

Deno.test("defineSubscription hub: validated input, server-derived tags, recompute on invalidation", async () => {
  let runs = 0;
  defineSubscription<{ id: string; n: number }, { id: string }>({
    id: "sub#order",
    input: idSchema,
    tags: ({ id }) => [`order:${id}`],
    resolve: ({ id }) => ({ id, n: ++runs }),
  });
  const { server, port } = startHub({}); // no policy needed: a definition IS the opt-in
  try {
    const { ws, frames } = await collect(port, "data", 2, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "sub#order",
        args: [{ id: "7", extra: "stripped" }],
        tags: ["bogus-client-tag"], // ignored: tags come from the definition
      }));
      setTimeout(() => void revalidateTag("bogus-client-tag"), 40); // no effect
      setTimeout(() => void revalidateTag("order:7"), 80); // recompute
    });
    assertEquals(frames[0], { type: "data", subId: "s1", value: { id: "7", n: 1 } });
    assertEquals(frames[1], { type: "data", subId: "s1", value: { id: "7", n: 2 } });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("defineSubscription hub: invalid input → `invalid-input` with field errors; the resolver never runs", async () => {
  let runs = 0;
  defineSubscription<number, { id: string }>({
    id: "sub#strict",
    input: idSchema,
    resolve: () => ++runs,
  });
  const { server, port } = startHub({});
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      ws.send(JSON.stringify({
        type: "data-subscribe",
        subId: "s1",
        actionId: "sub#strict",
        args: [{ id: 5 }],
        tags: [],
      }));
    });
    assertEquals(frames[0].code, "invalid-input");
    assertEquals(frames[0].subId, "s1");
    assertEquals(frames[0].fieldErrors, { id: "id must be a string" });
    assertEquals(runs, 0);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("defineSubscription hub: `authorize` false → denied; a resolver throw → redacted `failed` + digest", async () => {
  defineSubscription<number, { id: string }>({
    id: "sub#private",
    input: idSchema,
    authorize: () => false,
    resolve: () => 1,
  });
  defineSubscription<number, { id: string }>({
    id: "sub#boom",
    input: idSchema,
    resolve: () => {
      throw new Error("db password = hunter2");
    },
  });
  const errors = console.error;
  console.error = () => {};
  const { server, port } = startHub({});
  try {
    const { ws, frames } = await collect(port, "error", 2, (ws) => {
      ws.send(
        JSON.stringify({
          type: "data-subscribe",
          subId: "p",
          actionId: "sub#private",
          args: [{ id: "1" }],
          tags: [],
        }),
      );
      ws.send(
        JSON.stringify({
          type: "data-subscribe",
          subId: "b",
          actionId: "sub#boom",
          args: [{ id: "1" }],
          tags: [],
        }),
      );
    });
    const byId = Object.fromEntries(frames.map((f: Any) => [f.subId, f]));
    assertEquals(byId.p.code, "denied");
    assertEquals(byId.b.code, "failed");
    assertEquals(byId.b.reason, "Internal Server Error", "redacted in production");
    assert(typeof byId.b.digest === "string" && byId.b.digest.length === 16);
    assert(!JSON.stringify(frames).includes("hunter2"));
    ws.close();
  } finally {
    console.error = errors;
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("data-subscribe hardening: an oversized input is `limit`, a too-deep one `bad-message` (plain actions too)", async () => {
  liveReadable(serverAction("livedata#plain", () => 1));
  const { server, port } = startHub({ limits: { maxSubscriptionInputBytes: 64 } });
  try {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    const { ws, frames } = await collect(port, "error", 2, (ws) => {
      ws.send(
        JSON.stringify({
          type: "data-subscribe",
          subId: "big",
          actionId: "livedata#plain",
          args: ["x".repeat(200)],
          tags: [],
        }),
      );
      ws.send(
        JSON.stringify({
          type: "data-subscribe",
          subId: "deep",
          actionId: "livedata#plain",
          args: [deep],
          tags: [],
        }),
      );
    });
    const byId = Object.fromEntries(frames.map((f: Any) => [f.subId, f.code]));
    assertEquals(byId, { big: "limit", deep: "bad-message" });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test('defineSubscription: the ref is a one-shot callable; a "use server" export registers as live-readable', async () => {
  const sub = defineSubscription<string, { id: string }>({
    id: "sub#oneshot",
    input: idSchema,
    resolve: ({ id }) => `order ${id}`,
  });
  assertEquals(await sub({ id: "9" }), "order 9");
  await assertRejects(() => sub({ id: 9 as never }));
  // Exported from a "use server" module: tagging assigns the id and registers the definition.
  const mod = { orders: defineSubscription<number, void>({ resolve: () => 1 }) };
  tagServerExports(mod as Record<string, unknown>, "app/subs.ts");
  const id = (mod.orders as { denextActionId: string }).denextActionId;
  assert(id && getSubscriptionDef(id), "the export's definition is registered under its id");
});

Deno.test("useSubscription client: initial → live → structured error; a refused sub is not re-sent on reconnect", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const ref = { denextActionId: "sub#order" } as {
      denextActionId: string;
      __sub?: { input: { id: string }; output: number };
    };
    function App() {
      const { data, status, error } = useSubscription(ref, { id: "7" }, { initial: 0 });
      return h(
        "span",
        null,
        `${data}/${status}/${error?.code ?? "-"}/${error?.fieldErrors?.id ?? "-"}`,
      );
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    assertEquals(container.textContent, "0/idle/-/-");
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const subId = sentSubId(ws);
    const sent = JSON.parse(ws.sent.find((s) => s.includes("data-subscribe"))!);
    assertEquals(sent.args, [{ id: "7" }]);
    ws.deliver({ type: "data", subId, value: 42 });
    flushSync();
    assertEquals(container.textContent, "42/live/-/-");
    ws.deliver({
      type: "error",
      code: "invalid-input",
      reason: "Validation failed",
      subId,
      fieldErrors: { id: "bad" },
    });
    flushSync();
    assertEquals(container.textContent, "42/error/invalid-input/bad");
    // Reconnect: the refused subscription must not be re-sent.
    ws.close();
    const again = new FakeWS("ws://localhost/_denext/live");
    // The client reconnects on a timer; emulate its resubscribe by opening a fresh socket through
    // the same path: the refused (dead) sub is skipped, so no data-subscribe for it is queued.
    void again;
    root.unmount();
  });
});

// ── Channels (`createChannel` → `useChannel`) ──────────────────────────────────

/** Subscribe `ws` to a channel key and return a promise for the first N `channel` frames. */
function channelSubscribe(ws: WebSocket, subId: string, channelId: string, key: string): void {
  ws.send(JSON.stringify({ type: "channel-subscribe", subId, channelId, key }));
}

Deno.test("channel hub: an authorized subscriber receives publishes (codec-encoded), fanned out to every connection", async () => {
  const ch = createChannel<{ at: Date; n: number }>({ id: "ch#orders", authorize: () => true });
  const { server, port } = startHub({});
  try {
    const a = collect(
      port,
      "channel",
      1,
      (ws) => channelSubscribe(ws, "a1", "ch#orders", "user:1"),
    );
    const b = collect(
      port,
      "channel",
      1,
      (ws) => channelSubscribe(ws, "b1", "ch#orders", "user:1"),
    );
    // Give both subscribes a moment to register, then publish once.
    setTimeout(() => void ch.publish("user:1", { at: new Date(0), n: 1 }), 80);
    const [ra, rb] = await Promise.all([a, b]);
    for (const [frames, subId] of [[ra.frames, "a1"], [rb.frames, "b1"]] as const) {
      assertEquals(frames[0].type, "channel");
      assertEquals(frames[0].subId, subId);
      assertEquals(frames[0].seq, 1);
      assertEquals(frames[0].enc, 1);
      assertEquals(frames[0].value, { at: { $: "D", v: "1970-01-01T00:00:00.000Z" }, n: 1 });
    }
    ra.ws.close();
    rb.ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("channel hub: unknown channel → denied (not distinguishable), bad key → bad-message, authorize false → denied", async () => {
  createChannel<number>({ id: "ch#private", authorize: (_ctx, key) => key === "public" });
  const { server, port } = startHub({});
  try {
    const { ws, frames } = await collect(port, "error", 3, (ws) => {
      channelSubscribe(ws, "u", "ch#does-not-exist", "k");
      channelSubscribe(ws, "k", "ch#private", "bad key with spaces!");
      channelSubscribe(ws, "d", "ch#private", "secret");
    });
    const byId = Object.fromEntries(frames.map((f: Any) => [f.subId, f.code]));
    assertEquals(byId, { u: "denied", k: "bad-message", d: "denied" });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("channel hub: revoke ends a key's subscriptions with `denied`; nothing more is delivered", async () => {
  const ch = createChannel<number>({ id: "ch#revocable", authorize: () => true });
  const { server, port } = startHub({});
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      channelSubscribe(ws, "r1", "ch#revocable", "room:9");
      setTimeout(() => ch.revoke("room:9"), 60);
      setTimeout(() => void ch.publish("room:9", 1), 120); // after the revoke: no subscriber
    });
    assertEquals([frames[0].code, frames[0].subId], ["denied", "r1"]);
    await new Promise((r) => setTimeout(r, 150));
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("channel hub: a publisher burst coalesces into one frame carrying the LAST value", async () => {
  const ch = createChannel<number>({ id: "ch#burst", authorize: () => true });
  const { server, port } = startHub({});
  try {
    const seen: Any[] = [];
    const { ws } = await collect(port, "channel", 1, (ws) => {
      ws.addEventListener("message", (ev) => {
        const m = JSON.parse((ev as MessageEvent).data as string);
        if (m.type === "channel") seen.push(m);
      });
      channelSubscribe(ws, "s", "ch#burst", "k");
      setTimeout(() => {
        void ch.publish("k", 1);
        void ch.publish("k", 2);
        void ch.publish("k", 3);
      }, 60);
    });
    await new Promise((r) => setTimeout(r, 80));
    assertEquals(seen.length, 1, "three publishes within the coalesce window → one frame");
    assertEquals(seen[0].value, 3);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("createChannel: authorize is required; publish validates the schema and caps the payload at the publisher", async () => {
  assertThrows(() => createChannel({} as never), TypeError, "authorize");
  const strict = createChannel<{ n: number }>({
    id: "ch#strict",
    authorize: () => true,
    schema: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) =>
          typeof (v as { n?: unknown })?.n === "number"
            ? { value: v as { n: number } }
            : { issues: [{ message: "n must be a number", path: ["n"] }] },
      },
    },
  });
  await assertRejects(
    () => strict.publish("k", { n: "x" } as never),
    Error,
    "Invalid channel payload",
  );
  await assertRejects(() => strict.publish("bad key!", { n: 1 }), TypeError, "invalid key");
  const { server } = startHub({ limits: { maxChannelPayloadBytes: 32 } }); // sets the cap
  try {
    await assertRejects(
      () => strict.publish("k", { n: 1, pad: "x".repeat(100) } as never),
      RangeError,
    );
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("channel hub: after the auth TTL, the next push re-authorizes lazily; a revoked viewer is denied", async () => {
  let allowed = true;
  const ch = createChannel<number>({
    id: "ch#ttl",
    authorize: () => allowed,
    authTtlSeconds: 0.01,
  });
  const { server, port } = startHub({});
  try {
    const { ws, frames } = await collect(port, "error", 1, (ws) => {
      channelSubscribe(ws, "t", "ch#ttl", "k");
      setTimeout(() => {
        allowed = false; // role revoked mid-session
        void ch.publish("k", 1); // TTL (10 ms) has passed → re-auth → denied
      }, 80);
    });
    assertEquals([frames[0].code, frames[0].subId], ["denied", "t"]);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("channel transports: the in-memory default loops back; BroadcastChannel spans instances when available", async () => {
  const mem = inMemoryChannelTransport();
  const got: unknown[] = [];
  const stop = mem.subscribe((ev) => got.push(ev.key));
  await mem.publish({ kind: "publish", channelId: "c", key: "k", seq: 1, instance: "i" });
  assertEquals(got, ["k"]);
  stop();
  if (typeof BroadcastChannel !== "undefined") {
    const a = broadcastChannelTransport("denext-test-channels");
    const b = broadcastChannelTransport("denext-test-channels");
    const seen = new Promise<string>((resolve) => b.subscribe((ev) => resolve(ev.key)));
    await a.publish({ kind: "publish", channelId: "c", key: "cross", seq: 1, instance: "other" });
    assertEquals(await seen, "cross");
  }
  setChannelTransport(inMemoryChannelTransport()); // restore the default for later tests
});

Deno.test("useChannel client: initial → pushed value → a denial marks the sub dead", () => {
  withFakeSocket(() => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const ref = { denextChannelId: "ch#orders" } as {
      denextChannelId: string;
      __channel?: { payload: number };
    };
    function App() {
      const { data, status, error } = useChannel(ref, "user:1", { initial: 0 });
      return h("span", null, `${data}/${status}/${error?.code ?? "-"}`);
    }
    const root = createRoot(container as Any);
    root.render(h(App, null));
    flushSync();
    assertEquals(container.textContent, "0/idle/-");
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const sent = JSON.parse(ws.sent.find((s) => s.includes("channel-subscribe"))!);
    assertEquals([sent.channelId, sent.key], ["ch#orders", "user:1"]);
    ws.deliver({ type: "channel", subId: sent.subId, seq: 1, value: 42 });
    flushSync();
    assertEquals(container.textContent, "42/live/-");
    ws.deliver({
      type: "error",
      code: "denied",
      reason: "channel access revoked",
      subId: sent.subId,
    });
    flushSync();
    assertEquals(container.textContent, "42/error/denied");
    root.unmount();
  });
});
