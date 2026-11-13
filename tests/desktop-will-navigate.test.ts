// The app's will-navigate hook (src/desktop/will-navigate.ts): handlers see every top-level
// navigation a window's runtime announces (`"willnavigate"`, cancelable, before the navigation
// guard), refuse it with `preventDefault()` or let it load in place with `allow()`; a window is
// listened to only while a hook is subscribed, and never on a runtime without the event. Fake
// windows (EventTargets) stand in for `Deno.BrowserWindow`; no window opens.

import { assert, assertEquals } from "@std/assert";
import {
  createWillNavigateHooks,
  createWindowNavigationHooks,
  type DesktopWillNavigateEvent,
  runtimeHasNavigationEvents,
} from "../src/desktop/will-navigate.ts";

/** A runtime navigation event, its `allow()` recorded. */
function navigation(detail: Record<string, unknown>) {
  const allowed: string[] = [];
  const event = new CustomEvent("willnavigate", {
    cancelable: true,
    detail: { ...detail, allow: () => void allowed.push(String(detail.url)) },
  });
  return { event, allowed };
}

/** Two fake windows and a watcher that attaches them (as the lifecycle replays open windows). */
function windows() {
  const main = new EventTarget();
  const second = new EventTarget();
  let watching = 0;
  const watchWindows = (attach: (id: string, w: EventTarget) => void) => {
    watching++;
    attach("main", main);
    attach("window-2", second);
    return () => void watching--;
  };
  return { main, second, watchWindows, watching: () => watching };
}

Deno.test("onWillNavigate: a hook sees the navigation and can refuse it", () => {
  const w = windows();
  const hooks = createWillNavigateHooks({ supported: true, watchWindows: w.watchWindows });
  assertEquals(hooks.listening(), 0, "no hook, no listener");
  const seen: DesktopWillNavigateEvent[] = [];
  const off = hooks.add((e) => {
    seen.push(e);
    if (e.url.startsWith("https://evil.test")) e.preventDefault();
  });
  assertEquals(hooks.listening(), 2);
  const ok = navigation({ url: "myapp://app/next", kind: "link", initiator: "myapp://app/" });
  w.main.dispatchEvent(ok.event);
  assertEquals(ok.event.defaultPrevented, false);
  assertEquals(ok.allowed, [], "no allow() unless a hook asks");
  const bad = navigation({ url: "https://evil.test/x", kind: "script" });
  w.second.dispatchEvent(bad.event);
  assertEquals(bad.event.defaultPrevented, true);
  assertEquals(
    seen.map((e) => [e.url, e.window, e.kind, e.initiator, e.defaultPrevented]),
    [
      ["myapp://app/next", "main", "link", "myapp://app/", false],
      ["https://evil.test/x", "window-2", "script", undefined, true],
    ],
  );
  // The last unsubscribe stops listening.
  off();
  assertEquals(hooks.listening(), 0);
  assertEquals(w.watching(), 0);
  const after = navigation({ url: "https://evil.test/y" });
  w.main.dispatchEvent(after.event);
  assertEquals(after.event.defaultPrevented, false);
});

Deno.test("onWillNavigate: allow() loads in place; a refusal wins; a throw decides nothing", () => {
  const w = windows();
  const logged: string[] = [];
  const hooks = createWillNavigateHooks({
    supported: true,
    watchWindows: w.watchWindows,
    log: (message) => void logged.push(message),
  });
  hooks.add((e) => {
    if (e.url.startsWith("https://idp.test")) e.allow();
  });
  const idp = navigation({ url: "https://idp.test/authorize", kind: "redirect" });
  w.main.dispatchEvent(idp.event);
  assertEquals(idp.allowed, ["https://idp.test/authorize"]);
  assertEquals(idp.event.defaultPrevented, false);
  // A second hook refuses the same URL: the refusal wins, allow() is not called.
  const off = hooks.add((e) => {
    if (e.url.includes("blocked")) e.preventDefault();
  });
  const both = navigation({ url: "https://idp.test/blocked" });
  w.main.dispatchEvent(both.event);
  assertEquals([both.event.defaultPrevented, both.allowed], [true, []]);
  off();
  hooks.add(() => {
    throw new Error("boom");
  });
  const thrown = navigation({ url: "myapp://app/", kind: "weird" });
  w.main.dispatchEvent(thrown.event);
  assertEquals(thrown.event.defaultPrevented, false);
  assertEquals(logged, ["desktop: an onWillNavigate hook failed"]);
});

