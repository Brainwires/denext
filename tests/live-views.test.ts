// Live views (`defineLiveView`): the page render (HTML first paint, the island and its signed
// props) and the hub's live-view half (`createLiveViewHub`), driven directly with fake hub
// primitives — mount, events, patches, effects, resume, back-pressure, and every guard: a forged
// token, `authorize`, unknown handlers, the payload checks, the inbox, the view and memory caps.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { type FlightNode, renderToFlight } from "../src/jsx/render-to-flight.ts";
import {
  type ChannelTransport,
  createChannel,
  inMemoryChannelTransport,
  resetChannels,
} from "../src/runtime/channel.ts";
import { defineLiveView, signLiveViewToken } from "../src/runtime/live-view.ts";
import { fx, type Next, subs } from "../src/runtime/mvu.ts";
import { applyFlightOps } from "../src/runtime/flight-patch.ts";
import type { StandardSchemaV1 } from "../src/runtime/define-action.ts";
import {
  checkEventPayload,
  createLiveViewHub,
  HANDLER_HISTORY,
  MAX_VIEW_INBOX,
  type ViewConn,
  type ViewLimits,
} from "../src/server/live-views.ts";
import { liveViewStoreContract } from "./helpers/live-view-store-contract.ts";
import {
  enableLiveDevtools,
  resetLiveDevtools,
  viewMessageRecords,
} from "../src/server/live-devtools.ts";
import {
  type LiveViewStore,
  memoryLiveViewStore,
  openViewSnapshot,
  sealViewSnapshot,
} from "../src/server/live-view-store.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

interface Conn extends ViewConn {
  frames: Any[];
  waiters: Array<{ pred: (f: Any) => boolean; resolve: (f: Any) => void }>;
  closed?: boolean;
  pressured?: boolean;
  armed?: boolean;
  cookie: string;
}

function push(conn: Conn, frame: Any): void {
  conn.frames.push(frame);
  for (const w of [...conn.waiters]) {
    if (w.pred(frame)) {
      conn.waiters.splice(conn.waiters.indexOf(w), 1);
      w.resolve(frame);
    }
  }
}

/** The next frame (from now on) matching `pred`. */
function next(conn: Conn, pred: (f: Any) => boolean): Promise<Any> {
  return new Promise((resolve) => conn.waiters.push({ pred, resolve }));
}

const isType = (type: string) => (f: Any) => f.type === type;
const isError = (code: string) => (f: Any) => f.type === "error" && f.code === code;

function fakeHub(limits: Partial<ViewLimits> = {}, store?: LiveViewStore, bus?: ChannelTransport) {
  let contexts = 0;
  const hub = createLiveViewHub<Conn>({
    limits: () => ({
      maxViewsPerConnection: 4,
      maxViewBytesPerConnection: 64 * 1024,
      viewResumeSeconds: 30,
      maxParkedViews: 10,
      maxSubscriptionInputBytes: 1024,
      channelAuthTtlSeconds: 300,
      ...limits,
    }),
    sendFrame: (conn, text) => push(conn, JSON.parse(text)),
    sendError: (conn, code, reason, extra) => push(conn, { type: "error", code, reason, ...extra }),
    withConnContext: (_conn, fn) => {
      contexts++;
      return Promise.resolve(fn());
    },
    connContext: (conn) => ({
      origin: "http://localhost",
      url: "http://localhost/",
      cookie: conn.cookie,
      peerId: conn.peerId,
    }),
    isConnected: (conn) => !conn.closed,
    render: (_conn, fn) => fn(),
    backPressured: (conn) => conn.pressured === true,
    armRecover: (conn) => void (conn.armed = true),
    ...(store ? { store: () => store } : {}),
    // The cross-instance bus, wired as the Live hub wires it to the channel transport.
    ...(bus
      ? {
        announceResumed: (iid: string) =>
          bus.publish({ kind: "view-resumed", channelId: "", key: iid, seq: 0, instance: "" }),
      }
      : {}),
  });
  bus?.subscribe((ev) => {
    if (ev.kind === "view-resumed") hub.resumedElsewhere(ev.key);
  });
  let n = 0;
  const conn = (cookie = ""): Conn => ({
    peerId: `p${++n}`,
    origin: "http://localhost",
    views: new Map(),
    frames: [],
    waiters: [],
    cookie,
  });
  return { hub, conn, contexts: () => contexts };
}

