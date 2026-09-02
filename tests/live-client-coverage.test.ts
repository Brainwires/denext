// Coverage for the Live Server Components client transport
// (`src/client/live-client.ts`) and the `denext/live` entry (`src/live.ts`).
//
// The transport opens a single WebSocket lazily on the first live subscription and
// closes it on the last, resubscribing everything on (re)connect and applying server
// frames to the addressed boundary/data-sub/presence-room. These tests drive it with
// a fake `WebSocket` + `location` (no real network) so the connect → subscribe →
// frame → unsubscribe → close lifecycle is exercised deterministically. All globals
// are restored in `finally`, and every test drains its subscriptions so the module's
// single socket is closed (no leaked timers/resources).

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "denext/jsx-runtime";
import { render } from "denext/testing";
import { configureLive, joinPresence, subscribeLiveData } from "../src/client/live-client.ts";
import { registerLiveBoundary } from "../src/runtime/live-registry.ts";
import {
  configureLive as configureLiveFromEntry,
  Live,
  liveReadable,
  useLive,
  useLiveOptimistic,
  usePresence,
} from "denext/live";

// deno-lint-ignore no-explicit-any
type AnyGlobal = any;

/** A controllable stand-in for the browser WebSocket (no real connection). */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: FakeWebSocket | null = null;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // ---- test drivers ----
  /** Transition to OPEN and fire onopen (a fresh or simulated-reconnect connect). */
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  /** Deliver a server frame as its JSON string. */
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** Deliver raw (possibly non-string / malformed) socket data. */
  emitRaw(data: unknown) {
    this.onmessage?.({ data });
  }
  /** The parsed frames this client has sent so far. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

/** Install the fake WebSocket + a browser-like location; returns a restore fn. */
function stubLiveGlobals(): () => void {
  const g = globalThis as AnyGlobal;
  const origWs = g.WebSocket;
  const origLoc = g.location;
  g.WebSocket = FakeWebSocket;
  g.location = {
    protocol: "http:",
    host: "localhost:8000",
    href: "http://localhost:8000/orders",
  };
  FakeWebSocket.last = null;
  return () => {
    g.WebSocket = origWs;
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
  };
}

Deno.test("subscribeLiveData: opens the socket, sends data-subscribe on connect, routes values + errors, closes on unsubscribe", () => {
  const restore = stubLiveGlobals();
  try {
    const values: unknown[] = [];
    const errors: (string | undefined)[] = [];
    const unsub = subscribeLiveData("act#1", [1, 2], ["orders"], (v, err) => {
      values.push(v);
      errors.push(err);
    });
    const ws = FakeWebSocket.last!;
    assert(ws, "a socket is opened for the first subscription");
    assert(ws.url.endsWith("/_denext/live"), "connects to the live endpoint");
    // While CONNECTING nothing is flushed yet.
    assertEquals(ws.sent.length, 0);

    // On connect, every live subscription is (re)sent.
    ws.fireOpen();
    const sub = ws.frames().find((f) => f.type === "data-subscribe");
    assert(sub, "data-subscribe is sent on connect");
    assertEquals(sub!.actionId, "act#1");
    assertEquals(sub!.args, [1, 2]);
    assertEquals(sub!.tags, ["orders"]);
    const subId = sub!.subId as string;

    // A server value for this sub is delivered to onData.
    ws.emit({ type: "data", subId, value: { total: 5 } });
    assertEquals(values.at(-1), { total: 5 });
    assertEquals(errors.at(-1), undefined);

    // An error frame addressed to this sub delivers (undefined, reason).
    ws.emit({ type: "error", code: "denied", reason: "not allowed", subId });
    assertEquals(values.at(-1), undefined);
    assertEquals(errors.at(-1), "not allowed");

    // Unsubscribing sends data-unsubscribe and closes the now-idle socket.
    unsub();
    assert(ws.frames().some((f) => f.type === "data-unsubscribe" && f.subId === subId));
    assert(ws.closed, "the socket closes when the last subscription drops");
  } finally {
    restore();
  }
});

Deno.test("joinPresence: join / update / leave frames and presence-state delivery", () => {
  const restore = stubLiveGlobals();
  try {
    let peers: Array<{ id: string; state: unknown }> = [];
    let selfId = "";
    const handle = joinPresence("room-1", { cursor: 0 }, (p, sid) => {
      peers = p;
      selfId = sid;
    });
    const ws = FakeWebSocket.last!;
    ws.fireOpen();

    const join = ws.frames().find((f) => f.type === "presence-join");
    assert(join, "presence-join is (re)sent on connect");
    assertEquals(join!.room, "room-1");
    assertEquals(join!.state, { cursor: 0 });

    handle.update({ cursor: 42 });
    const upd = ws.frames().find((f) => f.type === "presence-update");
    assertEquals(upd!.state, { cursor: 42 });

    ws.emit({
      type: "presence-state",
      room: "room-1",
      peers: [{ id: "me", state: { cursor: 42 } }],
      selfId: "me",
    });
    assertEquals(selfId, "me");
    assertEquals(peers, [{ id: "me", state: { cursor: 42 } }]);

    handle.leave();
    assert(ws.frames().some((f) => f.type === "presence-leave" && f.room === "room-1"));
    assert(ws.closed, "leaving the last room closes the socket");
  } finally {
    restore();
  }
});

