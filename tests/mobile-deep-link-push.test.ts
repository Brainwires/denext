// denext/mobile deep links and push notifications, inside a faked Capacitor shell: a
// `globalThis.Capacitor` whose `Plugins.App` / `Plugins.PushNotifications` record listeners and
// let a test fire native events. Navigation is observed through a fake `history` +
// `dispatchEvent` (the default router seam) or a `route` function. Every global is restored and
// the modules' page-lifetime state is reset between tests.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  type DeepLinkEvent,
  onDeepLink,
  onPushReceived,
  onPushTapped,
  type PushTap,
  registerForPush,
  requestPushPermission,
  useDeepLink,
  usePushReceived,
  usePushTapped,
} from "../src/mobile/mod.ts";
import { resetDeepLinksForTesting } from "../src/mobile/deep-link.ts";
import { resetPushForTesting } from "../src/mobile/push.ts";
import { acceptsLink, internalPath, linkPath } from "../src/mobile/link-routing.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A fake plugin: listeners by event, `fire` to emit, `removed` counts handle removals. */
function fakePlugin(methods: Record<string, (...args: Any[]) => unknown> = {}) {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let removed = 0;
  /** When set, addListener's handle arrives only when this resolves. */
  let gate: Promise<void> | undefined;
  const plugin = {
    ...methods,
    addListener(event: string, fn: (data: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(fn);
      const handle = {
        remove: () => {
          removed++;
          set.delete(fn);
          return Promise.resolve();
        },
      };
      return gate ? gate.then(() => handle) : Promise.resolve(handle);
    },
  };
  return {
    plugin,
    fire: (event: string, data: unknown) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
    removed: () => removed,
    setGate: (p: Promise<void> | undefined) => void (gate = p),
  };
}

/** The navigations the default router made (pushState paths, and popstate count). */
interface NavLog {
  pushed: string[];
  popstates: number;
}

/**
 * Run `fn` inside a native shell whose plugins are `plugins`, with a fake history; restores
 * every global and resets the modules' state afterwards.
 */
async function inShell(
  plugins: Record<string, unknown>,
  fn: (nav: NavLog) => unknown | Promise<unknown>,
  platform = "ios",
): Promise<void> {
  const nav: NavLog = { pushed: [], popstates: 0 };
  const g = globalThis as Any;
  const keys = ["Capacitor", "history", "dispatchEvent", "PopStateEvent"];
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const values: Record<string, unknown> = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins },
    history: { pushState: (_d: unknown, _u: string, url: string) => void nav.pushed.push(url) },
    dispatchEvent: (e: Event) => (e.type === "popstate" && nav.popstates++, true),
    PopStateEvent: class extends Event {},
  };
  for (const k of keys) {
    Object.defineProperty(g, k, { configurable: true, writable: true, value: values[k] });
  }
  try {
    await fn(nav);
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(g, k, desc);
      else delete g[k];
    }
    resetDeepLinksForTesting();
    resetPushForTesting();
    sessionStorage.clear();
  }
}

/** A promise with its resolver. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let queued promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** An App plugin whose getLaunchUrl() answers `launch` (after `wait`, when given). */
function appPlugin(launch?: string, wait?: Promise<void>) {
  let asked = 0;
  const fake = fakePlugin({
    getLaunchUrl: async () => {
      asked++;
      await wait;
      return launch === undefined ? undefined : { url: launch };
    },
  });
  return { ...fake, asked: () => asked };
}

// ---- link routing helpers ----------------------------------------------------------------