type Msg =
  | { type: "inc" }
  | { type: "set"; to: number }
  | { type: "grow"; by: number }
  | { type: "boom" }
  | { type: "later" };

interface Model {
  n: number;
  pad: string;
}

let inits = 0;
let updates = 0;

function update(msg: Msg, m: Model): Next<Model, Msg> {
  updates++;
  switch (msg.type) {
    case "inc":
      return [{ ...m, n: m.n + 1 }];
    case "set":
      return [{ ...m, n: msg.to }];
    case "grow":
      return [{ ...m, pad: m.pad + "x".repeat(msg.by) }];
    case "boom":
      throw new Error("update blew up");
    case "later":
      return [m, [fx.task(() => Promise.resolve(99), (v) => ({ type: "set", to: v as number }))]];
  }
}

const view = (m: Model, send: Any) =>
  h(
    "div",
    null,
    h("p", null, `n=${m.n}`),
    h("button", { type: "button", onClick: send({ type: "inc" }) }, "+"),
    h("input", { onInput: send((p: Any) => ({ type: "set", to: Number(p.value) })) }),
  );

const allowed = new Set<string>(["ok"]);

const Counter = defineLiveView<Model, Msg, { start: number }>({
  id: "test-counter",
  init: (props) => {
    inits++;
    return [{ n: props.start, pad: "" }];
  },
  update,
  view,
  authorize: (_props, ctx) => ctx.connection === null || allowed.has(ctx.connection.cookie),
});

/** A hand-rolled Standard Schema: `value` must be digits. */
const digits: StandardSchemaV1<Any> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v: Any) =>
      /^\d*$/.test(v?.value ?? "")
        ? { value: v }
        : { issues: [{ message: "digits only", path: ["value"] }] },
  },
};

defineLiveView<Model, Msg, { start: number }>({
  id: "test-schema",
  init: (props) => [{ n: props.start, pad: "" }],
  update,
  view,
  events: digits,
});

async function mountFrame(view: string, props: unknown, extra: Record<string, unknown> = {}) {
  const json = JSON.stringify(props);
  return {
    type: "view-mount",
    vid: "v1",
    view,
    props: json,
    token: await signLiveViewToken(view, json),
    ...extra,
  };
}

/** Mount `test-counter` and return its first render. */
async function mounted(hub: Any, conn: Conn, start = 1, vid = "v1") {
  const rendered = next(conn, isType("view-render"));
  await hub.mount(conn, await mountFrame("test-counter", { start }, { vid }));
  return await rendered;
}

/** The text of the `<p>` in a rendered counter. */
function shown(flight: FlightNode[]): string {
  return ((flight[0] as Any).c[0] as Any).c[0];
}

Deno.test("defineLiveView: the page gets HTML for the first paint, the island and signed props", async () => {
  const html = await renderToString(h(Counter as Any, { start: 5 }));
  assertStringIncludes(html, "n=5");
  assertStringIncludes(html, 'data-dnx-view="test-counter"');
  assert(!/onclick|onClick|__dnxlv/.test(html), html);

  const flight = await renderToFlight(h(Counter as Any, { start: 5 })) as Any;
  assertEquals(flight.$, "c");
  assertEquals(flight.i, "denext#LiveView");
  assertEquals(flight.p.view, "test-counter");
  assertEquals(flight.p.props, '{"start":5}');
  assertEquals(flight.p.token, await signLiveViewToken("test-counter", '{"start":5}'));
  // The handlers travel as indexes; the messages stay on the server.
  const button = flight.c[0].c[1];
  assertEquals(button.p.onClick, { __dnxlv: 0 });
  assert(!JSON.stringify(flight).includes('"inc"'), "a message never reaches the page");

  // `authorize` runs for the page render too (no connection): false renders nothing.
  const Private = defineLiveView<Model, Msg, Record<string, never>>({
    id: "test-private",
    init: () => [{ n: 0, pad: "" }],
    update,
    view,
    authorize: () => false,
  });
  assertEquals(await renderToString(h(Private as Any, {})), "");
});

