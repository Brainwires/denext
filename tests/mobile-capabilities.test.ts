// denext/mobile native capabilities: haptic, clipboard, share, deviceInfo, network,
// useKeepAwake, hideSplash and secureStore. Each is tested inside a faked Capacitor shell
// (`globalThis.Capacitor` with the plugin's methods under `Plugins`), asserting the plugin
// call arguments, and on its web fallback. Every global a test installs is restored.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  deviceInfo,
  haptic,
  type HapticKind,
  hideSplash,
  type NetworkStatus,
  networkStatus,
  readClipboard,
  secureStore,
  share,
  useKeepAwake,
  useNetworkStatus,
  writeClipboard,
} from "../src/mobile/mod.ts";

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

/** A native iOS shell whose `Plugins` are `plugins`. */
function shell(plugins: Record<string, unknown>, platform = "ios") {
  return { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins };
}

/** Run `fn` inside a native shell with `plugins` (plus any `extra` globals). */
function inShell(
  plugins: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  return withGlobals({ Capacitor: shell(plugins), ...extra }, fn);
}

/** A recorder: `calls` collects `[method, arg]`; each method resolves `results[method]`. */
function recorder(methods: string[], results: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const plugin: Record<string, (arg?: unknown) => Promise<unknown>> = {};
  for (const m of methods) {
    plugin[m] = (arg?: unknown) => {
      calls.push(arg === undefined ? [m, undefined] : [m, arg]);
      const r = results[m];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    };
  }
  return { plugin, calls };
}

/** Mount a probe component on a fake DOM. */
function mount(render: () => unknown) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function Probe(_props: { n: number }) {
    return render();
  }
  const root = createRoot(container as Any);
  let n = 0;
  const rerender = () => {
    root.render(h(Probe as Any, { n: ++n }));
    flushSync();
  };
  rerender();
  return { root, rerender };
}