Deno.test("link routing: accept rules, path mapping and internal-path checks", () => {
  const u = (s: string) => new URL(s);
  assert(acceptsLink(u("myapp://threads/1"), undefined), "any custom scheme by default");
  assert(!acceptsLink(u("https://evil.example/x"), undefined), "no https host by default");
  assert(!acceptsLink(u("http://app.example.com/x"), { hosts: ["app.example.com"] }));
  assert(!acceptsLink(u("javascript:alert(1)"), undefined));
  assert(acceptsLink(u("https://App.Example.com/x"), { hosts: ["app.example.com"] }));
  assert(acceptsLink(u("https://eu.example.com/x"), { hosts: ["*.example.com"] }));
  assert(!acceptsLink(u("https://example.com.evil.io/x"), { hosts: ["*.example.com"] }));
  assert(acceptsLink(u("MyApp://x"), { schemes: ["myapp:"] }));
  assert(!acceptsLink(u("other://x"), { schemes: ["myapp"] }));
  assert(
    !acceptsLink(u("myapp://x"), () => {
      throw new Error("boom");
    }),
  );

  assertEquals(linkPath(u("myapp://threads/42?x=1#h")), "/threads/42?x=1#h");
  assertEquals(linkPath(u("myapp:///threads/42")), "/threads/42");
  assertEquals(linkPath(u("myapp:threads/42")), "/threads/42");
  assertEquals(linkPath(u("myapp://")), "/");
  assertEquals(linkPath(u("myapp://threads/")), "/threads");
  assertEquals(linkPath(u("https://app.example.com/a/b?c#d")), "/a/b?c#d");

  assertEquals(internalPath("/ok/../x"), "/x");
  assertEquals(internalPath("//evil.example/x"), undefined);
  assertEquals(internalPath("/\\evil.example"), undefined);
  assertEquals(internalPath("https://evil.example"), undefined);
});

// ---- deep links --------------------------------------------------------------------------

Deno.test("onDeepLink: the cold launch URL is delivered once, and its native copy dropped", async () => {
  const app = appPlugin("myapp://threads/1");
  await inShell({ App: app.plugin }, async (nav) => {
    const a: DeepLinkEvent[] = [];
    const b: DeepLinkEvent[] = [];
    const stopA = onDeepLink((e) => a.push(e));
    const stopB = onDeepLink((e) => b.push(e));
    // Capacitor 8 also retains the launch link as an appUrlOpen for the first listener.
    app.fire("appUrlOpen", { url: "myapp://threads/1" });
    await settle();
    const launch = { url: "myapp://threads/1", path: "/threads/1", launch: true };
    assertEquals(a, [launch]);
    assertEquals(b, [launch], "every early subscriber sees the launch link");
    assertEquals(nav.pushed, ["/threads/1"], "navigated once for two subscribers");
    assertEquals(nav.popstates, 1);
    assertEquals(app.asked(), 1);

    // A later subscriber (a remount after navigation) never gets the launch link again.
    const late: DeepLinkEvent[] = [];
    const stopLate = onDeepLink((e) => late.push(e));
    await settle();
    assertEquals(late, []);
    assertEquals(app.asked(), 1, "getLaunchUrl is asked once per page");
    stopA();
    stopB();
    stopLate();
  });
});

Deno.test("onDeepLink: warm links reach every subscriber; a reload does not replay the launch", async () => {
  const app = appPlugin("myapp://start");
  await inShell({ App: app.plugin }, async (nav) => {
    const seen: DeepLinkEvent[] = [];
    const stop = onDeepLink((e) => seen.push(e), { route: false });
    await settle();
    app.fire("appUrlOpen", { url: "myapp://threads/2" });
    app.fire("appUrlOpen", { url: "myapp://start" }); // the launch copy: dropped once
    app.fire("appUrlOpen", { url: "myapp://start" }); // a real second open
    app.fire("appUrlOpen", { url: "" }); // ignored
    assertEquals(seen.map((e) => [e.url, e.launch]), [
      ["myapp://start", true],
      ["myapp://threads/2", false],
      ["myapp://start", false],
    ]);
    assertEquals(nav.pushed, [], "route: false leaves navigation to the callback");
    stop();
    assertEquals(app.count("appUrlOpen"), 0, "the native listener goes with the last subscriber");

    // Same webview session, new page (an OTA reload): the shell still answers the launch URL.
    resetDeepLinksForTesting();
    sessionStorage.setItem("denext:deep-link:last", "myapp://start");
    const after: DeepLinkEvent[] = [];
    const stop2 = onDeepLink((e) => after.push(e));
    await settle();
    assertEquals(after, []);
    stop2();
  });
});

Deno.test("onDeepLink: links that arrive before getLaunchUrl answers wait for it", async () => {
  const gate = deferred<void>();
  const app = appPlugin(undefined, gate.promise);
  await inShell({ App: app.plugin }, async () => {
    const seen: string[] = [];
    const stop = onDeepLink((e) => seen.push(`${e.url}:${e.launch}`));
    app.fire("appUrlOpen", { url: "myapp://early" });
    await settle();
    assertEquals(seen, []);
    gate.resolve();
    await settle();
    assertEquals(seen, ["myapp://early:false"]);
    stop();
  });
});

