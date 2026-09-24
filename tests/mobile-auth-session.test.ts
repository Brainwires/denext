// denext/mobile openAuthSession / completeAuthSession: the native path through a faked
// `Capacitor.Plugins.DenextAuthSession`, and the web popup fallback through a faked
// `window.open` / popup / `message` events. Every global is restored and the module state reset
// between tests.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type AuthSessionError,
  completeAuthSession,
  onDeepLink,
  openAuthSession,
} from "../src/mobile/mod.ts";
import { isAuthSessionCallback, resetAuthSessionForTesting } from "../src/mobile/auth-session.ts";
import { resetDeepLinksForTesting } from "../src/mobile/deep-link.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ORIGIN = "https://app.example.com";
const AUTHORIZE = "https://auth.example.com/authorize?client_id=x&state=s1";

/** Define `values` on globalThis for `fn`, then restore every one and reset module state. */
async function withGlobals(values: Record<string, unknown>, fn: () => unknown): Promise<void> {
  const g = globalThis as Any;
  const saved = Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const [k, v] of Object.entries(values)) {
    Object.defineProperty(g, k, { configurable: true, writable: true, value: v });
  }
  try {
    await fn();
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(g, k, desc);
      else delete g[k];
    }
    resetAuthSessionForTesting();
    resetDeepLinksForTesting();
  }
}

/** A native shell whose plugins are `plugins`. */
const inShell = (plugins: Record<string, unknown>, fn: () => unknown, platform = "ios") =>
  withGlobals({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins },
  }, fn);

/** A promise with its resolver and rejecter. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake DenextAuthSession plugin whose `start` answers from `answer` (default: pending). */
function authPlugin(answer?: (options: Any) => Promise<unknown>) {
  const starts: Any[] = [];
  let cancels = 0;
  const pending = deferred<unknown>();
  return {
    starts,
    cancels: () => cancels,
    pending,
    plugin: {
      start: (options: Any) => {
        starts.push(options);
        return answer ? answer(options) : pending.promise;
      },
      cancel: () => {
        cancels++;
        return Promise.resolve();
      },
    },
  };
}

/** The rejection's code (asserting it is an AuthSessionError). */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await assertRejects(() => promise) as AuthSessionError;
  assert(err instanceof Error);
  assertEquals(err.name, "AuthSessionError");
  return err.code;
}

// ---------------------------------------------------------------------------------------------
// Native

Deno.test("openAuthSession (native): resolves with the callback URL; passes the options", async () => {
  const fake = authPlugin(() => Promise.resolve({ url: "myapp://auth/callback?code=c&state=s1" }));
  await inShell({ DenextAuthSession: fake.plugin }, async () => {
    const result = await openAuthSession(AUTHORIZE, {
      callbackScheme: "myapp",
      preferEphemeral: true,
    });
    assertEquals(result, { url: "myapp://auth/callback?code=c&state=s1" });
    assertEquals(fake.starts, [{
      url: AUTHORIZE,
      callbackScheme: "myapp",
      preferEphemeral: true,
    }]);
    // preferEphemeral defaults to false.
    await openAuthSession(AUTHORIZE, { callbackScheme: "myapp" });
    assertEquals(fake.starts[1].preferEphemeral, false);
  });
});

Deno.test("openAuthSession (native): rejection codes are mapped; unknown ones read unsupported", async () => {
  let next: unknown;
  const fake = authPlugin(() => Promise.reject(next));
  await inShell({ DenextAuthSession: fake.plugin }, async () => {
    for (const code of ["cancelled", "busy", "invalid", "unsupported", "timeout"]) {
      next = Object.assign(new Error(`native ${code}`), { code });
      assertEquals(await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })), code);
    }
    next = Object.assign(new Error("something else"), { code: "UNIMPLEMENTED" });
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })),
      "unsupported",
    );
    // A shell answer that is not a callback for the scheme is refused.
    const odd = authPlugin(() => Promise.resolve({ url: "other://x" }));
    (globalThis as Any).Capacitor.Plugins.DenextAuthSession = odd.plugin;
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })),
      "unsupported",
    );
  });
});