/** Let queued promise callbacks run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- haptic ----------------------------------------------------------------

Deno.test("haptic: native impact / notification / selection calls", async () => {
  const { plugin, calls } = recorder([
    "impact",
    "notification",
    "selectionStart",
    "selectionChanged",
    "selectionEnd",
  ]);
  await inShell({ Haptics: plugin }, async () => {
    for (const kind of ["light", "medium", "heavy", "success", "warning", "error", "selection"]) {
      await haptic(kind as HapticKind);
    }
  });
  assertEquals(calls, [
    ["impact", { style: "LIGHT" }],
    ["impact", { style: "MEDIUM" }],
    ["impact", { style: "HEAVY" }],
    ["notification", { type: "SUCCESS" }],
    ["notification", { type: "WARNING" }],
    ["notification", { type: "ERROR" }],
    ["selectionStart", undefined],
    ["selectionChanged", undefined],
    ["selectionEnd", undefined],
  ]);
});

Deno.test("haptic: web falls back to navigator.vibrate, else a no-op; bad kinds reject", async () => {
  const patterns: unknown[] = [];
  const nav = { vibrate: (p: unknown) => (patterns.push(p), true) };
  await withGlobals({ navigator: nav }, async () => {
    await haptic("medium");
    await haptic("error");
  });
  assertEquals(patterns, [20, [30, 60, 30, 60, 30]]);

  // A native shell without the plugin also takes the fallback.
  await inShell({}, () => haptic("light"), { navigator: nav });
  assertEquals(patterns.length, 3);

  await withGlobals({ navigator: {} }, () => haptic("heavy")); // no vibrate: nothing
  await assertRejects(() => haptic("boom" as HapticKind), TypeError, "unknown kind");
});

// ---- clipboard -------------------------------------------------------------

Deno.test("clipboard: native read/write through the Clipboard plugin", async () => {
  const { plugin, calls } = recorder(["read", "write"], {
    read: { value: "from native", type: "text/plain" },
  });
  await inShell({ Clipboard: plugin }, async () => {
    assertEquals(await readClipboard(), "from native");
    await writeClipboard("hello");
  });
  assertEquals(calls, [["read", undefined], ["write", { string: "hello" }]]);

  const empty = recorder(["read", "write"], { read: {} });
  await inShell({ Clipboard: empty.plugin }, async () => assertEquals(await readClipboard(), ""));
});

Deno.test("clipboard: web uses navigator.clipboard, and rejects without it", async () => {
  let stored = "web text";
  const clipboard = {
    readText: () => Promise.resolve(stored),
    writeText: (t: string) => Promise.resolve(void (stored = t)),
  };
  await withGlobals({ navigator: { clipboard } }, async () => {
    assertEquals(await readClipboard(), "web text");
    await writeClipboard("copied");
  });
  assertEquals(stored, "copied");
  await withGlobals({ navigator: {} }, async () => {
    await assertRejects(() => readClipboard(), Error, "no clipboard");
    await assertRejects(() => writeClipboard("x"), Error, "no clipboard");
  });
});

// ---- share -----------------------------------------------------------------

Deno.test("share: native Share plugin; a dismissed sheet is cancelled", async () => {
  const ok = recorder(["share"], { share: { activityType: "com.apple.UIKit.activity.Mail" } });
  await inShell({ Share: ok.plugin }, async () => {
    assertEquals(await share({ title: "T", url: "https://x.dev/" }), "shared");
  });
  assertEquals(ok.calls, [["share", { title: "T", url: "https://x.dev/" }]]);

  const cancelled = recorder(["share"], { share: new Error("Share canceled") });
  await inShell({ Share: cancelled.plugin }, async () => {
    assertEquals(await share({ text: "hi" }), "cancelled");
  });
  const broken = recorder(["share"], { share: new Error("boom") });
  await inShell({ Share: broken.plugin }, async () => {
    await assertRejects(() => share({ text: "hi" }), Error, "boom");
  });
});

Deno.test("share: web navigator.share, AbortError, and the clipboard fallback", async () => {
  const shared: unknown[] = [];
  const nav = { share: (d: unknown) => Promise.resolve(void shared.push(d)) };
  await withGlobals({ navigator: nav }, async () => {
    assertEquals(await share({ text: "hi", url: "https://x.dev/" }), "shared");
  });
  assertEquals(shared, [{ text: "hi", url: "https://x.dev/" }]);

  const abort = { share: () => Promise.reject(new DOMException("dismissed", "AbortError")) };
  await withGlobals({ navigator: abort }, async () => {
    assertEquals(await share({ url: "https://x.dev/" }), "cancelled");
  });

  let copied = "";
  const clipboard = {
    readText: () => Promise.resolve(""),
    writeText: (t: string) => Promise.resolve(void (copied = t)),
  };
  // No navigator.share (or canShare refuses): copy text and url.
  await withGlobals({ navigator: { clipboard } }, async () => {
    assertEquals(await share({ title: "T", text: "Look", url: "https://x.dev/" }), "copied");
  });
  assertEquals(copied, "Look https://x.dev/");
  await withGlobals(
    { navigator: { clipboard, share: () => Promise.resolve(), canShare: () => false } },
    async () => assertEquals(await share({ url: "https://y.dev/" }), "copied"),
  );
  assertEquals(copied, "https://y.dev/");
  await assertRejects(() => share({}), TypeError, "at least one");
});

// ---- deviceInfo ------------------------------------------------------------

Deno.test("deviceInfo: native getInfo", async () => {
  const { plugin, calls } = recorder(["getInfo"], {
    getInfo: { model: "iPhone15,2", osVersion: "17.5", isVirtual: false, platform: "ios" },
  });
  await inShell({ Device: plugin }, async () => {
    assertEquals(await deviceInfo(), {
      platform: "ios",
      model: "iPhone15,2",
      osVersion: "17.5",
      isVirtual: false,
    });
  });
  assertEquals(calls, [["getInfo", undefined]]);
});

Deno.test("deviceInfo: web parses the user agent, best effort", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      { platform: "web", model: "iPhone", osVersion: "17.5.1" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240505.005; wv) AppleWebKit/537.36",
      { platform: "web", model: "Pixel 8", osVersion: "14" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/127.0 Mobile Safari/537.36",
      { platform: "web", osVersion: "10" },
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      { platform: "web", model: "Macintosh", osVersion: "10.15.7" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/127.0",
      { platform: "web", model: "Windows", osVersion: "10.0" },
    ],
    ["curl/8.0", { platform: "web" }],
  ];
  for (const [userAgent, expected] of cases) {
    await withGlobals({ navigator: { userAgent } }, async () => {
      assertEquals(await deviceInfo(), expected as Any, userAgent);
    });
  }
  await withGlobals({ navigator: undefined }, async () => {
    assertEquals(await deviceInfo(), { platform: "web" });
  });
});

// ---- network ---------------------------------------------------------------

/** A fake Network plugin whose listener handle arrives through a promise. */
function fakeNetwork(initial: { connected: boolean; connectionType: string }) {
  let listener: ((s: unknown) => void) | undefined;
  let removed = 0;
  let resolveHandle: (() => void) | undefined;
  const plugin = {
    getStatus: () => Promise.resolve(initial),
    addListener: (event: string, fn: (s: unknown) => void) => {
      assertEquals(event, "networkStatusChange");
      listener = fn;
      return new Promise((resolve) => {
        resolveHandle = () =>
          resolve({
            remove: () => {
              removed++;
              listener = undefined;
              return Promise.resolve();
            },
          });
      });
    },
  };
  return {
    plugin,
    emit: (s: unknown) => listener?.(s),
    resolveHandle: () => resolveHandle?.(),
    removed: () => removed,
  };
}

