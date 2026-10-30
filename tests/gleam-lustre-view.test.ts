// Lustre server components over denext Live (`defineLustreView`): the page render, the server kit
// around Lustre's `Runtime` (constructed directly, guarded after shutdown), and the hub's Lustre
// half (`createLustreViewHub`) driven with fake hub primitives — mount, events, patches, resume,
// back-pressure, and every guard: a forged or cross-namespace token, `authorize` at mount and on
// its TTL, the event shape check and schema, Lustre's own decoder, the inbox, the view and size
// caps, and one connection's events never reaching another's view. Lustre itself is the fake in
// tests/helpers/fake-lustre-server.ts; the real runtime runs in tests/e2e/lustre.e2e.test.ts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import type { StandardSchemaV1 } from "../src/runtime/define-action.ts";
import { signLiveViewToken } from "../src/runtime/live-view.ts";
import { defineLustreView, lustreServerKit, lustreViewIsland } from "../src/gleam.ts";
import { lustreTokenName } from "../src/lustre/view.ts";
import type { LustreEventPayload } from "../src/lustre/view.ts";
import {
  checkLustreEvent,
  createLustreViewHub,
  type LustreConn,
  MAX_LUSTRE_INBOX,
} from "../src/server/lustre-views.ts";
import type { ViewLimits } from "../src/server/view-hub-common.ts";
import { counterApp, fakeLustreServerModules, fakeRuntimes } from "./helpers/fake-lustre-server.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const kit = lustreServerKit(fakeLustreServerModules());

interface Conn extends LustreConn {
  frames: Any[];
  waiters: Array<{ pred: (f: Any) => boolean; resolve: (f: Any) => void }>;
  closed?: boolean;
  pressured?: boolean;
  armed?: boolean;
  cookie: string;
}

/** Deliver a frame to the first waiter it matches, else keep it for a later `next`. */
function push(conn: Conn, frame: Any): void {
  const waiter = conn.waiters.find((w) => w.pred(frame));
  if (!waiter) return void conn.frames.push(frame);
  conn.waiters.splice(conn.waiters.indexOf(waiter), 1);
  waiter.resolve(frame);
}

/** The next frame (already received or from now on) matching `pred`. */
function next(conn: Conn, pred: (f: Any) => boolean): Promise<Any> {
  const seen = conn.frames.find(pred);
  if (seen) {
    conn.frames.splice(conn.frames.indexOf(seen), 1);
    return Promise.resolve(seen);
  }
  return new Promise((resolve) => conn.waiters.push({ pred, resolve }));
}

const isError = (code: string) => (f: Any) => f.type === "error" && f.code === code;
const isLustre = (kind: number) => (f: Any) => f.type === "lustre" && f.msg?.kind === kind;

function fakeHub(limits: Partial<ViewLimits> = {}) {
  const hub = createLustreViewHub<Conn>({
    limits: () => ({
      maxViewsPerConnection: 4,
      maxViewBytesPerConnection: 64 * 1024,
      viewResumeSeconds: 30,
      maxParkedViews: 10,
      maxSubscriptionInputBytes: 1024,
      channelAuthTtlSeconds: 300,
      viewTokenMaxAgeSeconds: 86_400,
      ...limits,
    }),
    sendFrame: (conn, text) => push(conn, JSON.parse(text)),
    sendError: (conn, code, reason, extra) => push(conn, { type: "error", code, reason, ...extra }),
    withConnContext: (_conn, fn) => Promise.resolve(fn()),
    connContext: (conn) => ({
      origin: "http://localhost",
      url: "http://localhost/",
      cookie: conn.cookie,
      peerId: conn.peerId,
    }),
    isConnected: (conn) => !conn.closed,
    backPressured: (conn) => conn.pressured === true,
    armRecover: (conn) => void (conn.armed = true),
  });
  let n = 0;
  const conn = (cookie = ""): Conn => ({
    peerId: `p${++n}`,
    lustreViews: new Map(),
    frames: [],
    waiters: [],
    cookie,
  });
  return { hub, conn };
}

