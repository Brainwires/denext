// The page side of Deno Desktop deep links, opened files and custom-scheme auth sessions, driven
// through the fake runtime gate: `onDeepLink` takes the runtime's queue at subscribe (a cold start)
// and on each `available` signal, with the usual accept filter and once-only routing; a later
// subscriber does not see an earlier link; `onOpenFile` hands over read-only handles;
// `openAuthSession` picks the custom-scheme flow for a non-http redirect (or a callbackPrefix) and
// the loopback flow otherwise, maps the runtime's codes (the other-app handler included), and an
// AbortSignal cancels the runtime session.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { onDeepLink, onOpenFile, openAuthSession } from "../src/mobile/mod.ts";
import { resetDeepLinksForTesting } from "../src/mobile/deep-link.ts";
import { resetOpenFilesForTesting } from "../src/mobile/open-file.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { claimDeepLinkScheme, deepLinkSchemeOwner } from "../src/desktop/client.ts";
import { usesSchemeCallback } from "../src/desktop/auth-session.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";

type Rt = ReturnType<typeof createFakeDesktopRuntime>;

async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: Rt) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    resetDeepLinksForTesting();
    resetOpenFilesForTesting();
    restore();
  }
}

/** A `deepLinks` capability over an in-test queue. */
function linkQueue() {
  const queue: { url: string; launch: boolean }[] = [];
  return {
    queue,
    cap: { deepLinks: { take: () => queue.splice(0) } },
  };
}

Deno.test("desktop onDeepLink: a cold-start link reaches the first subscriber, once", async () => {
  const { queue, cap } = linkQueue();
  queue.push({ url: "myapp://threads/1", launch: true }, {
    url: "https://x.example/",
    launch: false,
  });
  await inDesktop(cap, async (rt) => {
    const seen: unknown[] = [];
    const stop = onDeepLink((e) => seen.push(e), { route: false });
    await until(() => seen.length === 1);
    assertEquals(seen, [{ url: "myapp://threads/1", path: "/threads/1", launch: true }]);
    // A second subscriber (a remount) never sees the earlier link.
    const later: unknown[] = [];
    const stop2 = onDeepLink((e) => later.push(e), { route: false });
    // A warm link arrives: the runtime signals, the page takes it — both subscribers get it.
    queue.push({ url: "myapp://threads/2", launch: false });
    rt.emit("deepLinks", "available", null);
    await until(() => seen.length === 2 && later.length === 1);
    assertEquals(later, [{ url: "myapp://threads/2", path: "/threads/2", launch: false }]);
    stop();
    stop2();
  });
});

Deno.test("desktop onDeepLink: the accept filter applies; routing happens once per link", async () => {
  const { queue, cap } = linkQueue();
  queue.push({ url: "myapp://a/1", launch: false }, { url: "otherapp://b", launch: false });
  await inDesktop(cap, async () => {
    const routed: string[] = [];
    const a: string[] = [];
    const b: string[] = [];
    const route = (path: string) => routed.push(path);
    const s1 = onDeepLink((e) => a.push(e.url), { accept: { schemes: ["myapp"] }, route });
    const s2 = onDeepLink((e) => b.push(e.url), { accept: { schemes: ["myapp"] }, route });
    await until(() => a.length === 1);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(a, ["myapp://a/1"]);
    assertEquals(routed, ["/a/1"]);
    s1();
    s2();
  });
});

Deno.test("desktop onDeepLink: no deepLinks capability (stock runtime) → nothing, no throw", async () => {
  await inDesktop({}, async (rt) => {
    const seen: unknown[] = [];
    const stop = onDeepLink((e) => seen.push(e));
    await until(() => rt.requests.some((r) => r.path === "/_denext/desktop/rpc"));
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(seen, []);
    stop();
  });
});

Deno.test("desktop onOpenFile: opened files arrive as read-only handles, once", async () => {
  const queue = [{ handle: "h1", name: "a.txt", path: "/x/a.txt", launch: true }];
  await inDesktop({ openFiles: { take: () => queue.splice(0) } }, async (rt) => {
    const seen: unknown[] = [];
    const stop = onOpenFile((f) => seen.push(f));
    await until(() => seen.length === 1);
    assertEquals(seen[0], { handle: "h1", name: "a.txt", path: "/x/a.txt", launch: true });
    queue.push({ handle: "h2", name: "b.txt", path: "/x/b.txt", launch: false });
    rt.emit("openFiles", "available", null);
    await until(() => seen.length === 2);
    stop();
  });
});

const PKCE = "&code_challenge=abc&code_challenge_method=S256";

Deno.test("usesSchemeCallback: custom redirect or callbackPrefix → scheme flow; loopback → loopback", () => {
  const url = (redirect: string) =>
    `https://idp.example/authorize?redirect_uri=${encodeURIComponent(redirect)}`;
  assert(usesSchemeCallback(url("myapp://cb"), { callbackScheme: "myapp" }));
  assert(!usesSchemeCallback(url("http://127.0.0.1/cb"), { callbackScheme: "myapp" }));
  assert(usesSchemeCallback(url("https://fapi.example/cb"), {
    callbackScheme: "myapp",
    callbackPrefix: "myapp://app/",
  }));
  assert(!usesSchemeCallback(url("https://fapi.example/cb"), { callbackScheme: "myapp" }));
  assert(!usesSchemeCallback("https://idp.example/authorize", { callbackScheme: "myapp" }));
});