Deno.test("openAuthSession: one session at a time (busy), in JS before the native side", async () => {
  const fake = authPlugin();
  await inShell({ DenextAuthSession: fake.plugin }, async () => {
    const first = openAuthSession(AUTHORIZE, { callbackScheme: "myapp" });
    assertEquals(await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })), "busy");
    assertEquals(fake.starts.length, 1);
    fake.pending.resolve({ url: "myapp://cb?code=1" });
    assertEquals((await first).url, "myapp://cb?code=1");
    // Settled: a new session may start.
    const again = authPlugin(() => Promise.resolve({ url: "myapp://cb?code=2" }));
    (globalThis as Any).Capacitor.Plugins.DenextAuthSession = again.plugin;
    assertEquals(
      (await openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })).url,
      "myapp://cb?code=2",
    );
  });
});

Deno.test("openAuthSession: invalid url, scheme or timeout reject before anything opens", async () => {
  const fake = authPlugin();
  await inShell({ DenextAuthSession: fake.plugin }, async () => {
    const bad: Array<[string, Any]> = [
      ["http://auth.example.com/authorize", { callbackScheme: "myapp" }],
      ["/authorize", { callbackScheme: "myapp" }],
      ["javascript:alert(1)", { callbackScheme: "myapp" }],
      [AUTHORIZE, { callbackScheme: "" }],
      [AUTHORIZE, { callbackScheme: "MyApp" }],
      [AUTHORIZE, { callbackScheme: "myapp://" }],
      [AUTHORIZE, { callbackScheme: "https" }],
      [AUTHORIZE, { callbackScheme: "1app" }],
      [AUTHORIZE, {}],
      [AUTHORIZE, { callbackScheme: "myapp", timeoutMs: 0 }],
      [AUTHORIZE, { callbackScheme: "myapp", timeoutMs: Number.NaN }],
    ];
    for (const [url, options] of bad) {
      assertEquals(
        await codeOf(openAuthSession(url, options)),
        "invalid",
        `${url} ${JSON.stringify(options)}`,
      );
    }
    assertEquals(fake.starts, []);
  });
});

Deno.test("openAuthSession (native): no plugin in the shell is unsupported", async () => {
  await inShell({}, async () => {
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })),
      "unsupported",
    );
  });
});

Deno.test("openAuthSession (native): timeoutMs rejects timeout and cancels the native session", async () => {
  const fake = authPlugin();
  await inShell({ DenextAuthSession: fake.plugin }, async () => {
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp", timeoutMs: 20 })),
      "timeout",
    );
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(fake.cancels(), 1);
    // The JS side is free again (the native side answers busy itself if it is not).
    fake.pending.reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
  });
});

Deno.test("openAuthSession (native): the callback is claimed from deep-link routing", async () => {
  const fake = authPlugin();
  const listeners: Array<(e: { url: string }) => void> = [];
  const app = {
    getLaunchUrl: () => Promise.resolve({}),
    addListener: (_event: string, fn: (e: { url: string }) => void) => {
      listeners.push(fn);
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  };
  await inShell({ DenextAuthSession: fake.plugin, App: app }, async () => {
    const seen: string[] = [];
    const stop = onDeepLink(({ url }) => void seen.push(url), { route: false });
    await new Promise((r) => setTimeout(r, 0));
    const session = openAuthSession(AUTHORIZE, { callbackScheme: "myapp" });
    await new Promise((r) => setTimeout(r, 0));
    assert(isAuthSessionCallback("myapp://auth/callback?code=1"));
    assert(!isAuthSessionCallback("other://x"));
    // Android: the redirect intent reaches the App plugin too.
    for (const fn of listeners) fn({ url: "myapp://auth/callback?code=1" });
    for (const fn of listeners) fn({ url: "other://open" });
    fake.pending.resolve({ url: "myapp://auth/callback?code=1" });
    await session;
    // The delivered callback stays claimed for a moment (it may land after the resolve)...
    for (const fn of listeners) fn({ url: "myapp://auth/callback?code=1" });
    // ...but other links of the scheme route again once the session settled.
    for (const fn of listeners) fn({ url: "myapp://threads/1" });
    assertEquals(seen, ["other://open", "myapp://threads/1"]);
    stop();
  }, "android");
});

// ---------------------------------------------------------------------------------------------
// Web popup fallback

/** A fake page: `window.open` returning a popup (or null), and message listeners. */
function fakePage(blocked = false) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opened: Array<[string, string, string]> = [];
  const popup = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  return {
    popup,
    opened,
    listenerCount: () => listeners.size,
    /** Deliver a message event as the browser would. */
    post: (data: unknown, origin = ORIGIN, source: unknown = popup) => {
      for (const fn of [...listeners]) fn({ data, origin, source } as unknown as MessageEvent);
    },
    globals: {
      Capacitor: undefined,
      location: { origin: ORIGIN, href: `${ORIGIN}/login` },
      open: (url: string, target: string, features: string) => {
        opened.push([url, target, features]);
        return blocked ? null : popup;
      },
      addEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: (event: MessageEvent) => void) =>
        listeners.delete(fn),
    },
  };
}