Deno.test("onDeepLink: a rejected link reaches neither the callback nor the router", async () => {
  const app = appPlugin();
  await inShell({ App: app.plugin }, async (nav) => {
    const seen: string[] = [];
    const stop = onDeepLink((e) => seen.push(e.url), { accept: { hosts: ["app.example.com"] } });
    await settle();
    app.fire("appUrlOpen", { url: "https://evil.example/steal" });
    app.fire("appUrlOpen", { url: "not a url" });
    app.fire("appUrlOpen", { url: "https://app.example.com/threads/9?x=1" });
    assertEquals(seen, ["https://app.example.com/threads/9?x=1"]);
    assertEquals(nav.pushed, ["/threads/9?x=1"]);
    stop();

    const predicate: string[] = [];
    const stop2 = onDeepLink((e) => predicate.push(e.url), {
      accept: (url) => url.pathname.startsWith("/ok"),
      route: (path, url) => predicate.push(`routed ${path} from ${url.protocol}`),
    });
    app.fire("appUrlOpen", { url: "myapp://host/ok/1" }); // pathname /ok/1: accepted
    app.fire("appUrlOpen", { url: "myapp://nope/2" }); // refused by the predicate
    assertEquals(predicate, ["myapp://host/ok/1", "routed /host/ok/1 from myapp:"]);
    stop2();
  });
});

Deno.test("onDeepLink: a function route navigates with the app's router", async () => {
  const app = appPlugin();
  await inShell({ App: app.plugin }, async (nav) => {
    const routed: string[] = [];
    const stop = onDeepLink(() => {}, {
      accept: { schemes: ["myapp"] },
      route: (path) => routed.push(path),
    });
    await settle();
    app.fire("appUrlOpen", { url: "myapp://threads/7#m" });
    app.fire("appUrlOpen", { url: "otherapp://threads/8" });
    assertEquals(routed, ["/threads/7#m"]);
    assertEquals(nav.pushed, []);
    stop();
  });
});

Deno.test("onDeepLink: disposing before the listener handle arrives still removes it", async () => {
  const app = appPlugin();
  const gate = deferred<void>();
  app.setGate(gate.promise);
  await inShell({ App: app.plugin }, async () => {
    const stop = onDeepLink(() => {});
    stop();
    stop(); // idempotent
    assertEquals(app.removed(), 0);
    gate.resolve();
    await settle();
    assertEquals(app.removed(), 1);
    assertEquals(app.count("appUrlOpen"), 0);
  });
});

Deno.test("onDeepLink: a listener still being removed does not deliver twice", async () => {
  const app = appPlugin();
  const gate = deferred<void>();
  app.setGate(gate.promise); // handles (so removals) wait for the gate
  await inShell({ App: app.plugin }, async () => {
    const seen: string[] = [];
    onDeepLink(() => seen.push("old"), { route: false })(); // removal in flight
    const stop = onDeepLink((e) => seen.push(e.url), { route: false });
    await settle(); // getLaunchUrl answers; the handles are still pending
    assertEquals(app.count("appUrlOpen"), 2, "the old native listener is not gone yet");
    app.fire("appUrlOpen", { url: "myapp://once" });
    assertEquals(seen, ["myapp://once"]);
    stop();
    gate.resolve();
    await settle();
    assertEquals(app.count("appUrlOpen"), 0);
  });
});

Deno.test("onDeepLink: a launch link that finds no subscriber goes to the next one", async () => {
  const gate = deferred<void>();
  const app = appPlugin("myapp://pending", gate.promise);
  await inShell({ App: app.plugin }, async () => {
    const first: string[] = [];
    onDeepLink((e) => first.push(e.url), { route: false })();
    gate.resolve();
    await settle();
    assertEquals(first, []);
    const next: DeepLinkEvent[] = [];
    const stop = onDeepLink((e) => next.push(e), { route: false });
    await settle();
    assertEquals(next.map((e) => [e.url, e.launch]), [["myapp://pending", true]]);
    stop();
  });
});

Deno.test("onDeepLink / push: nothing to do on the web", async () => {
  const stop = onDeepLink(() => {
    throw new Error("never");
  });
  stop();
  onPushReceived(() => {})();
  onPushTapped(() => {})();
  assertEquals(await requestPushPermission(), "unsupported");
  await assertRejects(() => registerForPush(), Error, "no web-push fallback");
});

// ---- push ----------------------------------------------------------------------------------