Deno.test("desktop openAuthSession (custom scheme): the runtime session, its args and its result", async () => {
  const starts: unknown[] = [];
  await inDesktop({
    authSession: {
      start: (args) => {
        starts.push(args);
        return { url: "myapp://cb?code=c&state=s" };
      },
    },
  }, async () => {
    const authUrl = `https://idp.example/authorize?redirect_uri=myapp%3A%2F%2Fcb&state=s${PKCE}`;
    const result = await openAuthSession(authUrl, { callbackScheme: "myapp", timeoutMs: 1000 });
    assertEquals(result, { url: "myapp://cb?code=c&state=s" });
    assertEquals(starts, [{ url: authUrl, callbackScheme: "myapp", timeoutMs: 1000 }]);
  });
});

Deno.test("desktop openAuthSession (custom scheme): codes map through, the handler included", async () => {
  const fail = (code: string, data?: unknown) => () => {
    throw { code, message: `${code} message`, data };
  };
  const cases: Array<[FakeMethod, string, string | undefined]> = [
    [
      fail("scheme_owned_by_other_app", { handler: "com.other" }),
      "scheme_owned_by_other_app",
      "com.other",
    ],
    [fail("pkce_required"), "pkce_required", undefined],
    [fail("scheme_not_declared"), "scheme_not_declared", undefined],
    [fail("session_in_progress"), "session_in_progress", undefined],
    [fail("validation"), "invalid", undefined],
    [fail("weird_internal"), "unsupported", undefined],
  ];
  for (const [start, code, handler] of cases) {
    await inDesktop({ authSession: { start } }, async () => {
      const err = await assertRejects(() =>
        openAuthSession("https://idp.example/a?redirect_uri=myapp%3A%2F%2Fcb", {
          callbackScheme: "myapp",
        })
      ) as { code: string; handler?: string; message: string };
      assertEquals(err.code, code);
      assertEquals(err.handler, handler);
    });
  }
  // The capability is off (or the stock runtime): `unsupported` naming the fix.
  await inDesktop({}, async () => {
    const err = await assertRejects(() =>
      openAuthSession("https://idp.example/a?redirect_uri=myapp%3A%2F%2Fcb", {
        callbackScheme: "myapp",
      })
    ) as { code: string; message: string };
    assertEquals(err.code, "unsupported");
    assert(err.message.includes("denext desktop add auth-session"));
  });
});

Deno.test("desktop openAuthSession (custom scheme): aborting the signal cancels the runtime session", async () => {
  let release: (v: unknown) => void = () => {};
  const cancels: unknown[] = [];
  await inDesktop({
    authSession: {
      start: () =>
        new Promise((
          _,
          reject,
        ) => (release = () => reject({ code: "cancelled", message: "cancelled" }))),
      cancel: (args) => {
        cancels.push(args);
        release(undefined);
        return { cancelled: true };
      },
    },
  }, async () => {
    const abort = new AbortController();
    const run = openAuthSession("https://idp.example/a?redirect_uri=myapp%3A%2F%2Fcb", {
      callbackScheme: "myapp",
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const err = await assertRejects(() => run) as { code: string };
    assertEquals(err.code, "cancelled");
    assertEquals(cancels.length, 1);
    // Already aborted: refused before any request.
    const pre = new AbortController();
    pre.abort();
    const early = await assertRejects(() =>
      openAuthSession("https://idp.example/a?redirect_uri=myapp%3A%2F%2Fcb", {
        callbackScheme: "myapp",
        signal: pre.signal,
      })
    ) as { code: string };
    assertEquals(early.code, "cancelled");
  });
});

Deno.test("desktop openAuthSession: a loopback redirect keeps the loopback endpoint", async () => {
  await inDesktop({ authSession: { start: () => ({ url: "never" }) } }, async (rt) => {
    // The fake has no auth-session endpoint, so the loopback flow fails — but it never calls the
    // scheme RPC.
    await assertRejects(() =>
      openAuthSession("https://idp.example/a?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb", {
        callbackScheme: "myapp",
      })
    );
    assertEquals(rt.calls.filter((c) => c.cap === "authSession"), []);
    assert(rt.requests.some((r) => r.path === "/_denext/desktop/auth-session"));
  });
});

Deno.test("deepLinkSchemeOwner / claimDeepLinkScheme: the deepLinks RPCs", async () => {
  await inDesktop({
    deepLinks: {
      owner: (a) => ({ owner: "other", handler: `h:${(a as { scheme: string }).scheme}` }),
      claim: () => ({ registered: true, owner: "self" }),
    },
  }, async (rt) => {
    assertEquals(await deepLinkSchemeOwner("myapp"), { owner: "other", handler: "h:myapp" });
    assertEquals(await claimDeepLinkScheme("myapp"), { registered: true, owner: "self" });
    assertEquals(rt.calls.map((c) => `${c.cap}.${c.method}`), [
      "deepLinks.owner",
      "deepLinks.claim",
    ]);
  });
});