const CALLBACK = `${ORIGIN}/auth/callback?code=c&state=s1`;

Deno.test("openAuthSession (web): resolves on the popup's callback message", async () => {
  const page = fakePage();
  await withGlobals(page.globals, async () => {
    const session = openAuthSession(AUTHORIZE, { callbackScheme: "myapp" });
    assertEquals(page.opened.length, 1);
    assertEquals(page.opened[0][0], AUTHORIZE);
    assert(!page.opened[0][2].includes("noopener"));
    page.post({ type: "denext:auth-callback", url: CALLBACK });
    assertEquals(await session, { url: CALLBACK });
    assertEquals(page.listenerCount(), 0);
  });
});

Deno.test("openAuthSession (web): another origin, another source or another shape is ignored", async () => {
  const page = fakePage();
  await withGlobals(page.globals, async () => {
    const session = openAuthSession(AUTHORIZE, { callbackScheme: "myapp" });
    let settled = false;
    session.finally(() => (settled = true));
    page.post(
      { type: "denext:auth-callback", url: "https://evil.example/x" },
      "https://evil.example",
    );
    page.post({ type: "denext:auth-callback", url: "https://x/other-window" }, ORIGIN, {});
    page.post({ type: "denext:auth-callback", url: "https://x/no-source" }, ORIGIN, null);
    page.post({ type: "something-else", url: "https://x/y" });
    page.post({ type: "denext:auth-callback", url: 42 });
    await new Promise((r) => setTimeout(r, 10));
    assert(!settled);
    page.post({ type: "denext:auth-callback", url: CALLBACK });
    assertEquals((await session).url, CALLBACK);
  });
});

Deno.test("openAuthSession (web): a popup closed without a callback is cancelled", async () => {
  const page = fakePage();
  await withGlobals(page.globals, async () => {
    const session = openAuthSession(AUTHORIZE, { callbackScheme: "myapp" });
    page.popup.close();
    assertEquals(await codeOf(session), "cancelled");
    assertEquals(page.listenerCount(), 0);
  });
});

Deno.test("openAuthSession (web): a message landing just after the close still wins", async () => {
  const page = fakePage();
  await withGlobals(page.globals, async () => {
    const session = openAuthSession(AUTHORIZE, { callbackScheme: "myapp" });
    page.popup.close();
    // Past the next poll, inside the grace period.
    await new Promise((r) => setTimeout(r, 600));
    page.post({ type: "denext:auth-callback", url: CALLBACK });
    assertEquals((await session).url, CALLBACK);
  });
});

Deno.test("openAuthSession (web): a blocked popup is unsupported; so is no window", async () => {
  const page = fakePage(true);
  await withGlobals(page.globals, async () => {
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })),
      "unsupported",
    );
    // Not busy afterwards: the failed start released the session.
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })),
      "unsupported",
    );
  });
  await withGlobals({ open: undefined, Capacitor: undefined }, async () => {
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp" })),
      "unsupported",
    );
  });
});

Deno.test("openAuthSession (web): timeoutMs rejects timeout and closes the popup", async () => {
  const page = fakePage();
  await withGlobals(page.globals, async () => {
    assertEquals(
      await codeOf(openAuthSession(AUTHORIZE, { callbackScheme: "myapp", timeoutMs: 20 })),
      "timeout",
    );
    assert(page.popup.closed);
    assertEquals(page.listenerCount(), 0);
  });
});

Deno.test("completeAuthSession: posts this URL to the opener for this origin only, then closes", async () => {
  const posted: Array<[unknown, string]> = [];
  let closed = 0;
  await withGlobals({
    opener: {
      postMessage: (message: unknown, target: string) => void posted.push([message, target]),
    },
    location: { origin: ORIGIN, href: CALLBACK },
    close: () => void closed++,
  }, () => {
    assert(completeAuthSession());
    assertEquals(posted, [[{ type: "denext:auth-callback", url: CALLBACK }, ORIGIN]]);
    assertEquals(closed, 1);
  });
  await withGlobals({
    opener: null,
    location: { origin: ORIGIN, href: CALLBACK },
    close: () => void closed++,
  }, () => {
    assertEquals(completeAuthSession(), false);
    assertEquals(closed, 1);
  });
});