Deno.test("networkStatus: native getStatus, and the web navigator.onLine fallback", async () => {
  const net = fakeNetwork({ connected: true, connectionType: "cellular" });
  await inShell({ Network: net.plugin }, async () => {
    assertEquals(await networkStatus(), { connected: true, connectionType: "cellular" });
  });
  await withGlobals({ navigator: { onLine: false } }, async () => {
    assertEquals(await networkStatus(), { connected: false, connectionType: "none" });
  });
  await withGlobals({ navigator: { onLine: true, connection: { type: "wifi" } } }, async () => {
    assertEquals(await networkStatus(), { connected: true, connectionType: "wifi" });
  });
  await withGlobals({ navigator: undefined }, async () => {
    assertEquals(await networkStatus(), { connected: true, connectionType: "unknown" });
  });
});

Deno.test("useNetworkStatus: native listener updates, removed on unmount", async () => {
  const net = fakeNetwork({ connected: true, connectionType: "wifi" });
  await inShell({ Network: net.plugin }, async () => {
    const seen: { v?: NetworkStatus } = {};
    const { root, rerender } = mount(function Probe() {
      seen.v = useNetworkStatus();
      return null;
    });
    assertEquals(seen.v, { connected: true, connectionType: "unknown" }, "before the first read");
    net.resolveHandle();
    await tick();
    rerender();
    assertEquals(seen.v, { connected: true, connectionType: "wifi" });
    net.emit({ connected: false, connectionType: "none" });
    flushSync();
    rerender();
    assertEquals(seen.v, { connected: false, connectionType: "none" });
    root.unmount();
    await tick();
    assertEquals(net.removed(), 1);
  });
});

Deno.test("useNetworkStatus: an unmount before the handle arrives still removes it", async () => {
  const net = fakeNetwork({ connected: true, connectionType: "wifi" });
  await inShell({ Network: net.plugin }, async () => {
    const { root } = mount(function Probe() {
      useNetworkStatus();
      return null;
    });
    root.unmount();
    assertEquals(net.removed(), 0);
    net.resolveHandle();
    await tick();
    assertEquals(net.removed(), 1, "removed as soon as it arrived");
  });
});

