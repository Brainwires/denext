// Live data family — the hub's data subscriptions + presence rooms, exercised
// end-to-end over real WebSockets, plus the client hooks driven by a fake socket.

import { assert, assertEquals } from "@std/assert";
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