Deno.test("onWillNavigate: the event's fields are normalized", () => {
  const w = windows();
  const hooks = createWillNavigateHooks({ supported: true, watchWindows: w.watchWindows });
  let got: DesktopWillNavigateEvent | undefined;
  hooks.add((e) => void (got = e));
  w.main.dispatchEvent(new CustomEvent("willnavigate", { cancelable: true, detail: { url: 7 } }));
  assert(got);
  assertEquals([got.url, got.kind, got.initiator], ["", "other", undefined]);
  assert(Object.isFrozen(got));
  // window-open is a kind of its own.
  w.main.dispatchEvent(navigation({ url: "https://x.test", kind: "window-open" }).event);
  assertEquals(got.kind, "window-open");
});

Deno.test("onWillNavigate: a runtime without the event never listens", () => {
  const w = windows();
  const hooks = createWillNavigateHooks({ supported: false, watchWindows: w.watchWindows });
  let called = 0;
  hooks.add(() => void called++);
  assertEquals([hooks.supported, hooks.listening(), w.watching()], [false, 0, 0]);
  w.main.dispatchEvent(navigation({ url: "https://x.test" }).event);
  assertEquals(called, 0);
});

Deno.test("runtimeHasNavigationEvents: only Deno.desktop.navigationEvents === true", () => {
  assertEquals(runtimeHasNavigationEvents({ navigationEvents: true }), true);
  for (const desktop of [undefined, null, {}, { navigationEvents: 1 }]) {
    assertEquals(runtimeHasNavigationEvents(desktop), false, JSON.stringify(desktop));
  }
});

/** An EventTarget that counts its "willnavigate" listeners. */
class CountingWindow extends EventTarget {
  listeners = 0;
  override addEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    o?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "willnavigate") this.listeners++;
    super.addEventListener(type, fn, o);
  }
  override removeEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    o?: boolean | EventListenerOptions,
  ): void {
    if (type === "willnavigate") this.listeners--;
    super.removeEventListener(type, fn, o);
  }
}

Deno.test("onWillNavigate: a window that closes is let go, and one that reuses its id is listened to", () => {
  const opened = new Set<(info: { id: string }) => void>();
  const closed = new Set<(info: { id: string }) => void>();
  const open = new Map<string, CountingWindow>();
  const lifecycle = {
    onWindowOpened: (fn: (info: { id: string }) => void) => {
      opened.add(fn);
      for (const id of open.keys()) fn({ id }); // the open windows are replayed
      return () => void opened.delete(fn);
    },
    onWindowClosed: (fn: (info: { id: string }) => void) => {
      closed.add(fn);
      return () => void closed.delete(fn);
    },
  };
  const registry = { get: (id: string) => open.has(id) ? { window: open.get(id) } : undefined };
  const openWindow = (id: string) => {
    const w = new CountingWindow();
    open.set(id, w);
    for (const fn of opened) fn({ id });
    return w;
  };
  const closeWindow = (id: string) => {
    open.delete(id);
    for (const fn of closed) fn({ id });
  };
  const main = openWindow("main");
  const hooks = createWindowNavigationHooks({
    lifecycle,
    windowFor: (id) => registry.get(id)?.window,
    supported: true,
  });
  const seen: string[] = [];
  const off = hooks.add((e) => void seen.push(`${e.window} ${e.url}`));
  const panel = openWindow("panel");
  assertEquals([hooks.listening(), main.listeners, panel.listeners], [2, 1, 1]);
  closeWindow("panel");
  assertEquals([hooks.listening(), panel.listeners], [1, 0], "the closed window is dropped");
  // A new window under the same id is listened to again.
  const again = openWindow("panel");
  assertEquals([hooks.listening(), again.listeners], [2, 1]);
  again.dispatchEvent(navigation({ url: "myapp://app/x" }).event);
  main.dispatchEvent(navigation({ url: "myapp://app/y" }).event);
  assertEquals(seen, ["panel myapp://app/x", "main myapp://app/y"]);
  // The last unsubscribe stops watching both the openings and the closings.
  off();
  assertEquals([hooks.listening(), main.listeners, again.listeners], [0, 0, 0]);
  assertEquals([opened.size, closed.size], [0, 0]);
});
