// The web `Notification` shim a Deno Desktop page gets when the `notifications` capability is on
// (src/desktop/notification-shim.ts), driven end to end: the shim in a fake page global, its RPCs
// and event stream answered by the real bridge over the real capability, the OS faked. Covers
// permission / requestPermission, show, tag replacement, close, a native click routed to
// `onclick` + `click` (and kept away from `onLocalNotificationTapped`'s queue), the serialized
// inline form, and where the desktop runtime injects it.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  DESKTOP_NOTIFICATION_SHIM_JS,
  installDesktopNotificationShim,
} from "../src/desktop/notification-shim.ts";
import { notificationsCapability } from "../src/desktop/caps/notifications.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import { createDesktopHandler, injectDesktopGlobal } from "../src/build/desktop.ts";
import type {
  DesktopAppApi,
  DesktopNotificationsApi,
  DesktopScheduledNotification,
} from "../src/desktop/launch-events.ts";
import type { DesktopServeInfo, DesktopTrust } from "../src/desktop/transport.ts";

const TOKEN = "shim-token-0123456789";
const BASE = "http://127.0.0.1:8000";

/** A fake `Deno.desktop` with notifications (what the capability talks to). */
function fakeOs() {
  const scheduled: DesktopScheduledNotification[] = [];
  const cancelled: string[] = [];
  const listeners = new Map<string, (e: Event) => void>();
  const notifications: DesktopNotificationsApi = {
    capabilities: () => ({ show: true, schedule: true, actions: true, clicks: true }),
    schedule: (o) => {
      const at = scheduled.findIndex((e) => e.tag === o.tag);
      if (at >= 0) scheduled.splice(at, 1);
      scheduled.push({ tag: o.tag!, title: o.title, body: o.body, at: o.at, data: o.data });
      return Promise.resolve(o.tag!);
    },
    getScheduled: () => Promise.resolve([...scheduled]),
    cancel: (tag) => {
      const at = scheduled.findIndex((e) => e.tag === tag);
      if (at >= 0) scheduled.splice(at, 1);
      cancelled.push(tag);
    },
    requestPermission: () => Promise.resolve("granted"),
  };
  const api: DesktopAppApi = {
    notifications,
    addEventListener: (type, l) => void listeners.set(type, l),
  };
  /** The OS reports a click on the notification tagged `tag`. */
  const click = (tag: string, data: unknown) =>
    listeners.get("notificationresponse")!(
      new CustomEvent("notificationresponse", { detail: { tag, action: null, data } }),
    );
  return { api, scheduled, cancelled, click };
}

// deno-lint-ignore no-explicit-any
type Page = any;

/** A page global with the shim installed, wired to a bridge over the real capability. */
function page() {
  const os = fakeOs();
  const cap = notificationsCapability({ api: os.api, autoTopUp: false });
  const bridge = createDesktopBridge([cap]);
  const streams: AbortController[] = [];
  const timers: Array<() => void> = [];
  const fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("origin", BASE);
    const request = new Request(new URL(path, BASE), {
      method: init.method ?? "GET",
      headers,
      body: init.body,
    });
    const res = await bridge.handle(request, new URL(request.url), TOKEN);
    if (!res) return new Response(null, { status: 404 });
    if (!res.body || !path.endsWith("/events")) return res;
    // The event stream: piped so the test can end it.
    const abort = new AbortController();
    streams.push(abort);
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    res.body.pipeTo(pipe.writable, { signal: abort.signal }).catch(() => {});
    return new Response(pipe.readable, { status: res.status, headers: res.headers });
  };
  const g: Page = {
    __denext: { desktop: true, token: TOKEN },
    fetch,
    Event,
    EventTarget,
    TextDecoder,
    crypto,
    // The shim's retry / rethrow timers are recorded, never run (no leaked timers).
    setTimeout: (fn: () => void) => void timers.push(fn),
  };
  installDesktopNotificationShim(g);
  const end = async () => {
    for (const s of streams) s.abort();
    await settle();
  };
  return { g, os, timers, end };
}

