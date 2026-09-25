// denext/mobile's app extension APIs: onShareReceived / useShareReceived (DenextShareReceive),
// setWidgetData / reloadWidgets (DenextWidgets) and the Live Activity functions
// (DenextLiveActivity). Each runs inside a faked Capacitor shell asserting the exact plugin call,
// and on its fallback: the web (and a shell without the plugin), where the share listener never
// fires, the widget functions resolve doing nothing, and the Live Activity functions reject with
// code `unsupported`. Also: onDeepLink leaves the share hand-off URL to onShareReceived; the
// configurable widgets' per-parameter snapshots; push-to-start tokens, the token events and the
// running-activity list; and denext/expo/widgets delegating to all of it.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  endLiveActivity,
  listLiveActivities,
  type LiveActivityError,
  liveActivityPushToken,
  liveActivityPushToStartToken,
  onDeepLink,
  onLiveActivityPushToken,
  onLiveActivityPushToStartToken,
  onShareReceived,
  reloadWidgets,
  setWidgetData,
  type SharedContent,
  startLiveActivity,
  updateLiveActivity,
  useShareReceived,
} from "../src/mobile/mod.ts";
import { isShareHandoff, resetShareReceiveForTesting } from "../src/mobile/share-handoff.ts";
import * as ExpoWidgets from "../src/expo/widgets.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** Install `values` on globalThis for the duration of `fn`, then restore the originals. */
async function withGlobals(
  values: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { configurable: true, writable: true, value });
  }
  try {
    await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
  }
}

/** Run `fn` inside a native shell (`platform`) whose `Plugins` are `plugins`. */
function inShell(
  plugins: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
  platform = "ios",
): Promise<void> {
  const Capacitor = { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins };
  return withGlobals({ Capacitor }, fn);
}

/** Let queued promise callbacks run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake DenextShareReceive: `queue` is what consume() hands out next; `fire()` posts the event. */
function fakeShare(initial: unknown[] = []) {
  let queue = [...initial];
  let listener: (() => void) | undefined;
  let removed = 0;
  let consumes = 0;
  const plugin = {
    consume: () => {
      consumes++;
      const items = queue;
      queue = [];
      return Promise.resolve({ items });
    },
    addListener: (_event: string, fn: () => void) => {
      listener = fn;
      return Promise.resolve({ remove: () => void removed++ });
    },
  };
  return {
    plugin,
    push: (...items: unknown[]) => queue.push(...items),
    fire: () => listener?.(),
    get removed() {
      return removed;
    },
    get consumes() {
      return consumes;
    },
  };
}

// ---- onShareReceived -------------------------------------------------------------------------

Deno.test("onShareReceived: the cold-start share, then a warm one on the event, to every subscriber", async () => {
  resetShareReceiveForTesting();
  const share = fakeShare([{ url: "https://example.com/a", receivedAt: 1 }]);
  await inShell({ DenextShareReceive: share.plugin }, async () => {
    const a: SharedContent[] = [];
    const b: SharedContent[] = [];
    const stopA = onShareReceived((c) => a.push(c));
    const stopB = onShareReceived((c) => b.push(c));
    await tick();
    assertEquals(a, [{ url: "https://example.com/a" }]);
    assertEquals(b, a, "the second subscriber shares the one listener");
    share.push({
      text: "hello",
      files: [{ path: "/g/DenextShare/files/1.jpg", mimeType: "image/jpeg" }, { mimeType: "x" }],
    });
    share.fire();
    await tick();
    assertEquals(a[1], {
      text: "hello",
      files: [{ path: "/g/DenextShare/files/1.jpg", mimeType: "image/jpeg" }],
    });
    stopA();
    assertEquals(share.removed, 0);
    stopB();
    assertEquals(share.removed, 1, "the native listener goes with the last subscriber");
  });
  resetShareReceiveForTesting();
});

Deno.test("onShareReceived: empty and malformed items are dropped; a consume error is logged", async () => {
  resetShareReceiveForTesting();
  const share = fakeShare([{}, null, "x", { text: "" }, { url: "https://x.dev" }]);
  await inShell({ DenextShareReceive: share.plugin }, async () => {
    const got: SharedContent[] = [];
    const stop = onShareReceived((c) => got.push(c));
    await tick();
    assertEquals(got, [{ url: "https://x.dev" }]);
    stop();
  });
  resetShareReceiveForTesting();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await inShell({
      DenextShareReceive: {
        consume: () => Promise.reject(new Error("unavailable")),
        addListener: () => ({ remove() {} }),
      },
    }, async () => {
      const stop = onShareReceived(() => {});
      await tick();
      stop();
    });
  } finally {
    console.error = original;
  }
  assertEquals(errors.length, 1);
  resetShareReceiveForTesting();
});