Deno.test("useNetworkStatus: web online/offline events", async () => {
  const listeners = new Map<string, () => void>();
  const nav = { onLine: true };
  await withGlobals({
    navigator: nav,
    addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
  }, () => {
    const seen: { v?: NetworkStatus } = {};
    const { root, rerender } = mount(function Probe() {
      seen.v = useNetworkStatus();
      return null;
    });
    rerender();
    assertEquals(seen.v, { connected: true, connectionType: "unknown" });
    nav.onLine = false;
    listeners.get("offline")!();
    rerender();
    assertEquals(seen.v, { connected: false, connectionType: "none" });
    root.unmount();
    assertEquals(listeners.size, 0, "unsubscribed");
  });
});

// ---- useKeepAwake ----------------------------------------------------------

Deno.test("useKeepAwake: native keepAwake/allowSleep, shared across callers", async () => {
  const { plugin, calls } = recorder(["keepAwake", "allowSleep"]);
  await inShell({ KeepAwake: plugin }, () => {
    const a = mount(function Probe() {
      useKeepAwake();
      return null;
    });
    const b = mount(function Probe() {
      useKeepAwake();
      return null;
    });
    assertEquals(calls.map((c) => c[0]), ["keepAwake"]);
    a.root.unmount();
    assertEquals(calls.map((c) => c[0]), ["keepAwake"], "still held by the other");
    b.root.unmount();
    assertEquals(calls.map((c) => c[0]), ["keepAwake", "allowSleep"]);

    let active = false;
    const c = mount(function Probe() {
      useKeepAwake(active);
      return null;
    });
    assertEquals(calls.length, 2, "inactive: nothing held");
    active = true;
    c.rerender();
    assertEquals(calls.length, 3);
    active = false;
    c.rerender();
    assertEquals(calls.map((x) => x[0]).slice(2), ["keepAwake", "allowSleep"]);
    c.root.unmount();
  });
});

/** A fake `navigator.wakeLock` whose requests resolve when `settle()` is called. */
function fakeWakeLock() {
  const sentinels: Array<{ released: boolean; release: () => Promise<void> }> = [];
  const pending: Array<() => void> = [];
  return {
    sentinels,
    wakeLock: {
      request: (type: string) => {
        assertEquals(type, "screen");
        return new Promise((resolve) => {
          pending.push(() => {
            const s = {
              released: false,
              release: () => Promise.resolve(void (s.released = true)),
            };
            sentinels.push(s);
            resolve(s);
          });
        });
      },
    },
    settle: () => pending.splice(0).forEach((f) => f()),
    requests: () => sentinels.length + pending.length,
  };
}

/** A fake `document` for visibility, alongside the DOM `mount` installs for the reconciler. */
function fakeVisibility() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
  };
  return { doc, fire: () => listeners.forEach((f) => f()), count: () => listeners.size };
}

Deno.test("useKeepAwake: web wake lock, re-acquired on visibility, released on unmount", async () => {
  const lock = fakeWakeLock();
  const vis = fakeVisibility();
  await withGlobals({ navigator: { wakeLock: lock.wakeLock }, document: vis.doc }, async () => {
    const { root } = mount(function Probe() {
      useKeepAwake();
      return null;
    });
    lock.settle();
    await tick();
    assertEquals(lock.sentinels.length, 1);
    // The browser drops it on hide; coming back re-requests.
    lock.sentinels[0].released = true;
    vis.doc.visibilityState = "hidden";
    vis.fire();
    assertEquals(lock.requests(), 1, "not while hidden");
    vis.doc.visibilityState = "visible";
    vis.fire();
    lock.settle();
    await tick();
    assertEquals(lock.sentinels.length, 2);
    root.unmount();
    await tick();
    assert(lock.sentinels[1].released, "released on unmount");
    assertEquals(vis.count(), 0);
  });
});

Deno.test("useKeepAwake: a lock granted after unmount is released at once; no API is a no-op", async () => {
  const lock = fakeWakeLock();
  const vis = fakeVisibility();
  await withGlobals({ navigator: { wakeLock: lock.wakeLock }, document: vis.doc }, async () => {
    const { root } = mount(function Probe() {
      useKeepAwake();
      return null;
    });
    root.unmount();
    lock.settle();
    await tick();
    assert(lock.sentinels[0].released);
  });
  await withGlobals({ navigator: {} }, () => {
    const { root } = mount(function Probe() {
      useKeepAwake();
      return null;
    });
    root.unmount();
  });
});