let ids = 0;
/** A fresh view id for each test (the registry is module-global). */
const freshId = () => `lustre-test-${++ids}`;

/** A view with an `authorize` that reads the connection's cookie (`deny` refuses). */
function counterView(extra: Partial<Parameters<typeof defineLustreView<number, Any>>[0]> = {}) {
  const id = freshId();
  const View = defineLustreView<number, { start: number }>({
    id,
    kit,
    app: counterApp,
    flags: (props) => props.start,
    authorize: (_props, ctx) => !ctx.connection?.cookie.includes("deny"),
    ...extra,
  });
  return { id, View };
}

/**
 * When the page "rendered" every frame's token: tokens carry their issue time in seconds, and a
 * resume carries the token of the page it resumes, so every frame signs at the same instant.
 */
const SIGNED_AT = Date.now();

/** The `lustre-mount` frame the island would send for `props`. */
async function mountFrame(
  id: string,
  props: unknown,
  vid = "l1",
  resume?: string,
  signedAt = SIGNED_AT,
) {
  const json = JSON.stringify(props);
  const token = await signLiveViewToken(lustreTokenName(id), json, signedAt);
  return { type: "lustre-mount", vid, view: id, props: json, token, ...(resume ? { resume } : {}) };
}

const click = (vid = "l1") => ({
  type: "lustre-event",
  vid,
  msg: { kind: 1, path: "0", name: "click", event: {} },
});

Deno.test("defineLustreView: the page renders the first view in the island with signed props", async () => {
  const { id, View } = counterView();
  const html = await renderToString(h(View as Any, { start: 7 }));
  assert(html.startsWith(`<lustre-view data-view="${id}" data-token="`), html);
  assert(html.endsWith(">&lt;p&gt;7&lt;/p&gt;</lustre-view>"), html);
  assertEquals((View as Any).denextLustreViewId, id);
  // `authorize` false: nothing on the page.
  const { View: Hidden } = counterView({ authorize: () => false });
  assertEquals(await renderToString(h(Hidden as Any, { start: 1 })), "");
  assertThrows(() => defineLustreView({ id: "", kit, app: counterApp }), TypeError);
});

Deno.test("defineLustreView: a second copy of the modules sees the view and its token (a compat build)", async () => {
  // A compat build prebuilds denext/gleam into its own graph: the app defines its view in one
  // copy of these modules while the server's Live hub reads another. Both share one registry and
  // one per-process signing key.
  const copy = `?copy=${crypto.randomUUID()}`;
  const view2 = await import(new URL(`../src/lustre/view.ts${copy}`, import.meta.url).href);
  const live2 = await import(new URL(`../src/runtime/live-view.ts${copy}`, import.meta.url).href);
  const id = `shared-${crypto.randomUUID()}`;
  defineLustreView({ id, kit, app: counterApp });
  assert(view2.getLustreView(id), "the other copy finds the view");
  const token = await signLiveViewToken(lustreTokenName(id), "{}");
  assert(await live2.verifyLiveViewToken(lustreTokenName(id), "{}", token), "and its token");
});

Deno.test("lustreViewIsland: the server renders the first paint inside the view's root", async () => {
  const Island = lustreViewIsland(
    class {
      mount() {}
      push() {}
    },
  );
  const html = await renderToString(
    h(Island, { view: "counter", props: "{}", token: "t", html: "<p>7</p>" }),
  );
  assertEquals(html, '<div data-dnx-lustre-view="counter"><p>7</p></div>');
});