Deno.test("onShareReceived: a no-op on the web and in a shell without the plugin", async () => {
  resetShareReceiveForTesting();
  let called = false;
  onShareReceived(() => (called = true))();
  await inShell({}, () => onShareReceived(() => (called = true))());
  assert(!called);
});

Deno.test("useShareReceived: subscribes on mount with the latest callback, unsubscribes on unmount", async () => {
  resetShareReceiveForTesting();
  const share = fakeShare([{ text: "first" }]);
  await inShell({ DenextShareReceive: share.plugin }, async () => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const got: string[] = [];
    function Target({ tag }: { tag: string }) {
      useShareReceived((c) => got.push(`${tag}:${c.text}`));
      return null;
    }
    const root = createRoot(container as Any);
    root.render(h(Target as Any, { tag: "a" }));
    flushSync();
    await tick();
    root.render(h(Target as Any, { tag: "b" }));
    flushSync();
    share.push({ text: "second" });
    share.fire();
    await tick();
    assertEquals(got, ["a:first", "b:second"]);
    assertEquals(share.consumes, 2, "a re-render did not re-subscribe");
    root.unmount();
    flushSync();
    await tick();
    assertEquals(share.removed, 1);
  });
  resetShareReceiveForTesting();
});

Deno.test("isShareHandoff + onDeepLink: the share hand-off URL is not routed as a deep link", async () => {
  assert(isShareHandoff("t3code://denext-share"));
  assert(isShareHandoff("MyApp://DENEXT-SHARE?x=1"));
  assert(!isShareHandoff("https://denext-share/x"));
  assert(!isShareHandoff("t3code://threads/1"));
  assert(!isShareHandoff("not a url"));
  let urlOpen: ((e: { url: string }) => void) | undefined;
  const App = {
    addListener: (_: string, fn: (e: { url: string }) => void) => {
      urlOpen = fn;
      return Promise.resolve({ remove() {} });
    },
    getLaunchUrl: () => Promise.resolve(undefined),
  };
  await inShell({ App }, async () => {
    const seen: string[] = [];
    const stop = onDeepLink((e) => seen.push(e.url), { route: false });
    await tick();
    urlOpen?.({ url: "t3code://denext-share" });
    urlOpen?.({ url: "t3code://threads/1" });
    assertEquals(seen, ["t3code://threads/1"]);
    stop();
  });
});

// ---- widgets ---------------------------------------------------------------------------------

Deno.test("setWidgetData / reloadWidgets: the plugin calls, JSON-encoded", async () => {
  const calls: Array<[string, unknown]> = [];
  const DenextWidgets = {
    setData: (o: unknown) => (calls.push(["setData", o]), Promise.resolve()),
    reload: (o: unknown) => (calls.push(["reload", o]), Promise.resolve()),
  };
  await inShell({ DenextWidgets }, async () => {
    await setWidgetData("Status", { title: "3 running", body: "ok" });
    await setWidgetData("Status", [1, 2]);
    await reloadWidgets("Status");
    await reloadWidgets();
  }, "android");
  assertEquals(calls, [
    ["setData", { kind: "Status", json: '{"title":"3 running","body":"ok"}' }],
    ["setData", { kind: "Status", json: "[1,2]" }],
    ["reload", { kind: "Status" }],
    ["reload", {}],
  ]);
});

Deno.test("setWidgetData: a configurable widget's snapshot carries its params", async () => {
  const calls: unknown[] = [];
  const DenextWidgets = {
    setData: (o: unknown) => (calls.push(o), Promise.resolve()),
    reload: () => Promise.resolve(),
  };
  await inShell({ DenextWidgets }, async () => {
    await setWidgetData("Usage", { title: "Weekly" }, {
      params: { period: "weekly", scope: "all" },
    });
    await setWidgetData("Usage", { title: "Any" }, { params: {} });
  });
  assertEquals(calls, [
    { kind: "Usage", json: '{"title":"Weekly"}', params: { period: "weekly", scope: "all" } },
    { kind: "Usage", json: '{"title":"Any"}' },
  ]);
  const bad = (params: unknown) =>
    assertRejects(() => setWidgetData("Usage", {}, { params } as never), TypeError, "params");
  await bad([]);
  await bad({ period: 3 });
  await bad({ period: "a b" });
  await bad({ "bad-name": "x" });
  await bad("period=x");
});

