// Deno Desktop OAuth with a CUSTOM-SCHEME callback (runtime side), adversarially: an undeclared
// scheme, another app owning the scheme, a missing / non-S256 PKCE, a forged callback with a wrong
// or missing state (ignored, the session keeps waiting), a forged callback with no session open, a
// callback for another path, concurrent sessions, the timeout, cancel (and a cancel during the
// owner check), a page reload, a browser that fails to open — and, end to end through the bridge
// and the launch router, the callback never reaching the page's deep-link queue.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createSchemeAuthSessions,
  parseSchemeAuthStart,
  type SchemeAuthSessions,
} from "../src/desktop/scheme-auth-session.ts";
import { createLaunchRouter, type DesktopAppApi } from "../src/desktop/launch-events.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** An authorization URL with a `myapp://auth/cb` redirect, PKCE S256 and a state. */
function authUrl(over: Record<string, string | null> = {}): string {
  const u = new URL("https://auth.example.com/authorize");
  const params: Record<string, string | null> = {
    client_id: "app",
    redirect_uri: "myapp://auth/cb",
    response_type: "code",
    state: "st-1",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...over,
  };
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.href;
}

type Owner = "self" | "other" | "none";

/** A fake scheme API whose owner answers come from `owners` in turn (the last repeats). */
function schemeApi(
  owners: Owner[],
  handler = "com.other.app",
): DesktopAppApi & { registered: unknown[] } {
  let i = 0;
  const registered: unknown[] = [];
  return {
    registered,
    getSchemeOwner: () => {
      const owner = owners[Math.min(i++, owners.length - 1)];
      return Promise.resolve({ owner, ...(owner === "other" ? { handler } : {}) });
    },
    registerScheme: (scheme, options) => {
      registered.push([scheme, options]);
      return Promise.resolve({ registered: true, owner: "self" as const });
    },
  };
}

const ctx = {
  emit: () => {},
  appSupportDir: "",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  os: "darwin" as const,
  signal: new AbortController().signal,
};

/** The starting page's session key (what its `cancel` names). */
const KEY = "page-key-0123456789abcdef";
const PRELOAD_KEY = "preload-key-0123456789";

function sessions(api: DesktopAppApi = schemeApi(["self"]), preloadKey?: string) {
  const opened: string[] = [];
  const s = createSchemeAuthSessions({
    schemes: ["myapp"],
    api,
    openBrowser: (url) => void opened.push(url),
    ...(preloadKey ? { preloadKey } : {}),
  });
  const start = (args: Record<string, unknown>, signal?: AbortSignal) =>
    s.capability.methods.start.handler(
      { callbackScheme: "myapp", url: authUrl(), session: KEY, ...args },
      signal ? { ...ctx, signal } : ctx,
    ) as Promise<
      { url: string }
    >;
  const cancel = (session: string = KEY) =>
    s.capability.methods.cancel.handler({ session }, ctx) as { cancelled: boolean };
  return { s, start, cancel, opened };
}