Deno.test("lustreServerKit: Runtime built directly (no argument shift), guarded after stop, errors reported", () => {
  fakeRuntimes.constructed.length = 0;
  const errors: unknown[] = [];
  const rt = kit.start(counterApp, 3, (e) => errors.push(e));
  const [first, init, update, view, config, flags] = fakeRuntimes.constructed[0];
  assertEquals(first, undefined, "the constructor's first slot is unused");
  assertEquals([init, update, view, flags], [
    counterApp.init,
    counterApp.update,
    counterApp.view,
    3,
  ]);
  assertEquals(config, { configured: counterApp.config });

  const got: unknown[] = [];
  const disconnect = kit.connect(rt, (m) => got.push(m));
  assertEquals(got, [{ kind: 0, vdom: "3" }]);
  assert(kit.receive(rt, { kind: 1, path: "0", name: "click", event: {} }));
  assertEquals(got.at(-1), { kind: 1, patch: { text: "4" } });
  assertEquals(kit.receive(rt, { kind: 7 }), false, "Lustre's decoder refuses it");
  kit.receive(rt, { kind: 1, path: "0", name: "boom", event: {} });
  assertEquals((errors[0] as Error).message, "update blew up", "an update error reaches onError");
  disconnect();
  kit.stop(rt);
  // Lustre throws on a message after shutdown (an effect's late dispatch); the kit drops it.
  (rt as unknown as { send(m: unknown): void }).send({ t: "dispatch", msg: { name: "click" } });
  assertEquals(errors.length, 1);
  assertEquals(kit.render(counterApp, 9), "<p>9</p>");
});

Deno.test("lustreServerKit: a Runtime whose constructor dropped the unused first parameter gets no placeholder", () => {
  const got: unknown[][] = [];
  // A later Lustre's shape: `constructor(init, update, view, config, flags)` (five declared).
  class FiveArgRuntime {
    constructor(init: unknown, update: unknown, view: unknown, config: unknown, flags: unknown) {
      got.push([init, update, view, config, flags]);
    }
    send(_message: unknown): void {}
  }
  const five = lustreServerKit({
    ...fakeLustreServerModules(),
    Runtime: FiveArgRuntime as never,
  });
  five.start(counterApp, 4, () => {});
  assertEquals(got, [[
    counterApp.init,
    counterApp.update,
    counterApp.view,
    { configured: counterApp.config },
    4,
  ]]);
});

Deno.test("checkLustreEvent: only EventFired, a bounded path and name, small plain JSON", () => {
  const ok = { kind: 1 as const, path: "0\t2", name: "click", event: { target: { value: "x" } } };
  assertEquals(checkLustreEvent(ok), ok);
  assertEquals(checkLustreEvent({ ...ok, event: undefined }), { ...ok, event: {} });
  for (
    const bad of [
      null,
      [],
      { ...ok, kind: 0 }, // attribute changed: not something denext's client sends
      { ...ok, kind: 3 }, // a batch
      { ...ok, path: 5 },
      { ...ok, path: "0".repeat(2000) },
      { ...ok, name: "on click" },
      { ...ok, name: "" },
      { ...ok, event: "text" },
      { ...ok, event: { big: "x".repeat(20_000) } },
      { ...ok, event: JSON.parse('{"__proto__": {"polluted": true}}') },
      { ...ok, event: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } },
      { ...ok, event: { n: Infinity } },
    ]
  ) {
    assertEquals(checkLustreEvent(bad), null, JSON.stringify(bad));
  }
});

Deno.test("Lustre hub: mount streams the view; events patch it; a no-op event sends nothing", async () => {
  const { hub, conn } = fakeHub();
  const { id } = counterView();
  const c = conn();
  await hub.mount(c, await mountFrame(id, { start: 5 }));
  const mount = await next(c, isLustre(0));
  assertEquals(mount.vid, "l1");
  assertEquals(mount.msg.vdom, "5");
  assert(typeof mount.iid === "string" && mount.iid.length > 0);
  hub.event(c, click());
  assertEquals((await next(c, isLustre(1))).msg.patch, { text: "6" });
  hub.event(c, { type: "lustre-event", vid: "l1", msg: { kind: 1, path: "0", name: "noop" } });
  hub.event(c, click());
  assertEquals((await next(c, isLustre(1))).msg.patch, { text: "7" }, "the no-op sent nothing");
  assertEquals(c.frames.filter((f) => f.type === "lustre").length, 0);
  hub.unmount(c, "l1");
  assertEquals(hub.running(), 0);
});