/** A PushNotifications plugin; `register` fires `onRegister` (if given) after it resolves. */
function pushPlugin(opts: {
  check?: string;
  request?: string;
  onRegister?: (fire: (event: string, data: unknown) => void) => void;
} = {}) {
  let registers = 0;
  let requests = 0;
  const fake = fakePlugin({
    checkPermissions: () => Promise.resolve({ receive: opts.check ?? "granted" }),
    requestPermissions: () => (requests++, Promise.resolve({ receive: opts.request })),
    register: () => {
      registers++;
      queueMicrotask(() => opts.onRegister?.(fake.fire));
      return Promise.resolve();
    },
  });
  return { ...fake, registers: () => registers, requests: () => requests };
}

Deno.test("requestPushPermission: a decided state, else the prompt's answer", async () => {
  const cases: Array<[string, string | undefined, string, number]> = [
    ["granted", undefined, "granted", 0],
    ["denied", undefined, "denied", 0],
    ["prompt", "granted", "granted", 1],
    ["prompt-with-rationale", "denied", "denied", 1],
    ["prompt", "prompt", "prompt", 1],
  ];
  for (const [check, request, want, prompts] of cases) {
    const push = pushPlugin({ check, request });
    await inShell({ PushNotifications: push.plugin }, async () => {
      assertEquals(await requestPushPermission(), want, check);
      assertEquals(push.requests(), prompts, check);
    });
  }
});

Deno.test("registerForPush: resolves the token, sharing one in-flight registration", async () => {
  const push = pushPlugin({ onRegister: (fire) => fire("registration", { value: "ABC123" }) });
  await inShell({ PushNotifications: push.plugin }, async () => {
    const [a, b] = await Promise.all([registerForPush(), registerForPush()]);
    assertEquals(a, { platform: "ios", token: "ABC123" });
    assertEquals(b, a);
    assertEquals(push.registers(), 1, "concurrent calls share one registration");
    assertEquals(push.count("registration"), 0, "its listeners are removed");
    assertEquals(push.count("registrationError"), 0);
    await registerForPush();
    assertEquals(push.registers(), 2, "a later call registers again");
  }, "ios");
  const android = pushPlugin({ onRegister: (fire) => fire("registration", { value: "fcm" }) });
  await inShell({ PushNotifications: android.plugin }, async () => {
    assertEquals(await registerForPush(), { platform: "android", token: "fcm" });
  }, "android");
});

Deno.test("registerForPush: a registrationError, an empty token and a timeout reject", async () => {
  const failing = pushPlugin({
    onRegister: (fire) => fire("registrationError", { error: "no aps-environment" }),
  });
  await inShell({ PushNotifications: failing.plugin }, async () => {
    await assertRejects(() => registerForPush(), Error, "registerForPush: no aps-environment");
    assertEquals(failing.count("registration"), 0);
  });
  const empty = pushPlugin({ onRegister: (fire) => fire("registration", { value: "" }) });
  await inShell({ PushNotifications: empty.plugin }, async () => {
    await assertRejects(() => registerForPush(), Error, "empty token");
  });
  const silent = pushPlugin();
  await inShell({ PushNotifications: silent.plugin }, async () => {
    const err = await assertRejects(() => registerForPush({ timeoutMs: 5 }), Error);
    assertStringIncludes(err.message, "no token within 5 ms");
    assertStringIncludes(err.message, "AppDelegate.swift");
    assertEquals(silent.count("registration"), 0, "listeners removed after a timeout");
  });
});

Deno.test("onPushReceived: fans one native listener out, mapped", async () => {
  const push = pushPlugin();
  await inShell({ PushNotifications: push.plugin }, async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = onPushReceived((n) => a.push(n));
    const stopB = onPushReceived((n) => b.push(n));
    assertEquals(push.count("pushNotificationReceived"), 1);
    push.fire("pushNotificationReceived", { id: "1", title: "T", body: "B", data: { k: 1 } });
    push.fire("pushNotificationReceived", { id: 2, data: null });
    const want = [
      { id: "1", title: "T", body: "B", data: { k: 1 } },
      { id: undefined, title: undefined, body: undefined, data: {} },
    ];
    assertEquals(a, want);
    assertEquals(b, want);
    stopA();
    stopB();
    await settle();
    assertEquals(push.count("pushNotificationReceived"), 0);
  });
});