// ---- hideSplash ------------------------------------------------------------

Deno.test("hideSplash: native SplashScreen.hide, a no-op on the web", async () => {
  const { plugin, calls } = recorder(["hide"]);
  await inShell({ SplashScreen: plugin }, () => hideSplash());
  assertEquals(calls, [["hide", undefined]]);
  await hideSplash();
  await inShell({}, () => hideSplash());
  assertEquals(calls.length, 1);
});

// ---- secureStore -----------------------------------------------------------

Deno.test("secureStore: native SecureStorage internal* calls with the plugin's prefix", async () => {
  const { plugin, calls } = recorder(
    ["internalGetItem", "internalSetItem", "internalRemoveItem"],
    { internalGetItem: { data: "tok" }, internalRemoveItem: { success: true } },
  );
  await inShell({ SecureStorage: plugin }, async () => {
    await secureStore.set("token", "tok");
    assertEquals(await secureStore.get("token"), "tok");
    await secureStore.delete("token");
  });
  assertEquals(calls, [
    [
      "internalSetItem",
      { prefixedKey: "capacitor-storage_token", data: "tok", sync: false, access: 0 },
    ],
    ["internalGetItem", { prefixedKey: "capacitor-storage_token", sync: false }],
    ["internalRemoveItem", { prefixedKey: "capacitor-storage_token", sync: false }],
  ]);
  const missing = recorder(["internalGetItem", "internalSetItem", "internalRemoveItem"], {
    internalGetItem: { data: null },
  });
  await inShell({ SecureStorage: missing.plugin }, async () => {
    assertEquals(await secureStore.get("nope"), null);
  });
  await assertRejects(() => secureStore.get(""), TypeError, "non-empty");
  await assertRejects(() => secureStore.set("k", 1 as Any), TypeError, "must be a string");
});

/** A minimal IndexedDB: one database, one store, requests settling asynchronously. */
function fakeIndexedDB() {
  const data = new Map<string, unknown>();
  const opened: Array<[string, number]> = [];
  const stores: string[] = [];
  const request = (fn: () => unknown) => {
    const r: Any = {};
    queueMicrotask(() => {
      r.result = fn();
      r.onsuccess?.();
    });
    return r;
  };
  const db = {
    createObjectStore: (name: string) => void stores.push(name),
    close: () => {},
    transaction: (store: string, _mode: string) => {
      const tx: Any = {
        objectStore: (name: string) => {
          assertEquals(name, store);
          return {
            get: (k: string) => request(() => data.get(k)),
            put: (v: unknown, k: string) => request(() => void data.set(k, v)),
            delete: (k: string) => request(() => void data.delete(k)),
          };
        },
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  return {
    data,
    opened,
    stores,
    indexedDB: {
      open: (name: string, version: number) => {
        opened.push([name, version]);
        const r: Any = {};
        queueMicrotask(() => {
          r.result = db;
          if (stores.length === 0) r.onupgradeneeded?.();
          r.onsuccess?.();
        });
        return r;
      },
    },
  };
}

Deno.test("secureStore: web IndexedDB fallback; rejects without IndexedDB", async () => {
  const idb = fakeIndexedDB();
  await withGlobals({ indexedDB: idb.indexedDB }, async () => {
    assertEquals(await secureStore.get("a"), null);
    await secureStore.set("a", "1");
    assertEquals(await secureStore.get("a"), "1");
    await secureStore.delete("a");
    assertEquals(await secureStore.get("a"), null);
  });
  assertEquals(idb.opened[0], ["denext-secure-store", 1]);
  assertEquals(idb.stores, ["kv"]);
  await withGlobals({ indexedDB: undefined }, async () => {
    await assertRejects(() => secureStore.get("a"), Error, "no IndexedDB");
  });
});