Deno.test("Lustre hub: forged, cross-namespace and unknown tokens are `gone`; authorize denies", async () => {
  const { hub, conn } = fakeHub();
  const { id } = counterView();
  const c = conn();
  const frame = await mountFrame(id, { start: 5 });
  await hub.mount(c, { ...frame, props: JSON.stringify({ start: 500 }) }); // props swapped
  assertEquals((await next(c, isError("gone"))).subId, "l1");
  // A token signed for a defineLiveView of the same id does not mount the Lustre view.
  const liveToken = await signLiveViewToken(id, frame.props);
  await hub.mount(c, { ...frame, token: liveToken });
  await next(c, isError("gone"));
  await hub.mount(c, { ...frame, view: "no-such-view" });
  await next(c, isError("gone"));
  const denied = conn("session=deny");
  await hub.mount(denied, frame);
  await next(denied, isError("denied"));
  const { id: throwing } = counterView({
    authorize: () => {
      throw new Error("db down");
    },
  });
  await hub.mount(c, await mountFrame(throwing, { start: 1 }, "l2"));
  assertEquals((await next(c, isError("denied"))).subId, "l2");
  await hub.mount(c, { type: "lustre-mount", vid: "l3", view: id, props: 1, token: "t" });
  await next(c, isError("bad-message"));
  assertEquals(hub.running(), 0, "nothing started");
});

Deno.test("Lustre hub: event guards (shape, schema, decoder, inbox) and no cross-connection events", async () => {
  const { hub, conn } = fakeHub();
  const schema: StandardSchemaV1<LustreEventPayload> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) => {
        const e = v as LustreEventPayload;
        return e.name === "forbidden"
          ? { issues: [{ message: "not allowed", path: ["name"] }] }
          : { value: e };
      },
    },
  };
  const { id } = counterView({ events: schema });
  const a = conn();
  const b = conn();
  await hub.mount(a, await mountFrame(id, { start: 1 }));
  await next(a, isLustre(0));
  await hub.mount(b, await mountFrame(id, { start: 100 }));
  await next(b, isLustre(0));

  hub.event(a, { type: "lustre-event", vid: "l1", msg: { kind: 0, name: "x", value: "y" } });
  await next(a, isError("invalid-input"));
  hub.event(a, { type: "lustre-event", vid: "l1", msg: { kind: 1, path: "0", name: "forbidden" } });
  assertEquals((await next(a, isError("invalid-input"))).reason, "invalid event payload");

  // b's frames name only b's own views: its `l1` is its own runtime, never a's.
  hub.event(b, click());
  assertEquals((await next(b, isLustre(1))).msg.patch, { text: "101" });
  hub.event(b, click("l9")); // no such view on b: ignored
  hub.event(a, click());
  assertEquals((await next(a, isLustre(1))).msg.patch, { text: "2" }, "a's count is a's alone");

  // The inbox: events queue behind an async check; past the cap they are refused.
  for (let i = 0; i < MAX_LUSTRE_INBOX + 3; i++) hub.event(a, click());
  assertEquals((await next(a, isError("limit"))).reason, "too many pending events");
  hub.dispose();
  assertEquals(hub.running(), 0);
});

Deno.test("Lustre hub: Lustre's decoder refusing an event is bad-message; an update error is `failed`", async () => {
  const { hub, conn } = fakeHub();
  const view = counterView();
  const c = conn();
  await hub.mount(c, await mountFrame(view.id, { start: 1 }));
  await next(c, isLustre(0));
  const error = console.error;
  console.error = () => {};
  try {
    const undecodable = { kind: 1, path: "0", name: "undecodable" };
    hub.event(c, { type: "lustre-event", vid: "l1", msg: undecodable });
    assertEquals((await next(c, isError("bad-message"))).reason, "undecodable event");
    hub.event(c, { type: "lustre-event", vid: "l1", msg: { kind: 1, path: "0", name: "boom" } });
    assertEquals((await next(c, isError("failed"))).subId, "l1");
    hub.event(c, click());
    assertEquals((await next(c, isLustre(1))).msg.patch, { text: "2" }, "still running");
  } finally {
    console.error = error;
  }
  hub.dispose();
});