/** Wait until the session is open (the browser was opened). */
async function opened(list: string[]): Promise<void> {
  for (let i = 0; i < 50 && list.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assert(list.length > 0, "the browser was never opened");
}

async function rejectsCode(p: Promise<unknown>, code: string): Promise<DesktopCapError> {
  const err = await assertRejects(() => p, DesktopCapError);
  assertEquals(err.code, code);
  return err;
}

Deno.test("scheme auth: the happy path — callback with the right state resolves", async () => {
  const { s, start, opened: list } = sessions();
  const run = start({});
  await opened(list);
  assertEquals(list, [authUrl()]); // the browser gets the URL unchanged
  assert(s.claim("myapp://auth/cb?code=abc&state=st-1"));
  assertEquals(await run, { url: "myapp://auth/cb?code=abc&state=st-1" });
});

Deno.test("scheme auth: an undeclared scheme is refused before anything opens", async () => {
  const { start, opened: list } = sessions();
  await rejectsCode(start({ callbackScheme: "other" }), "scheme_not_declared");
  await rejectsCode(start({ callbackScheme: "https" }), "scheme_not_declared");
  assertEquals(list, []);
});

Deno.test("scheme auth: another app owns the scheme → refused with its handler, never forced", async () => {
  const api = schemeApi(["other"], "com.attacker.app");
  const { start, opened: list } = sessions(api);
  const err = await rejectsCode(start({}), "scheme_owned_by_other_app");
  assertEquals(err.data, { handler: "com.attacker.app" });
  assertEquals(api.registered, []); // no force, no registration at all
  assertEquals(list, []);
});

Deno.test("scheme auth: an unowned scheme is registered (not forced) and re-checked", async () => {
  const api = schemeApi(["none", "self"]);
  const { s, start, opened: list } = sessions(api);
  const run = start({});
  await opened(list);
  assertEquals(api.registered, [["myapp", undefined]]);
  s.claim("myapp://auth/cb?code=1&state=st-1");
  await run;
  // Still unowned after registering (an unpackaged dev run) → refused.
  await rejectsCode(sessions(schemeApi(["none"])).start({}), "scheme_not_registered");
});

Deno.test("scheme auth: a runtime without owner detection fails closed", async () => {
  const { start, opened: list } = sessions({});
  await rejectsCode(start({}), "unsupported");
  assertEquals(list, []);
});

Deno.test("scheme auth: PKCE S256 is mandatory", async () => {
  const { start } = sessions();
  await rejectsCode(start({ url: authUrl({ code_challenge: null }) }), "pkce_required");
  await rejectsCode(start({ url: authUrl({ code_challenge_method: "plain" }) }), "pkce_required");
  await rejectsCode(start({ url: authUrl({ code_challenge_method: null }) }), "pkce_required");
  await rejectsCode(start({ url: authUrl({ code_challenge: "" }) }), "pkce_required");
  // The explicit exception needs a reason; any other pkce value is invalid.
  await rejectsCode(
    start({ url: authUrl({ code_challenge: null }), pkce: "not-applicable" }),
    "invalid",
  );
  await rejectsCode(
    start({ url: authUrl({ code_challenge: null }), pkce: "not-applicable", reason: "  " }),
    "invalid",
  );
  await rejectsCode(start({ pkce: "S256" }), "invalid");
});

Deno.test("scheme auth: pkce not-applicable with a reason is accepted", async () => {
  const { s, start, opened: list } = sessions();
  const run = start({
    url: authUrl({ code_challenge: null, code_challenge_method: null }),
    pkce: "not-applicable",
    reason: "the provider binds the callback to the client's own token",
  });
  await opened(list);
  s.claim("myapp://auth/cb?code=1&state=st-1");
  assertEquals((await run).url, "myapp://auth/cb?code=1&state=st-1");
});

Deno.test("scheme auth: a callback with a wrong or missing state is ignored; the session waits", async () => {
  const { s, start, opened: list } = sessions();
  const run = start({});
  await opened(list);
  // Swallowed (true: not routed to the page) but NOT resolved.
  assert(s.claim("myapp://auth/cb?code=evil&state=forged"));
  assert(s.claim("myapp://auth/cb?code=evil"));
  let settled = false;
  run.then(() => (settled = true), () => (settled = true));
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(settled, false);
  assert(s.claim("myapp://auth/cb?code=good&state=st-1"));
  assertEquals((await run).url, "myapp://auth/cb?code=good&state=st-1");
});

Deno.test("scheme auth: a forged callback with no session open is not claimed", () => {
  const { s } = sessions();
  assertEquals(s.claim("myapp://auth/cb?code=evil&state=st-1"), false);
});

Deno.test("scheme auth: a callback for another host / path is not the session's", async () => {
  const { s, start, cancel, opened: list } = sessions();
  const run = start({});
  await opened(list);
  assertEquals(s.claim("myapp://auth/other?code=x&state=st-1"), false);
  assertEquals(s.claim("myapp://evil/cb?code=x&state=st-1"), false);
  assertEquals(s.claim("other://auth/cb?code=x&state=st-1"), false);
  cancel();
  await rejectsCode(run, "cancelled");
});

Deno.test("scheme auth: one session at a time", async () => {
  const { s, start, opened: list } = sessions();
  const first = start({});
  await opened(list);
  await rejectsCode(start({}), "session_in_progress");
  s.claim("myapp://auth/cb?state=st-1&code=1");
  await first;
  // Free again afterwards.
  const second = start({});
  await new Promise((r) => setTimeout(r, 1));
  s.claim("myapp://auth/cb?state=st-1&code=2");
  assertEquals((await second).url, "myapp://auth/cb?state=st-1&code=2");
});

Deno.test("scheme auth: the timeout ends the session", async () => {
  const { s, start } = sessions();
  await rejectsCode(start({ timeoutMs: 5 }), "timeout");
  // Late callback after the timeout: not claimed.
  assertEquals(s.claim("myapp://auth/cb?code=1&state=st-1"), false);
  for (const timeoutMs of [0, -1, Infinity, 3_600_001, "1"]) {
    await rejectsCode(start({ timeoutMs }), "invalid");
  }
});

Deno.test("scheme auth: cancel ends the session; a cancel during the owner check too", async () => {
  const { start, cancel, opened: list } = sessions();
  const run = start({});
  await opened(list);
  assertEquals(cancel(), { cancelled: true });
  await rejectsCode(run, "cancelled");
  assertEquals(cancel(), { cancelled: false });

  // A slow owner check: the cancel lands before the session is open.
  let release = () => {};
  const slow: DesktopAppApi = {
    getSchemeOwner: () => new Promise((r) => (release = () => r({ owner: "self" }))),
  };
  const late = sessions(slow);
  const pending = late.start({});
  await new Promise((r) => setTimeout(r, 1));
  assertEquals(late.cancel(), { cancelled: true });
  release();
  await rejectsCode(pending, "cancelled");
  assertEquals(late.opened, []); // the browser never opened
});

Deno.test("scheme auth: bound to its page — its request going away ends it, another window cannot", async () => {
  const { s, start, cancel, opened: list } = sessions();
  const page = new AbortController();
  const run = start({}, page.signal);
  await opened(list);
  // Navigation elsewhere no longer touches it (there is no page-load hook), and a cancel that
  // does not name this page's key (another window's) is refused.
  assertEquals(s.capability.onPageLoad, undefined);
  assertEquals(cancel("other-window-key-0123456"), { cancelled: false });
  assertEquals(
    s.capability.methods.cancel.handler({}, ctx) as { cancelled: boolean },
    { cancelled: false },
  );
  // The starting page reloads: its `start` request is aborted, so the session ends.
  page.abort();
  await rejectsCode(run, "cancelled");
  // A start without its page key is refused.
  await rejectsCode(start({ session: "short" }), "invalid");
  await rejectsCode(start({ session: undefined }), "invalid");
});

Deno.test("scheme auth: PKCE parameters appear once and the challenge is a SHA-256", async () => {
  const { start } = sessions();
  const dup = new URL(authUrl());
  dup.searchParams.append("code_challenge", CHALLENGE);
  await rejectsCode(start({ url: dup.href }), "invalid");
  const dupMethod = new URL(authUrl());
  dupMethod.searchParams.append("code_challenge_method", "plain");
  await rejectsCode(start({ url: dupMethod.href }), "invalid");
  for (
    const c of ["short", `${CHALLENGE}x`, CHALLENGE.slice(0, 42) + "=", CHALLENGE.replace("-", "+")]
  ) {
    await rejectsCode(start({ url: authUrl({ code_challenge: c }) }), "pkce_required");
  }
  const dupState = new URL(authUrl());
  dupState.searchParams.append("state", "st-2");
  await rejectsCode(start({ url: dupState.href }), "invalid");
});

Deno.test("scheme auth: pkce not-applicable needs a state, unless OS-only or the Clerk binding", async () => {
  const noPkce = authUrl({ code_challenge: null, code_challenge_method: null, state: null });
  const waived = { url: noPkce, pkce: "not-applicable", reason: "bound by the provider" };
  // A direct caller without state: refused.
  await rejectsCode(sessions().start(waived), "invalid");
  // With a caller state it runs (and the state is enforced on the callback).
  const ok = sessions();
  const run = ok.start({ ...waived, state: "mine" });
  await opened(ok.opened);
  assert(ok.s.claim("myapp://auth/cb?code=x&state=forged"));
  assert(ok.s.claim("myapp://auth/cb?code=x&state=mine"));
  assertEquals((await run).url, "myapp://auth/cb?code=x&state=mine");
  // osSessionOnly where there is no OS sheet: refused, the browser never opens.
  const os = sessions();
  await rejectsCode(os.start({ ...waived, osSessionOnly: true }), "unsupported");
  assertEquals(os.opened, []);
  // A page passing the Clerk binding without the preload key (or a wrong one) is refused.
  const page = sessions(schemeApi(["self"]), PRELOAD_KEY);
  await rejectsCode(page.start({ ...waived, binding: "clerk-client-nonce" }), "invalid");
  await rejectsCode(
    page.start({ ...waived, binding: "clerk-client-nonce", bindingKey: "guess-0123456789" }),
    "invalid",
  );
  await rejectsCode(
    sessions().start({ ...waived, binding: "clerk-client-nonce", bindingKey: PRELOAD_KEY }),
    "invalid",
  );
  await rejectsCode(
    page.start({ ...waived, binding: "other", bindingKey: PRELOAD_KEY }),
    "invalid",
  );
});

Deno.test("scheme auth: the Clerk nonce binding — one callback per pending session, no strays", async () => {
  const noPkce = authUrl({
    code_challenge: null,
    code_challenge_method: null,
    state: null,
    redirect_uri: "https://clerk.example.com/v1/oauth_callback",
  });
  const { s, start, opened: list } = sessions(schemeApi(["self"]), PRELOAD_KEY);
  // A forged nonce callback with no session pending is dropped (never routed to the page).
  assertEquals(s.claim("myapp://app/?rotating_token_nonce=forged"), true);
  const run = start({
    url: noPkce,
    callbackPrefix: "myapp://app/",
    pkce: "not-applicable",
    reason: "clerk",
    binding: "clerk-client-nonce",
    bindingKey: PRELOAD_KEY,
  });
  await opened(list);
  // Another path is not this session's (and, carrying a nonce, is dropped, not routed).
  assertEquals(s.claim("myapp://app/other?rotating_token_nonce=x"), true);
  assertEquals(s.claim("myapp://app/other?plain=1"), false);
  assert(s.claim("myapp://app/?rotating_token_nonce=first"));
  assertEquals((await run).url, "myapp://app/?rotating_token_nonce=first");
  // A second callback after the session settled is ignored (dropped).
  assertEquals(s.claim("myapp://app/?rotating_token_nonce=second"), true);
});

Deno.test("scheme auth: a browser that fails to open ends the session", async () => {
  const s: SchemeAuthSessions = createSchemeAuthSessions({
    schemes: ["myapp"],
    api: schemeApi(["self"]),
    openBrowser: () => Promise.reject(new Error("no opener")),
  });
  const run = s.capability.methods.start.handler(
    { callbackScheme: "myapp", url: authUrl(), session: KEY },
    ctx,
  );
  await rejectsCode(run as Promise<unknown>, "unsupported");
});

Deno.test("scheme auth: the target and state rules (redirect_uri vs callbackPrefix)", () => {
  const parse = (args: Record<string, unknown>) =>
    parseSchemeAuthStart(["myapp"], {
      callbackScheme: "myapp",
      url: authUrl(),
      session: KEY,
      ...args,
    });
  // redirect_uri with the scheme: its state is the URL's.
  assertEquals(parse({}).state, "st-1");
  assertEquals(parse({}).target, { protocol: "myapp:", host: "auth", path: "/cb" });
  // A matching callbackPrefix is fine; a different one is invalid.
  parse({ callbackPrefix: "myapp://auth/cb" });
  try {
    parse({ callbackPrefix: "myapp://auth/x" });
    throw new Error("accepted a disagreeing callbackPrefix");
  } catch (e) {
    assertEquals((e as DesktopCapError).code, "invalid");
  }
  // An https redirect_uri (another hop, e.g. the provider's server): callbackPrefix required, and
  // the URL's state belongs to that hop — only the caller's `state` option is checked.
  const viaServer = { url: authUrl({ redirect_uri: "https://idp.example/cb" }) };
  let err: unknown;
  try {
    parse(viaServer);
  } catch (e) {
    err = e;
  }
  assertEquals((err as DesktopCapError).code, "invalid");
  const p = parse({ ...viaServer, callbackPrefix: "myapp://app/" });
  assertEquals(p.state, null);
  assertEquals(
    parse({ ...viaServer, callbackPrefix: "myapp://app/", state: "mine" }).state,
    "mine",
  );
  // A callbackPrefix with another scheme, and a non-https URL, are invalid.
  for (
    const bad of [{ ...viaServer, callbackPrefix: "https://app/" }, { url: "http://a.example/x" }]
  ) {
    try {
      parse(bad);
      throw new Error("accepted");
    } catch (e) {
      assertEquals((e as DesktopCapError).code, "invalid");
    }
  }
});

Deno.test("scheme auth + router + bridge: the callback resolves the RPC and never reaches the page queue", async () => {
  const auth = createSchemeAuthSessions({
    schemes: ["myapp"],
    api: schemeApi(["self"]),
    openBrowser: () => {},
  });
  const router = createLaunchRouter({
    schemes: ["myapp"],
    api: {},
    emit: () => {},
    claimAuthCallback: auth.claim,
  });
  const bridge = createDesktopBridge([...router.capabilities, auth.capability]);
  const origin = "http://127.0.0.1:8000";
  const rpc = (method: string, cap: string, args: unknown) =>
    bridge.handle(
      new Request(`${origin}/_denext/desktop/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-denext-desktop-token": "t", origin },
        body: JSON.stringify({ cap, method, args }),
      }),
      new URL(`${origin}/_denext/desktop/rpc`),
      "t",
    ).then((r) => r!.json());
  const started = rpc("start", "authSession", {
    callbackScheme: "myapp",
    url: authUrl(),
    session: KEY,
  });
  await new Promise((r) => setTimeout(r, 5));
  router.acceptUrl("myapp://auth/cb?code=evil&state=nope", false); // forged: swallowed
  router.acceptUrl("myapp://threads/1", false); // an ordinary link: queued
  router.acceptUrl("myapp://auth/cb?code=good&state=st-1", false); // the real callback
  assertEquals(await started, { ok: true, data: { url: "myapp://auth/cb?code=good&state=st-1" } });
  assertEquals(await rpc("take", "deepLinks", {}), {
    ok: true,
    data: [{ url: "myapp://threads/1", launch: false }],
  });
  // After the session, a forged callback is an ordinary (untrusted) deep link for the page.
  router.acceptUrl("myapp://auth/cb?code=late&state=st-1", false);
  assertEquals((await rpc("take", "deepLinks", {})).data.length, 1);
});