Deno.test("setWidgetData / reloadWidgets: a no-op on the web; bad input is a TypeError everywhere", async () => {
  await setWidgetData("Status", { title: "web" });
  await reloadWidgets();
  await inShell({}, () => setWidgetData("Status", {}));
  await assertRejects(() => setWidgetData("", {}), TypeError, "kind must be");
  await assertRejects(() => setWidgetData("Status", undefined), TypeError, "JSON-serialisable");
  await assertRejects(() => reloadWidgets("bad kind"), TypeError, "kind must be");
});

Deno.test("setWidgetData: a native rejection passes through with its code", async () => {
  const DenextWidgets = {
    setData: () => Promise.reject(Object.assign(new Error("no group"), { code: "unavailable" })),
    reload: () => Promise.resolve(),
  };
  await inShell({ DenextWidgets }, async () => {
    const err = await assertRejects(() => setWidgetData("Status", {}));
    assertEquals((err as { code?: string }).code, "unavailable");
  });
});

// ---- Live Activities -------------------------------------------------------------------------

/** A fake DenextLiveActivity recording its calls. */
function fakeLiveActivity(results: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const method = (name: string) => (o: unknown) => {
    calls.push([name, o]);
    const r = results[name];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return {
    calls,
    plugin: {
      start: method("start"),
      update: method("update"),
      end: method("end"),
      pushToken: method("pushToken"),
    },
  };
}

/**
 * A fake DenextLiveActivity with push-to-start, list and events: `running` is what list()
 * reports (start adds to it, end removes), `emit` posts an event to the current listeners.
 */
function fakeLiveActivityFull(results: Record<string, unknown> = {}) {
  const base = fakeLiveActivity(results);
  const running: Array<{ id: string; name: string }> = [];
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  let removed = 0;
  const startResults = [...((results.starts as unknown[] | undefined) ?? [])];
  const plugin = {
    ...base.plugin,
    start: (o: { name: string }) => {
      base.calls.push(["start", o]);
      const r = startResults.length > 0 ? startResults.shift() : results.start;
      if (r instanceof Error) return Promise.reject(r);
      const id = (r as { id?: string } | undefined)?.id;
      if (id) running.push({ id, name: o.name });
      return Promise.resolve(r);
    },
    end: (o: { id: string }) => {
      base.calls.push(["end", o]);
      running.splice(running.findIndex((a) => a.id === o.id) >>> 0, 1);
      return Promise.resolve();
    },
    pushToStartToken: (o: unknown) => {
      base.calls.push(["pushToStartToken", o]);
      const r = results.pushToStartToken;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    list: () => Promise.resolve({ activities: [...running] }),
    addListener: (event: string, fn: (e: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return Promise.resolve({ remove: () => void (removed++, set.delete(fn)) });
    },
  };
  return {
    calls: base.calls,
    running,
    plugin,
    removed: () => removed,
    emit: (event: string, data: unknown) => {
      for (const fn of [...listeners.get(event) ?? []]) fn(data);
    },
  };
}

Deno.test("Live Activities: start / update / end / pushToken call the plugin with JSON text", async () => {
  const fake = fakeLiveActivity({ start: { id: "act-1" }, pushToken: { token: "abcd" } });
  await inShell({ DenextLiveActivity: fake.plugin }, async () => {
    const id = await startLiveActivity("Delivery", { order: "A-42" }, { progress: 0.2 }, {
      push: true,
    });
    assertEquals(id, "act-1");
    await updateLiveActivity(id, { progress: 0.6 });
    assertEquals(await liveActivityPushToken(id, { timeoutMs: 500 }), "abcd");
    await endLiveActivity(id, { state: { progress: 1 }, dismissal: "immediate" });
    await endLiveActivity(id);
  });
  assertEquals(fake.calls, [
    ["start", {
      name: "Delivery",
      attributes: '{"order":"A-42"}',
      state: '{"progress":0.2}',
      push: true,
    }],
    ["update", { id: "act-1", state: '{"progress":0.6}' }],
    ["pushToken", { id: "act-1", timeoutMs: 500 }],
    ["end", { id: "act-1", state: '{"progress":1}', dismissal: "immediate" }],
    ["end", { id: "act-1", dismissal: "default" }],
  ]);
});

Deno.test("Live Activities: unsupported on the web, on Android, and without the plugin", async () => {
  const unsupported = async (run: () => Promise<unknown>) => {
    const err = await assertRejects(run) as LiveActivityError;
    assertEquals(err.code, "unsupported");
    assertEquals(err.name, "LiveActivityError");
  };
  await unsupported(() => startLiveActivity("Delivery", {}, {}));
  await inShell({}, () => unsupported(() => updateLiveActivity("x", {})), "android");
  await inShell({}, () => unsupported(() => endLiveActivity("x")));
  await inShell({}, () => unsupported(() => liveActivityPushToken("x")));
});

Deno.test("Live Activities: invalid input rejects with code invalid, before the plugin", async () => {
  const fake = fakeLiveActivity();
  await inShell({ DenextLiveActivity: fake.plugin }, async () => {
    const invalid = async (run: () => Promise<unknown>) => {
      assertEquals((await assertRejects(run) as LiveActivityError).code, "invalid");
    };
    await invalid(() => startLiveActivity("delivery", {}, {}));
    await invalid(() => startLiveActivity("Delivery", [] as never, {}));
    await invalid(() => startLiveActivity("Delivery", {}, null as never));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await invalid(() => startLiveActivity("Delivery", {}, cyclic));
    await invalid(() => updateLiveActivity("", {}));
    await invalid(() => liveActivityPushToken("x", { timeoutMs: -1 }));
  });
  assertEquals(fake.calls, []);
});

Deno.test("Live Activities: native codes pass through; unknown ones become failed", async () => {
  const fake = fakeLiveActivity({
    start: Object.assign(new Error("off"), { code: "disabled" }),
    update: Object.assign(new Error("gone"), { code: "not_found" }),
    end: new Error("weird"),
    pushToken: {},
  });
  await inShell({ DenextLiveActivity: fake.plugin }, async () => {
    const code = async (run: () => Promise<unknown>) =>
      (await assertRejects(run) as LiveActivityError).code;
    assertEquals(await code(() => startLiveActivity("Delivery", {}, {})), "disabled");
    assertEquals(await code(() => updateLiveActivity("a", {})), "not_found");
    assertEquals(await code(() => endLiveActivity("a")), "failed");
    assertEquals(await code(() => liveActivityPushToken("a")), "timeout");
  });
  const noId = fakeLiveActivity({ start: {} });
  await inShell({ DenextLiveActivity: noId.plugin }, async () => {
    const err = await assertRejects(() =>
      startLiveActivity("Delivery", {}, {})
    ) as LiveActivityError;
    assertEquals(err.code, "failed");
  });
});

Deno.test("liveActivityPushToStartToken: the token, null below iOS 17.2 and off iOS, timeout", async () => {
  const fake = fakeLiveActivityFull({ pushToStartToken: { supported: true, token: "beef" } });
  await inShell({ DenextLiveActivity: fake.plugin }, async () => {
    assertEquals(await liveActivityPushToStartToken({ timeoutMs: 250 }), { token: "beef" });
    assertEquals(await liveActivityPushToStartToken(), { token: "beef" });
  });
  assertEquals(fake.calls, [
    ["pushToStartToken", { timeoutMs: 250 }],
    ["pushToStartToken", { timeoutMs: 10_000 }],
  ]);
  // iOS 16: the plugin reports push-to-start unsupported.
  const old = fakeLiveActivityFull({ pushToStartToken: { supported: false } });
  await inShell({ DenextLiveActivity: old.plugin }, async () => {
    assertEquals(await liveActivityPushToStartToken(), null);
  });
  // The web, Android, and a plugin installed before push-to-start.
  assertEquals(await liveActivityPushToStartToken(), null);
  await inShell(
    {},
    async () => assertEquals(await liveActivityPushToStartToken(), null),
    "android",
  );
  await inShell({ DenextLiveActivity: fakeLiveActivity().plugin }, async () => {
    assertEquals(await liveActivityPushToStartToken(), null);
  });
  // No token in time (no push entitlement), a native timeout, bad input.
  const none = fakeLiveActivityFull({ pushToStartToken: { supported: true } });
  const late = fakeLiveActivityFull({
    pushToStartToken: Object.assign(new Error("no token"), { code: "timeout" }),
  });
  const code = async (run: () => Promise<unknown>) =>
    (await assertRejects(run) as LiveActivityError).code;
  await inShell({ DenextLiveActivity: none.plugin }, async () => {
    assertEquals(await code(() => liveActivityPushToStartToken()), "timeout");
    assertEquals(await code(() => liveActivityPushToStartToken({ timeoutMs: -5 })), "invalid");
    assertEquals(await code(() => liveActivityPushToStartToken({ timeoutMs: NaN })), "invalid");
  });
  await inShell({ DenextLiveActivity: late.plugin }, async () => {
    assertEquals(await code(() => liveActivityPushToStartToken()), "timeout");
  });
});

Deno.test("onLiveActivityPushToStartToken / onLiveActivityPushToken: events, filtered and disposable", async () => {
  const fake = fakeLiveActivityFull();
  const starts: unknown[] = [];
  const tokens: unknown[] = [];
  await inShell({ DenextLiveActivity: fake.plugin }, async () => {
    const stopStart = onLiveActivityPushToStartToken((t) => starts.push(t));
    const stopToken = onLiveActivityPushToken((t) => tokens.push(t));
    await tick();
    fake.emit("pushToStartToken", { token: "aa" });
    fake.emit("pushToStartToken", { token: "" });
    fake.emit("pushToStartToken", null);
    fake.emit("pushToken", { id: "act-1", token: "bb" });
    fake.emit("pushToken", { token: "cc" });
    stopStart();
    stopToken();
    await tick();
    fake.emit("pushToStartToken", { token: "dd" });
    fake.emit("pushToken", { id: "act-1", token: "ee" });
  });
  assertEquals(starts, [{ token: "aa" }]);
  assertEquals(tokens, [{ id: "act-1", token: "bb" }]);
  assertEquals(fake.removed(), 2);
  // Off iOS: a no-op that is safe to dispose.
  onLiveActivityPushToStartToken(() => {})();
  await inShell({}, () => onLiveActivityPushToken(() => {})(), "android");
});

Deno.test("listLiveActivities and endLiveActivity's dismissal Date", async () => {
  const fake = fakeLiveActivityFull({ start: { id: "act-1" } });
  await inShell({ DenextLiveActivity: fake.plugin }, async () => {
    await startLiveActivity("Delivery", {}, {});
    fake.running.push({ id: "", name: "Bad" });
    assertEquals(await listLiveActivities(), [{ id: "act-1", name: "Delivery" }]);
    const at = new Date(1_900_000_000_000);
    await endLiveActivity("act-1", { dismissal: at });
    const err = await assertRejects(() =>
      endLiveActivity("act-1", { dismissal: new Date(NaN) })
    ) as LiveActivityError;
    assertEquals(err.code, "invalid");
  });
  assertEquals(fake.calls.at(-1), [
    "end",
    { id: "act-1", dismissal: "after", dismissalAt: 1_900_000_000_000 },
  ]);
  assertEquals(await listLiveActivities(), []);
  await inShell({ DenextLiveActivity: fakeLiveActivity().plugin }, async () => {
    assertEquals(await listLiveActivities(), []);
  });
});

// ---- denext/expo/widgets ---------------------------------------------------------------------

Deno.test("expo-widgets: Widget updates are setWidgetData / reloadWidgets", async () => {
  const calls: Array<[string, unknown]> = [];
  const DenextWidgets = {
    setData: (o: unknown) => (calls.push(["setData", o]), Promise.resolve()),
    reload: (o: unknown) => (calls.push(["reload", o]), Promise.resolve()),
  };
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 3_600_000);
  await inShell({ DenextWidgets }, async () => {
    const widget = ExpoWidgets.createWidget<{ v: number }>("Usage", () => null);
    widget.updateSnapshot({ v: 1 });
    widget.updateTimeline([{ date: future, props: { v: 3 } }, { date: past, props: { v: 2 } }]);
    assertEquals((await widget.getTimeline()).map((e) => e.props.v), [2, 3]);
    widget.updateTimeline([{ date: future, props: { v: 4 } }]); // none yet: the earliest
    widget.updateTimeline([]);
    widget.reload();
    await tick();
  });
  assertEquals(calls, [
    ["setData", { kind: "Usage", json: '{"v":1}' }],
    ["setData", { kind: "Usage", json: '{"v":2}' }],
    ["setData", { kind: "Usage", json: '{"v":4}' }],
    ["reload", { kind: "Usage" }],
  ]);
});

Deno.test("expo-widgets: a Live Activity starts, updates, reports tokens and ends through denext/mobile", async () => {
  const fake = fakeLiveActivityFull({
    start: { id: "act-2" },
    pushToken: Object.assign(new Error("not yet"), { code: "timeout" }),
  });
  fake.running.push({ id: "act-1", name: "AgentWork" }, { id: "other", name: "Delivery" });
  await inShell({ DenextLiveActivity: fake.plugin }, async () => {
    const factory = ExpoWidgets.createLiveActivity<{ title: string }>("AgentWork", () => ({}));
    await tick();
    // The activity started in an earlier session is found; the other name is not.
    assertEquals(factory.getInstances().map((a) => a.getId()), ["act-1"]);
    const activity = factory.start({ title: "Running" });
    assertEquals(activity.getId(), "");
    await tick();
    assertEquals(activity.getId(), "act-2");
    assertEquals(factory.getInstances().map((a) => a.getId()), ["act-1", "act-2"]);
    await activity.update({ title: "Half" });
    assertEquals(await activity.getPushToken(), null);
    const tokens: unknown[] = [];
    const sub = activity.addPushTokenListener((e) => tokens.push(e));
    const starts: unknown[] = [];
    const startSub = ExpoWidgets.addPushToStartTokenListener((e) => starts.push(e));
    await tick();
    fake.emit("pushToken", { id: "act-1", token: "11" });
    fake.emit("pushToken", { id: "act-2", token: "22" });
    fake.emit("pushToStartToken", { token: "33" });
    sub.remove();
    startSub.remove();
    assertEquals(tokens, [{ activityId: "act-2", pushToken: "22" }]);
    assertEquals(starts, [{ activityPushToStartToken: "33" }]);
    await activity.end("immediate", { title: "Done" });
    assertEquals(factory.getInstances().map((a) => a.getId()), ["act-1"]);
    const at = new Date(1_900_000_000_000);
    await factory.getInstances()[0].end(ExpoWidgets.after(at));
  });
  assertEquals(fake.calls, [
    ["start", { name: "AgentWork", attributes: "{}", state: '{"title":"Running"}', push: true }],
    ["update", { id: "act-2", state: '{"title":"Half"}' }],
    ["pushToken", { id: "act-2", timeoutMs: 0 }],
    ["end", { id: "act-2", state: '{"title":"Done"}', dismissal: "immediate" }],
    ["end", { id: "act-1", dismissal: "after", dismissalAt: 1_900_000_000_000 }],
  ]);
});

Deno.test("expo-widgets: start retries without push; a failed start drops the instance", async () => {
  const failed = () => Object.assign(new Error("no aps entitlement"), { code: "failed" });
  const fake = fakeLiveActivityFull({
    starts: [failed(), { id: "act-9" }],
    pushToken: { token: "ab" },
  });
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args[0]);
  try {
    await inShell({ DenextLiveActivity: fake.plugin }, async () => {
      const factory = ExpoWidgets.createLiveActivity("AgentWork", () => ({}));
      const activity = factory.start({ n: 1 });
      await tick();
      assertEquals(activity.getId(), "act-9");
      assertEquals(await activity.getPushToken(), "ab");
      const disabled = Object.assign(new Error("off"), { code: "disabled" });
      const off = fakeLiveActivityFull({ start: disabled });
      await inShell({ DenextLiveActivity: off.plugin }, async () => {
        const f2 = ExpoWidgets.createLiveActivity("AgentWork", () => ({}));
        const gone = f2.start({ n: 2 });
        await tick();
        assertEquals(f2.getInstances(), []);
        await assertRejects(() => gone.update({ n: 3 }));
        assertEquals(off.calls.filter(([m]) => m === "start").length, 1);
      });
    });
  } finally {
    console.warn = warn;
  }
  assertEquals(
    fake.calls.filter(([m]) => m === "start").map(([, o]) => (o as { push: boolean }).push),
    [true, false],
  );
  assert(warned.some((w) => String(w).includes("Live Activity start failed")));
});