Deno.test("Lustre hub: caps on views per connection, props size and the view's size", async () => {
  const { hub, conn } = fakeHub({ maxViewsPerConnection: 2, maxSubscriptionInputBytes: 64 });
  const { id } = counterView();
  const c = conn();
  await hub.mount(c, await mountFrame(id, { start: 1 }, "l1"));
  await hub.mount(c, await mountFrame(id, { start: 2 }, "l2"));
  await hub.mount(c, await mountFrame(id, { start: 3 }, "l3"));
  assertEquals((await next(c, isError("limit"))).reason, "too many views");
  await hub.mount(c, await mountFrame(id, { start: 1, pad: "x".repeat(100) }, "l1"));
  assertEquals((await next(c, isError("limit"))).reason, "view props too large");
  hub.dispose();

  const small = fakeHub({ maxViewBytesPerConnection: 120 });
  const d = small.conn();
  await small.hub.mount(d, await mountFrame(id, { start: 1 }, "l1"));
  await next(d, isLustre(0));
  await small.hub.mount(d, await mountFrame(id, { start: 2 }, "l2"));
  assertEquals((await next(d, isError("limit"))).reason, "view state too large");
  assertEquals(small.hub.running(), 1, "the view over budget was stopped");
  small.hub.dispose();
});

Deno.test("Lustre hub: authorize re-runs every TTL and ends a view whose viewer lost access", async () => {
  const { hub, conn } = fakeHub({ channelAuthTtlSeconds: 0.02 });
  let allowed = true;
  const { id } = counterView({ authorize: () => allowed });
  const c = conn();
  await hub.mount(c, await mountFrame(id, { start: 1 }));
  await next(c, isLustre(0));
  allowed = false;
  const denied = await next(c, isError("denied")); // from the timer: no event needed
  assertEquals(denied.subId, "l1");
  assertEquals(hub.running(), 0, "its runtime is stopped");
});

Deno.test("Lustre hub: back-pressure drops patches and re-mounts once the socket drains", async () => {
  const { hub, conn } = fakeHub();
  const { id } = counterView();
  const c = conn();
  await hub.mount(c, await mountFrame(id, { start: 1 }));
  await next(c, isLustre(0));
  c.pressured = true;
  hub.event(c, click());
  hub.event(c, click());
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.resolve();
  assert(c.armed, "drain recovery armed");
  assertEquals(c.frames.filter((f) => f.type === "lustre").length, 0, "nothing queued");
  c.pressured = false;
  hub.event(c, click()); // still behind: its patch is not sent either
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(c.frames.filter((f) => f.type === "lustre").length, 0);
  hub.replayPending(c);
  const remount = await next(c, isLustre(0));
  assertEquals(remount.msg.vdom, "4", "one fresh mount carries every update");
  hub.event(c, click());
  assertEquals((await next(c, isLustre(1))).msg.patch, { text: "5" });
  hub.dispose();
});