Deno.test("live views: an event runs update on the server and comes back as a patch", async () => {
  const { hub, conn } = fakeHub();
  const c = conn("ok");
  const first = await mounted(hub, c, 1);
  assertEquals(shown(first.flight), "n=1");
  assert(typeof first.iid === "string" && first.iid.length > 10);

  const patched = next(c, isType("view-patch"));
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 0 });
  const patch = await patched;
  assertEquals(patch.base, first.rev);
  assertEquals(patch.rev, first.rev + 1);
  assertEquals(patch.ops, [["r", [0, 0, 0], "n=2"]]);

  // A payload-built message: `send((p) => …)` gets the validated payload.
  const set = next(c, isType("view-patch"));
  hub.event(c, { type: "view-event", vid: "v1", rev: patch.rev, h: 1, payload: { value: "41" } });
  assertEquals((await set).ops, [["r", [0, 0, 0], "n=41"]]);
  hub.unmount(c, "v1");
  assertEquals(c.views.size, 0);
});

Deno.test("live views: effects run as the viewer and their messages re-render", async () => {
  defineLiveView<Model, Msg, Record<string, never>>({
    id: "test-later",
    init: () => [{ n: 0, pad: "" }, [fx.dispatch<Msg>({ type: "later" })]],
    update,
    view,
  });
  const { hub, conn, contexts } = fakeHub();
  const c = conn("ok");
  const rendered = next(c, isType("view-render"));
  const settled = next(c, (f) => f.type === "view-patch" && JSON.stringify(f.ops).includes("n=99"));
  const before = contexts();
  await hub.mount(c, await mountFrame("test-later", {}, { vid: "v2" }));
  await rendered;
  // init's `dispatch` effect → update → a task effect → its message → a patch.
  assertEquals((await settled).vid, "v2");
  assert(contexts() > before, "the task ran inside the connection's context");
  hub.dispose();
});

Deno.test("live views (security): a forged token or an unknown view never runs init", async () => {
  const { hub, conn } = fakeHub();
  const c = conn("ok");
  const before = inits;
  const forged = { ...(await mountFrame("test-counter", { start: 1 })), props: '{"start":1e9}' };
  const gone = next(c, isError("gone"));
  await hub.mount(c, forged);
  assertEquals((await gone).subId, "v1");
  const unknown = next(c, isError("gone"));
  await hub.mount(c, { ...(await mountFrame("nope", {})), vid: "v2" });
  assertEquals((await unknown).subId, "v2");
  const malformed = next(c, isError("bad-message"));
  await hub.mount(c, { type: "view-mount", vid: "v3", view: "test-counter", props: 1, token: "x" });
  await malformed;
  assertEquals(inits, before);
  assertEquals(c.views.size, 0);
});

Deno.test("live views (security): authorize refuses a mount, and a later event once the TTL passed", async () => {
  const { hub, conn } = fakeHub({ channelAuthTtlSeconds: 0.001 });
  const stranger = conn("stranger");
  const before = inits;
  const denied = next(stranger, isError("denied"));
  await hub.mount(stranger, await mountFrame("test-counter", { start: 1 }));
  await denied;
  assertEquals(inits, before, "init never ran for a refused viewer");

  const c = conn("revocable");
  allowed.add("revocable");
  try {
    const first = await mounted(hub, c);
    allowed.delete("revocable"); // access revoked mid-session
    await new Promise((r) => setTimeout(r, 5)); // past the 1 ms TTL
    const u = updates;
    const revoked = next(c, isError("denied"));
    hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 0 });
    await revoked;
    assertEquals(updates, u, "update never ran for the revoked viewer");
    assertEquals(c.views.size, 0, "the view ended");
  } finally {
    allowed.delete("revocable");
  }
});