Deno.test("configureLive + boundary register: subscribe frame, patch parsing, refresh, and reconnect-refresh", async () => {
  const restore = stubLiveGlobals();
  try {
    let refreshCount = 0;
    let patched: unknown;
    // The parser stringifies the Flight payload so we can assert it was applied
    // (the return must be a VNodeChild — a string qualifies).
    configureLive({
      parse: (flight) => `parsed:${JSON.stringify(flight)}`,
      refresh: () => refreshCount++,
    });

    const unsub = registerLiveBoundary("bnd-1", ["orders"], (children) => {
      patched = children;
    });
    const ws = FakeWebSocket.last!;
    assert(ws, "the first boundary opens the socket");

    ws.fireOpen(); // first connect: sends the subscribe, does NOT refresh
    await new Promise<void>((r) => queueMicrotask(r)); // drain the batched subscribe
    const subscribe = ws.frames().find((f) => f.type === "subscribe");
    assert(subscribe, "a subscribe frame is sent");
    assertEquals(subscribe!.url, "http://localhost:8000/orders");
    assertEquals(subscribe!.boundaries, [{ id: "bnd-1", tags: ["orders"] }]);
    assertEquals(refreshCount, 0, "the first connect does not refresh");

    // A patch for the boundary is parsed and handed to onPatch.
    ws.emit({ type: "patch", boundaryId: "bnd-1", flight: [{ node: 1 }] });
    assertEquals(patched, 'parsed:[{"node":1}]');

    // A patch for an unknown boundary is ignored (no throw, patched unchanged).
    ws.emit({ type: "patch", boundaryId: "ghost", flight: [{ node: 2 }] });
    assertEquals(patched, 'parsed:[{"node":1}]');

    // A refresh frame re-renders the route.
    ws.emit({ type: "refresh" });
    assertEquals(refreshCount, 1);

    // A ping is answered with a pong (socket is OPEN).
    ws.emit({ type: "ping" });
    assert(ws.frames().some((f) => f.type === "pong"), "ping is answered with pong");

    // Malformed / non-string socket data is ignored without throwing.
    ws.emitRaw("}{ not json");
    ws.emitRaw(12345);
    assertEquals(refreshCount, 1);

    // Simulated reconnect: a second open with a prior connection refreshes to catch up.
    ws.fireOpen();
    assertEquals(refreshCount, 2, "a reconnect refreshes once to catch up");

    unsub();
    assert(ws.closed, "dropping the last boundary closes the socket");
  } finally {
    restore();
  }
});

Deno.test("error frames: no-policy logs an error, an unaddressed limit logs a warning", () => {
  const restore = stubLiveGlobals();
  const origError = console.error;
  const origWarn = console.warn;
  const errs: string[] = [];
  const warns: string[] = [];
  console.error = (m?: unknown) => void errs.push(String(m));
  console.warn = (m?: unknown) => void warns.push(String(m));
  try {
    // Keep a subscription so the socket stays open for the frames.
    const unsub = subscribeLiveData("act#x", [], ["t"], () => {});
    const ws = FakeWebSocket.last!;
    ws.fireOpen();

    ws.emit({ type: "error", code: "no-policy", reason: "no live policy configured" });
    assert(errs.some((e) => e.includes("no live policy configured")), "no-policy is a loud error");

    ws.emit({ type: "error", code: "limit", reason: "too many subscriptions" });
    assert(warns.some((w) => w.includes("too many subscriptions")), "an advisory code warns");

    unsub();
    assert(ws.closed);
  } finally {
    console.error = origError;
    console.warn = origWarn;
    restore();
  }
});

Deno.test("ensureSocket is a no-op without a browser location (SSR-safe)", () => {
  const g = globalThis as AnyGlobal;
  const origWs = g.WebSocket;
  const origLoc = g.location;
  g.WebSocket = FakeWebSocket;
  delete g.location; // server: no `location` ⇒ the transport must not connect
  FakeWebSocket.last = null;
  try {
    // Subscribing must not construct a socket or throw when there's no location.
    const unsub = subscribeLiveData("act#ssr", [], ["t"], () => {});
    assertEquals(FakeWebSocket.last, null);
    unsub(); // clean teardown with no socket
  } finally {
    g.WebSocket = origWs;
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
  }
});

// ---- denext/live entry (src/live.ts) ---------------------------------------

Deno.test("denext/live re-exports the live surface (and configureLive is the transport's own)", () => {
  assertStrictEquals(
    configureLiveFromEntry,
    configureLive,
    "the entry re-exports the same configureLive as the client transport",
  );
  assertEquals(typeof Live, "function");
  assertEquals(typeof useLive, "function");
  assertEquals(typeof usePresence, "function");
  assertEquals(typeof useLiveOptimistic, "function");
  assertEquals(typeof liveReadable, "function");
});

Deno.test("useLiveOptimistic seeds from the live value (via useOptimistic)", async () => {
  let snapshot: [number, (a: number) => void] | undefined;
  const Probe = () => {
    const pair = useLiveOptimistic<number, number>(7, (cur, add) => cur + add);
    snapshot = pair;
    return h("span", null, String(pair[0]));
  };
  const screen = await render(h(Probe, null));
  assertEquals(snapshot?.[0], 7);
  assertEquals(typeof snapshot?.[1], "function");
  assert(screen.html().includes("7"));
  await screen.unmount();
});