Deno.test("Lustre hub: a dropped connection parks the runtime; a resume reattaches it, others re-init", async () => {
  const { hub, conn } = fakeHub({ viewResumeSeconds: 30, maxParkedViews: 1 });
  const { id } = counterView();
  const a = conn();
  await hub.mount(a, await mountFrame(id, { start: 1 }));
  const { iid } = await next(a, isLustre(0));
  hub.event(a, click());
  await next(a, isLustre(1));
  hub.drop(a);
  assertEquals([hub.running(), hub.parked()], [1, 1]);

  const b = conn();
  await hub.mount(b, await mountFrame(id, { start: 1 }, "l7", iid));
  const resumed = await next(b, isLustre(0));
  assertEquals([resumed.iid, resumed.msg.vdom], [iid, "2"], "same runtime, model kept");
  assertEquals(hub.parked(), 0);

  // A resume for other props (another signed token) never takes it: init runs again.
  hub.drop(b);
  const c = conn();
  await hub.mount(c, await mountFrame(id, { start: 50 }, "l1", iid));
  const fresh = await next(c, isLustre(0));
  assert(fresh.iid !== iid);
  assertEquals(fresh.msg.vdom, "50");

  // maxParkedViews: parking a second evicts (stops) the oldest.
  hub.drop(c);
  assertEquals([hub.running(), hub.parked()], [1, 1]);
  hub.dispose();
  assertEquals([hub.running(), hub.parked()], [0, 0]);
});

Deno.test("Lustre hub: a resume matches the props a fresh token signs, not the token", async () => {
  const { hub, conn } = fakeHub({ viewResumeSeconds: 30, viewTokenMaxAgeSeconds: 600 });
  const { id } = counterView();
  // Parked under the token the page carried (two minutes old); the reconnects below carry a
  // token issued when the page re-rendered (SIGNED_AT).
  const a = conn("viewer");
  await hub.mount(a, await mountFrame(id, { start: 1 }, "l1", undefined, SIGNED_AT - 120_000));
  const { iid } = await next(a, isLustre(0));
  hub.event(a, click());
  await next(a, isLustre(1));
  hub.drop(a);
  assertEquals(hub.parked(), 1);

  // Another viewer under a valid fresh token: init, and the runtime stays parked.
  const b = conn("other");
  await hub.mount(b, await mountFrame(id, { start: 1 }, "l1", iid));
  const other = await next(b, isLustre(0));
  assert(other.iid !== iid);
  assertEquals([other.msg.vdom, hub.parked()], ["1", 1]);

  // Other props under a valid fresh token: init, and the runtime stays parked.
  const c = conn("viewer");
  await hub.mount(c, await mountFrame(id, { start: 8 }, "l1", iid));
  assertEquals([(await next(c, isLustre(0))).msg.vdom, hub.parked()], ["8", 1]);

  // An expired token is `gone` before any resume.
  const d = conn("viewer");
  await hub.mount(d, await mountFrame(id, { start: 1 }, "l1", iid, SIGNED_AT - 3_600_000));
  assertEquals((await next(d, isError("gone"))).subId, "l1");
  assertEquals(hub.parked(), 1);

  // The same viewer and props under the fresh token reattach the parked runtime.
  const e = conn("viewer");
  await hub.mount(e, await mountFrame(id, { start: 1 }, "l1", iid));
  const resumed = await next(e, isLustre(0));
  assertEquals([resumed.iid, resumed.msg.vdom, hub.parked()], [iid, "2", 0]);
  hub.dispose();
});

Deno.test("Lustre hub: a parked runtime is shut down when its resume window ends", async () => {
  const { hub, conn } = fakeHub({ viewResumeSeconds: 0.01 });
  const { id } = counterView();
  const c = conn();
  await hub.mount(c, await mountFrame(id, { start: 1 }));
  await next(c, isLustre(0));
  const before = fakeRuntimes.live.size;
  const shut = new Promise<void>((resolve) => (fakeRuntimes.onShutdown = resolve));
  hub.drop(c);
  await shut;
  fakeRuntimes.onShutdown = null;
  assertEquals([hub.running(), hub.parked()], [0, 0]);
  assertEquals(fakeRuntimes.live.size, before - 1, "the Lustre runtime itself shut down");
});