Deno.test("live views (security): only handlers the server rendered can fire", async () => {
  const { hub, conn } = fakeHub();
  const c = conn("ok");
  const first = await mounted(hub, c);
  const u = updates;
  const unknown = next(c, isError("bad-message"));
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 7 });
  assertEquals((await unknown).reason, "unknown handler");
  const malformed = next(c, isError("bad-message"));
  hub.event(c, { type: "view-event", vid: "v1", rev: "1", h: 0 });
  await malformed;
  // A handler from a render the server never made (or long gone) is dropped without an answer.
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev + 50, h: 0 });
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev - HANDLER_HISTORY, h: 0 });
  // An event for a view this connection doesn't hold is ignored.
  hub.event(c, { type: "view-event", vid: "someone-elses", rev: first.rev, h: 0 });
  const after = next(c, isType("view-patch"));
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 0 });
  await after;
  assertEquals(updates, u + 1, "only the last, valid event ran update");
  hub.dispose();
});

Deno.test("live views (security): event payloads are shape-checked and schema-validated", async () => {
  assertEquals(checkEventPayload({ value: "x", checked: true, key: "a", form: { q: "1" } }), {
    value: "x",
    checked: true,
    key: "a",
    form: { q: "1" },
  });
  assertEquals(checkEventPayload(undefined), {});
  assertEquals(checkEventPayload({ value: "x".repeat(16 * 1024 + 1) }), null);
  assertEquals(checkEventPayload({ value: 1 }), null);
  assertEquals(checkEventPayload({ admin: true }), null);
  assertEquals(checkEventPayload({ form: { f: { nested: 1 } } }), null);
  assertEquals(checkEventPayload([1]), null);

  const { hub, conn } = fakeHub();
  const c = conn("ok");
  const first = await mounted(hub, c);
  const u = updates;
  const oversized = next(c, isError("invalid-input"));
  hub.event(c, {
    type: "view-event",
    vid: "v1",
    rev: first.rev,
    h: 1,
    payload: { value: "9".repeat(20_000) },
  });
  await oversized;
  const extra = next(c, isError("invalid-input"));
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 1, payload: { role: "admin" } });
  await extra;
  assertEquals(updates, u);

  // The view's own `events` schema runs next, with field errors on a rejection.
  const rendered = next(c, (f) => f.type === "view-render" && f.vid === "s1");
  await hub.mount(c, await mountFrame("test-schema", { start: 0 }, { vid: "s1" }));
  const s = await rendered;
  const rejected = next(c, isError("invalid-input"));
  hub.event(c, { type: "view-event", vid: "s1", rev: s.rev, h: 1, payload: { value: "12a" } });
  assertEquals((await rejected).fieldErrors, { value: "digits only" });
  assertEquals(updates, u);
  const ok = next(c, (f) => f.type === "view-patch" && f.vid === "s1");
  hub.event(c, { type: "view-event", vid: "s1", rev: s.rev, h: 1, payload: { value: "12" } });
  assertEquals((await ok).ops, [["r", [0, 0, 0], "n=12"]]);
  hub.dispose();
});