/** Let the shim's promise chains (RPC → bridge → capability) run. */
async function settle(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

Deno.test("Notification shim: permission starts default; requestPermission asks the OS", async () => {
  const { g, end } = page();
  try {
    assertEquals(g.Notification.name, "Notification");
    assertEquals(g.Notification.maxActions, 0);
    await settle();
    // Plain Deno answers the no-prompt query with "prompt", which the web API calls "default".
    assertEquals(g.Notification.permission, "default");
    let viaCallback: string | undefined;
    const state = await g.Notification.requestPermission((s: string) => (viaCallback = s));
    assertEquals(state, "granted");
    assertEquals(g.Notification.permission, "granted");
    await settle(0);
    assertEquals(viaCallback, "granted");
  } finally {
    await end();
  }
});

Deno.test("Notification shim: not granted → error event, nothing posted", async () => {
  const { g, os, end } = page();
  try {
    const events: string[] = [];
    const n = new g.Notification("Hi");
    n.onerror = () => events.push("onerror");
    n.addEventListener("show", () => events.push("show"));
    await settle();
    assertEquals(events, ["onerror"]);
    assertEquals(os.scheduled.length, 0);
    assertThrows(() => new g.Notification(), TypeError);
  } finally {
    await end();
  }
});

Deno.test("Notification shim: show, tag replacement, close", async () => {
  const { g, os, end } = page();
  try {
    await g.Notification.requestPermission();
    const events: string[] = [];
    const a = new g.Notification("Build", { body: "running", tag: "build", data: { n: 1 } });
    a.onshow = () => events.push("a:show");
    a.onclose = () => events.push("a:close");
    assertEquals([a.title, a.body, a.tag, a.data.n], ["Build", "running", "build", 1]);
    await settle();
    assertEquals(events, ["a:show"]);
    assertEquals(os.scheduled.length, 1);
    const tag = os.scheduled[0].tag;
    assert(tag.startsWith("denext-web-t"), tag);
    assertEquals([os.scheduled[0].title, os.scheduled[0].body], ["Build", "running"]);

    // Same tag: the OS notification is replaced, the old object gets no close event.
    const b = new g.Notification("Build", { body: "done", tag: "build" });
    b.addEventListener("close", () => events.push("b:close"));
    await settle();
    assertEquals(os.scheduled.map((e) => [e.tag, e.body]), [[tag, "done"]]);
    a.close(); // a no-op: it was replaced
    assertEquals(events, ["a:show"]);

    b.close();
    assertEquals(events, ["a:show", "b:close"]);
    await settle();
    assertEquals(os.scheduled.length, 0);
    assert(os.cancelled.includes(tag));
    // Untagged notifications get keys of their own.
    new g.Notification("one");
    new g.Notification("two");
    await settle();
    assertEquals(new Set(os.scheduled.map((e) => e.tag)).size, 2);
  } finally {
    await end();
  }
});

Deno.test("Notification shim: an OS click fires onclick + click on the live object only", async () => {
  const { g, os, end } = page();
  try {
    await g.Notification.requestPermission();
    const clicks: string[] = [];
    const n = new g.Notification("Reply", { tag: "msg-7" });
    n.onclick = (e: Event) => clicks.push(`onclick:${e.type}:${e.cancelable}`);
    n.addEventListener("click", () => clicks.push("listener"));
    await settle();
    const { tag, data } = os.scheduled[0];
    os.click(tag, data);
    await settle(150);
    assertEquals(clicks, ["onclick:click:true", "listener"]);

    // The app's own notification queue never sees a web notification's click.
    const cap = notificationsCapability({ api: os.api, autoTopUp: false });
    assertEquals(cap.methods.take.handler({}, ctx()), []);
    // A click for a notification this page no longer has reaches nothing.
    n.close();
    os.click(tag, data);
    await settle(150);
    assertEquals(clicks.length, 2);
  } finally {
    await end();
  }
});

/** A bare handler context. */
function ctx() {
  return {
    emit: () => {},
    appSupportDir: "",
    os: "darwin" as const,
    window: undefined,
    signal: new AbortController().signal,
    runOnMainThread: () => Promise.reject(new Error("none")),
  };
}

Deno.test("Notification shim: no token → nothing installed", () => {
  const g: Page = { __denext: { desktop: true }, Notification: "web" };
  installDesktopNotificationShim(g);
  assertEquals(g.Notification, "web");
  installDesktopNotificationShim({});
});

Deno.test("Notification shim: the inline form is self-contained and installs from a string", () => {
  assert(!DESKTOP_NOTIFICATION_SHIM_JS.includes("</script"));
  const g: Page = {
    __denext: { desktop: true, token: TOKEN },
    fetch: () => new Promise(() => {}),
    Event,
    EventTarget,
    TextDecoder,
    crypto,
    setTimeout: () => {},
  };
  // Run the serialized source with `g` as its globalThis: no outer reference may be needed.
  new Function("globalThis", DESKTOP_NOTIFICATION_SHIM_JS)(g);
  assertEquals(g.Notification.name, "Notification");
  assertEquals(g.Notification.permission, "default");
});

Deno.test("capability: webShow / webClose / webTake validate their arguments", async () => {
  const os = fakeOs();
  const cap = notificationsCapability({ api: os.api, autoTopUp: false });
  const code = async (run: unknown) => {
    try {
      await Promise.resolve().then(() => (typeof run === "function" ? run() : run));
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return "ok";
  };
  assertEquals(
    await code(() => cap.methods.webShow.handler({ key: "../x", title: "t" }, ctx())),
    "validation",
  );
  assertEquals(
    await code(() => cap.methods.webShow.handler({ key: "k", title: 1 }, ctx())),
    "validation",
  );
  assertEquals(await code(() => cap.methods.webClose.handler({ key: "" }, ctx())), "validation");
  await cap.methods.webShow.handler({ key: "k1", title: "t" }, ctx());
  // Web notifications are not the app's: `pending` and `cancel` leave them alone.
  assertEquals(await cap.methods.pending.handler({}, ctx()), []);
  assertEquals(os.scheduled.map((e) => e.tag), ["denext-web-k1"]);
  assertEquals(await cap.methods.webTake.handler({}, ctx()), []);
  // Stock runtime: unavailable.
  const stock = notificationsCapability({ api: {}, autoTopUp: false });
  assertEquals(
    await code(() => stock.methods.webShow.handler({ key: "k", title: "t" }, ctx())),
    "unavailable",
  );
});

const MEMORY: DesktopTrust = { kind: "memory", origin: "myapp://app" };
const MEM_INFO: DesktopServeInfo = { remoteAddr: { transport: "memory" } };

/** The served shell with `capabilities`, in `trust`. */
async function shell(
  trust: DesktopTrust,
  base: string,
  withNotifications: boolean,
  info?: DesktopServeInfo,
  headers: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "index.html"), "<html><head></head><body></body></html>");
    const caps = withNotifications ? [notificationsCapability({ api: {}, autoTopUp: false })] : [];
    const handle = createDesktopHandler(
      { capabilities: caps },
      dir,
      undefined,
      TOKEN,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      trust,
    );
    const request = new Request(`${base}/`, { headers });
    const res = await handle(request, new URL(request.url), info);
    return await res.text();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("desktop runtime: the shim is injected in the memory world with the capability on", async () => {
  const marker = "installDesktopNotificationShim";
  assertStringIncludes(await shell(MEMORY, "http+memory://app", true, MEM_INFO), marker);
  // Not without the capability, not under the stock runtime, not into an iframe (no token).
  assert(!(await shell(MEMORY, "http+memory://app", false, MEM_INFO)).includes(marker));
  assert(!(await shell({ kind: "loopback" }, BASE, true)).includes(marker));
  const frame = await shell(MEMORY, "http+memory://app", true, MEM_INFO, {
    "sec-fetch-dest": "iframe",
  });
  assert(!frame.includes(marker));
  // injectDesktopGlobal: with the token only.
  const html = "<head></head>";
  assertStringIncludes(
    await injectDesktopGlobal(html, TOKEN, false, undefined, undefined, { notifications: true }),
    marker,
  );
  assert(
    !(await injectDesktopGlobal(html, null, false, undefined, undefined, { notifications: true }))
      .includes(marker),
  );
});