Deno.test("Lustre hub: many sessions opened and closed leave no runtime, timer or parked view", async () => {
  const { hub, conn } = fakeHub({ viewResumeSeconds: 30, maxParkedViews: 50 });
  const { id } = counterView();
  const startLive = fakeRuntimes.live.size;
  for (let round = 0; round < 200; round++) {
    const c = conn();
    await hub.mount(c, await mountFrame(id, { start: round }));
    hub.event(c, click());
    await next(c, isLustre(1));
    if (round % 2) hub.unmount(c, "l1");
    else hub.drop(c); // parked (the cap stops the oldest past 50)
  }
  assert(hub.parked() <= 50);
  hub.dispose(); // what uninstallLiveHub does on shutdown
  assertEquals([hub.running(), hub.parked()], [0, 0]);
  assertEquals(fakeRuntimes.live.size, startLive, "every Lustre runtime was shut down");
  // Deno's op sanitizer fails this test if an auth or park timer outlived its view.
});

Deno.test("Lustre hub: thousands of sessions retain no memory (a child with --expose-gc)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-lustre-leak-" });
  const repo = new URL("../", import.meta.url);
  try {
    const script = join(dir, "leak.ts");
    await Deno.writeTextFile(
      script,
      `import { lustreServerKit, defineLustreView } from "${repo.href}src/gleam.ts";
import { signLiveViewToken } from "${repo.href}src/runtime/live-view.ts";
import { lustreTokenName } from "${repo.href}src/lustre/view.ts";
import { createLustreViewHub } from "${repo.href}src/server/lustre-views.ts";
import { counterApp, fakeLustreServerModules, fakeRuntimes } from "${repo.href}tests/helpers/fake-lustre-server.ts";
const kit = lustreServerKit(fakeLustreServerModules());
defineLustreView({ id: "leak", kit, app: counterApp, flags: (p: { start: number }) => p.start });
const props = JSON.stringify({ start: 1 });
const token = await signLiveViewToken(lustreTokenName("leak"), props);
const hub = createLustreViewHub<any>({
  limits: () => ({ maxViewsPerConnection: 4, maxViewBytesPerConnection: 1 << 20,
    viewResumeSeconds: 30, maxParkedViews: 100, maxSubscriptionInputBytes: 4096,
    channelAuthTtlSeconds: 300 }),
  sendFrame: () => {}, sendError: () => {}, withConnContext: (_c, fn) => Promise.resolve(fn()),
  connContext: () => ({ origin: "", url: "", cookie: "", peerId: "" }),
  isConnected: () => true, backPressured: () => false, armRecover: () => {},
});
async function batch(n: number) {
  for (let i = 0; i < n; i++) {
    const conn = { peerId: "p" + i, lustreViews: new Map() };
    await hub.mount(conn, { type: "lustre-mount", vid: "l1", view: "leak", props, token });
    hub.event(conn, { type: "lustre-event", vid: "l1", msg: { kind: 1, path: "0", name: "click" } });
    await conn.lustreViews.get("l1")?.chain;
    if (i % 2) hub.unmount(conn, "l1");
    else hub.drop(conn);
  }
  hub.dispose();
  fakeRuntimes.constructed.length = 0; // the fake's own record of every constructor call
}
const gc = (globalThis as any).gc as () => void;
await batch(2000); // warm up: JIT, the token key cache
gc(); gc();
const before = Deno.memoryUsage().heapUsed;
await batch(5000);
gc(); gc();
const after = Deno.memoryUsage().heapUsed;
console.log(JSON.stringify({ grew: after - before, running: hub.running(), parked: hub.parked(),
  live: fakeRuntimes.live.size }));
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--v8-flags=--expose-gc",
        "--config",
        fromFileUrl(new URL("deno.json", repo)),
        script,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assert(out.success, text + new TextDecoder().decode(out.stderr));
    const result = JSON.parse(text.trim().split("\n").at(-1)!);
    assertEquals([result.running, result.parked, result.live], [0, 0, 0]);
    // 5,000 sessions: every runtime, timer, callback and map entry released. A leak of even one
    // small object per session would show up as hundreds of KB.
    assert(result.grew < 512 * 1024, `the heap grew ${result.grew} bytes`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