Deno.test("live views (security): a flood past the inbox is refused (inbound back-pressure)", async () => {
  const { hub, conn } = fakeHub();
  const c = conn("ok");
  const first = await mounted(hub, c);
  const u = updates;
  for (let i = 0; i < MAX_VIEW_INBOX + 8; i++) {
    hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 0 });
  }
  const refused = c.frames.filter((f) => f.type === "error" && f.code === "limit");
  assertEquals(refused.length, 8);
  assertEquals(refused[0].reason, "too many pending events");
  await next(c, (f) => f.type === "view-patch" && JSON.stringify(f.ops).includes(`n=${1 + 32}`));
  assertEquals(updates - u, MAX_VIEW_INBOX);
  hub.dispose();
});

Deno.test("live views (security): view count, props size and per-connection memory are capped", async () => {
  const { hub, conn } = fakeHub({ maxViewsPerConnection: 1, maxViewBytesPerConnection: 4096 });
  const c = conn("ok");
  const first = await mounted(hub, c);
  const tooMany = next(c, isError("limit"));
  await hub.mount(c, await mountFrame("test-counter", { start: 2 }, { vid: "v2" }));
  assertEquals((await tooMany).reason, "too many views");

  const big = next(c, isError("limit"));
  await hub.mount(c, {
    ...(await mountFrame("test-counter", { start: 1, pad: "x".repeat(2000) })),
    vid: "v1",
  });
  assertEquals((await big).reason, "view props too large");

  // An update that grows the model past the connection's budget ends the view.
  const grown = next(c, isError("limit"));
  const grow = defineLiveView<Model, Msg, Record<string, never>>({
    id: "test-grow",
    init: () => [{ n: 0, pad: "" }],
    update,
    view: (m, send) =>
      h("button", { onClick: send({ type: "grow", by: 5000 }) }, String(m.pad.length)),
  });
  void grow;
  hub.unmount(c, "v1");
  const rendered = next(c, isType("view-render"));
  await hub.mount(c, await mountFrame("test-grow", {}, { vid: "g1" }));
  const g = await rendered;
  hub.event(c, { type: "view-event", vid: "g1", rev: g.rev, h: 0 });
  assertEquals((await grown).reason, "view state too large");
  assertEquals(c.views.size, 0, "the over-budget view was dropped from the connection");
  void first;
});

Deno.test("live views: a throwing update is reported and the model kept", async () => {
  const { hub, conn } = fakeHub();
  const c = conn("ok");
  const Boom = defineLiveView<Model, Msg, Record<string, never>>({
    id: "test-boom",
    init: () => [{ n: 3, pad: "" }],
    update,
    view: (m, send) =>
      h("div", null, h("p", null, `n=${m.n}`), h("button", { onClick: send({ type: "boom" }) })),
  });
  void Boom;
  const rendered = next(c, isType("view-render"));
  await hub.mount(c, await mountFrame("test-boom", {}, { vid: "b1" }));
  const r = await rendered;
  const original = console.error;
  console.error = () => {};
  try {
    const failed = next(c, isError("failed"));
    hub.event(c, { type: "view-event", vid: "b1", rev: r.rev, h: 0 });
    await failed;
  } finally {
    console.error = original;
  }
  assertEquals(c.views.size, 1, "the view keeps running on its last good model");
  hub.dispose();
});

Deno.test("live views: a back-pressured socket gets one whole render once it drains", async () => {
  const { hub, conn } = fakeHub();
  const c = conn("ok");
  const first = await mounted(hub, c);
  c.pressured = true;
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 0 });
  hub.event(c, { type: "view-event", vid: "v1", rev: first.rev, h: 0 });
  await new Promise<void>((resolve) => {
    const check = () => (c.armed ? resolve() : queueMicrotask(check));
    check();
  });
  assert(!c.frames.some((f) => f.type === "view-patch"), "nothing queued per patch");
  c.pressured = false;
  const whole = next(c, isType("view-render"));
  // The render loop may still be finishing; let it settle, then drain.
  await new Promise((r) => setTimeout(r, 0));
  hub.replayPending(c);
  const r = await whole;
  assertEquals(shown(r.flight), "n=3");
  assert(r.rev > first.rev);
  // A client that can't apply a patch asks for a resync: the whole tree again.
  const again = next(c, isType("view-render"));
  hub.resync(c, "v1");
  assertEquals(shown((await again).flight), "n=3");
  hub.dispose();
});