Deno.test("onPushTapped: routes data.path / data.url once, under the accept rules", async () => {
  const push = pushPlugin();
  await inShell({ PushNotifications: push.plugin }, (nav) => {
    const taps: PushTap[] = [];
    const stopA = onPushTapped((t) => taps.push(t));
    const stopB = onPushTapped(() => {});
    const tap = (data: unknown, actionId?: string) =>
      push.fire("pushNotificationActionPerformed", {
        actionId,
        notification: { id: "n", title: "T", body: "B", data },
      });
    tap({ path: "/threads/1" });
    tap({ url: "myapp://threads/2" });
    tap({ url: "https://evil.example/x" }); // refused: no hosts listed
    tap({ path: "//evil.example/x" }); // not an in-app path
    tap({ path: "/threads/3" }, "reply");
    tap({});
    assertEquals(nav.pushed, ["/threads/1", "/threads/2", "/threads/3"]);
    assertEquals(taps.length, 6, "the callback sees every tap");
    assertEquals(taps[0].actionId, "tap");
    assertEquals(taps[4].actionId, "reply");
    assertEquals(taps[0].notification, {
      id: "n",
      title: "T",
      body: "B",
      data: { path: "/threads/1" },
    });
    stopA();
    stopB();

    const routed: string[] = [];
    const stopC = onPushTapped(() => {}, {
      accept: (url) => !url.pathname.startsWith("/admin"),
      route: (path) => routed.push(path),
    });
    tap({ path: "/admin/x" });
    tap({ path: "/inbox" });
    tap({ url: "myapp:///admin/y" }); // the predicate sees the parsed URL: /admin/y
    tap({ url: "::bad" });
    assertEquals(routed, ["/inbox"]);
    stopC();

    const off: string[] = [];
    const stopD = onPushTapped((t) => off.push(String(t.notification.data.path)), {
      route: false,
    });
    tap({ path: "/nowhere" });
    assertEquals(off, ["/nowhere"]);
    assertEquals(nav.pushed.length, 3, "route: false navigates nothing");
    stopD();
  });
});

Deno.test("onPushTapped: a cold-start tap retained by the shell reaches the first listener", async () => {
  const push = pushPlugin();
  // The shell keeps pushNotificationActionPerformed (retainUntilConsumed) until a listener
  // attaches, then flushes it to that listener: model the flush on the first addListener.
  const addListener = push.plugin.addListener;
  push.plugin.addListener = (event: string, fn: (data: unknown) => void) => {
    const handle = addListener(event, fn);
    if (event === "pushNotificationActionPerformed") {
      queueMicrotask(() => fn({ actionId: "tap", notification: { data: { path: "/cold" } } }));
    }
    return handle;
  };
  await inShell({ PushNotifications: push.plugin }, async (nav) => {
    const seen: string[] = [];
    const stop = onPushTapped((t) => seen.push(String(t.notification.data.path)));
    await settle();
    assertEquals(seen, ["/cold"]);
    assertEquals(nav.pushed, ["/cold"]);
    stop();
  });
});

// ---- hooks ---------------------------------------------------------------------------------

/** Mount `render` in a probe component on a fake DOM; returns the root. */
function mountProbe(render: () => unknown) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const Probe = () => render();
  const root = createRoot(container as Any);
  root.render(h(Probe as Any, {}));
  flushSync();
  return root;
}

Deno.test("useDeepLink / usePushTapped / usePushReceived: subscribe on mount, latest callback", async () => {
  const app = appPlugin();
  const push = pushPlugin();
  await inShell({ App: app.plugin, PushNotifications: push.plugin }, async (nav) => {
    const got: string[] = [];
    const root = mountProbe(function Probe() {
      useDeepLink((e) => got.push(`link ${e.url}`), { route: false });
      usePushTapped((t) => got.push(`tap ${t.actionId}`), { route: (p) => got.push(`to ${p}`) });
      usePushReceived((n) => got.push(`got ${n.title}`));
      return null;
    });
    await settle();
    app.fire("appUrlOpen", { url: "myapp://x" });
    push.fire("pushNotificationActionPerformed", { notification: { data: { path: "/p" } } });
    push.fire("pushNotificationReceived", { title: "hi", data: {} });
    assertEquals(got, ["link myapp://x", "tap tap", "to /p", "got hi"]);
    assertEquals(nav.pushed, []);
    root.unmount();
    await settle();
    assertEquals(app.count("appUrlOpen"), 0);
    assertEquals(push.count("pushNotificationActionPerformed"), 0);
    assertEquals(push.count("pushNotificationReceived"), 0);
  });
});