Deno.test("live views: a dropped connection's views resume on reconnect, else re-init", async () => {
  const { hub, conn } = fakeHub({ maxParkedViews: 1 });
  const a = conn("ok");
  const first = await mounted(hub, a, 1);
  const patched = next(a, isType("view-patch"));
  hub.event(a, { type: "view-event", vid: "v1", rev: first.rev, h: 0 }); // n=2
  await patched;
  a.closed = true;
  hub.drop(a);
  assertEquals(hub.parked(), 1);

  const b = conn("ok");
  const resumed = next(b, isType("view-render"));
  await hub.mount(b, await mountFrame("test-counter", { start: 1 }, { resume: first.iid }));
  const r = await resumed;
  assertEquals(shown(r.flight), "n=2", "the model survived the reconnect");
  assertEquals(r.iid, first.iid);
  assertEquals(hub.parked(), 0);

  // Different signed props never adopt a parked instance: they get a fresh init.
  b.closed = true;
  hub.drop(b);
  const d = conn("ok");
  const fresh = next(d, isType("view-render"));
  await hub.mount(d, await mountFrame("test-counter", { start: 7 }, { resume: first.iid }));
  assertEquals(shown((await fresh).flight), "n=7");

  // At most maxParkedViews wait: parking another evicts the oldest.
  const e = conn("ok");
  await mounted(hub, e, 1, "e1");
  d.closed = true;
  e.closed = true;
  hub.drop(d);
  hub.drop(e);
  assertEquals(hub.parked(), 1);
  hub.dispose();
  assertEquals(hub.parked(), 0);
});

Deno.test("live views: a channel subscription feeds messages after the channel's authorize", async () => {
  resetChannels();
  const ch = createChannel<{ n: number }>({ id: "lv-chan", authorize: (_ctx, key) => key === "k" });
  defineLiveView<Model, Msg, { key: string }>({
    id: "test-chan",
    init: () => [{ n: 0, pad: "" }],
    update,
    view,
    subscriptions: () => [subs.channel(ch, "k", (p) => ({ type: "set", to: p.n }))],
  });
  const { hub, conn } = fakeHub();
  const c = conn("ok");
  try {
    const rendered = next(c, isType("view-render"));
    await hub.mount(c, await mountFrame("test-chan", { key: "k" }, { vid: "c1" }));
    await rendered;
    const patched = next(
      c,
      (f) => f.type === "view-patch" && JSON.stringify(f.ops).includes("n=7"),
    );
    // The tap is authorized asynchronously; publish until it lands.
    let landed = false;
    void patched.then(() => (landed = true));
    while (!landed) {
      await ch.publish("k", { n: 7 });
      await new Promise((r) => setTimeout(r, 5));
    }
    await patched;
  } finally {
    hub.dispose();
    resetChannels();
  }
});

/** A sealed snapshot's bytes as text (what anyone reading the store sees). */
function plainText(sealed: string): string {
  return atob(
    sealed.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - sealed.length % 4) % 4),
  );
}

Deno.test("live views: a shared store resumes a dropped view on another instance", async () => {
  const store = memoryLiveViewStore();
  const writes: string[] = [];
  let wrote = () => {};
  const written = () => new Promise<void>((resolve) => (wrote = resolve));
  const spy: LiveViewStore = {
    set: async (id, sealed, ttl) => {
      writes.push(sealed);
      await store.set(id, sealed, ttl);
      wrote();
    },
    take: (id) => store.take(id),
    delete: (id) => store.delete(id),
  };
  const instanceA = fakeHub({}, spy);
  const instanceB = fakeHub({}, spy);
  const a = instanceA.conn("ok");
  const first = await mounted(instanceA.hub, a, 1);
  for (const n of [2, 3]) {
    const patched = next(a, isType("view-patch"));
    instanceA.hub.event(a, { type: "view-event", vid: "v1", rev: first.rev + n - 2, h: 0 });
    await patched;
  }
  a.closed = true;
  const firstWrite = written();
  instanceA.hub.drop(a);
  await firstWrite; // the sealed write lands
  assertEquals(writes.length, 1);
  assert(!plainText(writes[0]).includes('"n":3'), "the store holds no readable model");

  const initsBefore = inits;
  const b = instanceB.conn("ok");
  const resumed = next(b, isType("view-render"));
  await instanceB.hub.mount(
    b,
    await mountFrame("test-counter", { start: 1 }, { resume: first.iid }),
  );
  const r = await resumed;
  assertEquals(shown(r.flight), "n=3", "the model came over from instance A");
  assertEquals(inits, initsBefore, "init did not run again");
  assert(r.iid !== first.iid, "the resumed view gets a new instance id");
  // The snapshot was taken: it resumes once, and the view keeps working on B.
  assertEquals(await store.take(first.iid), null);
  const patched = next(b, isType("view-patch"));
  instanceB.hub.event(b, { type: "view-event", vid: "v1", rev: r.rev, h: 0 });
  assertEquals(shown(applyFlightOps(r.flight, (await patched).ops)), "n=4");

  // Other signed props never adopt a stored snapshot: they run init.
  b.closed = true;
  const secondWrite = written();
  instanceB.hub.drop(b);
  await secondWrite;
  const c = instanceA.conn("ok");
  const fresh = next(c, isType("view-render"));
  await instanceA.hub.mount(c, await mountFrame("test-counter", { start: 9 }, { resume: r.iid }));
  assertEquals(shown((await fresh).flight), "n=9");
  await Promise.all([instanceA.hub.settled(), instanceB.hub.settled()]);
  instanceA.hub.dispose();
  instanceB.hub.dispose();
});

Deno.test("live views: settled() waits for a parked view's snapshot write to land", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const landed: string[] = [];
  const store = memoryLiveViewStore();
  const slow: LiveViewStore = {
    set: async (id, sealed, ttl) => {
      await gate;
      await store.set(id, sealed, ttl);
      landed.push(id);
    },
    take: (id) => store.take(id),
    delete: (id) => store.delete(id),
  };
  const { hub, conn } = fakeHub({}, slow);
  await hub.settled(); // nothing queued: settles at once
  const a = conn("ok");
  const first = await mounted(hub, a, 1);
  a.closed = true;
  hub.drop(a); // parks the view and queues its sealed write
  let settled = false;
  const done = hub.settled().then(() => void (settled = true));
  await new Promise((r) => setTimeout(r, 0));
  assertEquals([settled, landed], [false, []], "still writing");
  release();
  await done;
  assertEquals(landed, [first.iid]);
  hub.dispose();
});

Deno.test("live view snapshots: sealed, bound to their instance id, models must serialize", async () => {
  const sealed = await sealViewSnapshot("iid-1", {
    view: "v",
    signed: "v\0tok",
    model: { secret: "hunter2", at: new Date(5), tags: new Set(["a"]) },
  });
  assert(!plainText(sealed).includes("hunter2"));
  const opened = await openViewSnapshot("iid-1", sealed);
  assertEquals(opened?.model, { secret: "hunter2", at: new Date(5), tags: new Set(["a"]) });
  assertEquals(await openViewSnapshot("iid-2", sealed), null, "moved to another id: refused");
  assertEquals(await openViewSnapshot("iid-1", sealed.slice(0, -4) + "AAAA"), null, "tampered");
  let threw = false;
  try {
    await sealViewSnapshot("iid-1", { view: "v", signed: "s", model: { f: () => 1 } });
  } catch {
    threw = true;
  }
  assert(threw, "a function in the model is not storable");
});

Deno.test("memoryLiveViewStore keeps the LiveViewStore contract and its cap", async (t) => {
  await liveViewStoreContract(t, () => memoryLiveViewStore());
  const store = memoryLiveViewStore({ maxEntries: 2 });
  for (const id of ["a", "b", "c"]) await store.set(id, id, 60);
  assertEquals(await store.take("a"), null, "the oldest went past the cap");
  assertEquals(await store.take("c"), "c");
});

Deno.test("live views: inspect lists attached and parked views with the model redacted", async () => {
  enableLiveDevtools();
  try {
    const { hub, conn } = fakeHub();
    const a = conn("ok");
    const first = await mounted(hub, a, 1);
    const patched = next(a, isType("view-patch"));
    hub.event(a, { type: "view-event", vid: "v1", rev: first.rev, h: 0 });
    await patched;
    const [attached] = hub.inspect();
    assertEquals(attached.view, "test-counter");
    assertEquals(attached.state, "attached");
    assertEquals(attached.model, { n: 2, pad: "string(0)" });
    a.closed = true;
    hub.drop(a);
    assertEquals(hub.inspect().map((v) => v.state), ["parked"]);
    const recorded = viewMessageRecords().filter((r) => r.iid === first.iid);
    assertEquals(recorded.at(-1)?.msgs, [{ type: "string(3)" }]);
    hub.dispose();
    assertEquals(hub.inspect(), []);
  } finally {
    resetLiveDevtools();
  }
});

defineLiveView<Model, Msg, { start: number }>({
  id: "test-ticker",
  init: (props) => [{ n: props.start, pad: "" }],
  update,
  view,
  subscriptions: () => [subs.interval(100, { type: "inc" })],
});

Deno.test("live views: a view resumed on another instance stops the copy parked on the first", async () => {
  const store = memoryLiveViewStore();
  const writes: string[] = [];
  const spy: LiveViewStore = {
    set: async (id, sealed, ttl) => {
      writes.push(id);
      await store.set(id, sealed, ttl);
    },
    take: (id) => store.take(id),
    delete: (id) => store.delete(id),
  };
  const bus = inMemoryChannelTransport();
  const instanceA = fakeHub({}, spy, bus);
  const instanceB = fakeHub({}, spy, bus);
  const a = instanceA.conn("ok");
  const rendered = next(a, isType("view-render"));
  await instanceA.hub.mount(a, await mountFrame("test-ticker", { start: 1 }));
  const first = await rendered;
  a.closed = true;
  instanceA.hub.drop(a);
  assertEquals(instanceA.hub.parked(), 1);
  // The parked ticker keeps running on A, rewriting its snapshot as the model changes.
  while (writes.length < 2) await new Promise((r) => setTimeout(r, 20));

  // A resume on B for an instance A does not hold changes nothing on A.
  bus.publish({
    kind: "view-resumed",
    channelId: "",
    key: "not-parked-here",
    seq: 0,
    instance: "",
  });
  assertEquals(instanceA.hub.parked(), 1);

  const b = instanceB.conn("ok");
  const resumed = next(b, isType("view-render"));
  await instanceB.hub.mount(
    b,
    await mountFrame("test-ticker", { start: 1 }, { resume: first.iid }),
  );
  const r = await resumed;
  assert(r.iid !== first.iid, "B resumed the stored model under its own instance id");
  assertEquals(instanceA.hub.parked(), 0, "A dropped its parked copy at once");
  assertEquals(instanceA.hub.inspect(), [], "and stopped it");
  assertEquals(instanceB.hub.inspect().length, 1);

  // A's stopped copy ticks no more: no further store writes (B's view is attached, so it
  // writes none either), and no snapshot for the old instance id reappears.
  const settled = writes.length;
  await new Promise((r) => setTimeout(r, 350));
  assertEquals(writes.slice(settled), []);
  assertEquals(await store.take(first.iid), null);
  instanceA.hub.dispose();
  instanceB.hub.dispose();
});
