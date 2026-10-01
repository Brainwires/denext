// `denext/desktop/clerk` (D.6): the globals `@clerk/electron` reads, with the exact shapes
// `exposeClerkBridge` creates; the token cache over secure-store (memory when it is off); the OAuth
// transport's `@clerk/electron` main-process semantics over the custom-scheme auth session; the
// passkey bridge over the passkeys capability, including the `invalid_rp` degrade + browser
// fallback; and the hosted (browser) sign-in's state + PKCE binding.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ClerkLike,
  installClerkDesktopBridge,
  startClerkBrowserSignIn,
} from "../src/desktop/clerk.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, type FakeMethod } from "./helpers/desktop-fake-runtime.ts";

type G = {
  __clerk_internal_electron?: Record<string, Record<string, unknown>>;
  __clerk_internal_electron_passkeys?: Record<string, unknown>;
  __denext?: Record<string, unknown>;
  location?: unknown;
};
const g = globalThis as unknown as G;

async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: () => void | Promise<void>,
  location: unknown = { protocol: "t3code:", href: "t3code://app/threads/1" },
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  g.__denext = { ...g.__denext, os: "darwin" };
  const prevLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  try {
    await fn();
  } finally {
    delete g.__clerk_internal_electron;
    delete g.__clerk_internal_electron_passkeys;
    if (prevLocation) Object.defineProperty(globalThis, "location", prevLocation);
    else delete g.location;
    resetDesktopBridgeForTesting();
    restore();
  }
}

Deno.test("clerk bridge: off desktop nothing is installed", () => {
  assertEquals(installClerkDesktopBridge({ passkeys: true }), undefined);
  assertEquals(g.__clerk_internal_electron, undefined);
});

Deno.test("clerk bridge: the exposeClerkBridge shapes", async () => {
  await inDesktop({}, () => {
    installClerkDesktopBridge();
    const bridge = g.__clerk_internal_electron!;
    assertEquals(Object.keys(bridge).sort(), ["oauthTransport", "tokenCache"]);
    assertEquals(Object.keys(bridge.tokenCache).sort(), ["clearToken", "getToken", "saveToken"]);
    assertEquals(Object.keys(bridge.oauthTransport).sort(), ["getRedirectUrl", "open"]);
    // Passkeys only on request, as exposeClerkBridge({ passkeys: true }).
    assertEquals(g.__clerk_internal_electron_passkeys, undefined);
    installClerkDesktopBridge({ passkeys: true });
    const pk = g.__clerk_internal_electron_passkeys!;
    assertEquals(
      ["capabilities", "create", "electronMajor", "get", "platform"].every((k) => k in pk),
      true,
    );
    assertEquals(pk.electronMajor, 0);
    assertEquals(pk.platform, "darwin");
  });
});

Deno.test("clerk bridge: the token cache uses the keychain under a per-app prefix", async () => {
  const kv = new Map<string, string>();
  await inDesktop({
    secureStore: {
      get: (a) => kv.get((a as { key: string }).key) ?? null,
      set: (a) => void kv.set((a as { key: string }).key, (a as { value: string }).value),
      delete: (a) => void kv.delete((a as { key: string }).key),
    },
  }, async () => {
    const { tokenCache } = installClerkDesktopBridge()!.bridge;
    assertEquals(await tokenCache.getToken("__clerk_client_jwt"), null);
    await tokenCache.saveToken("__clerk_client_jwt", "jwt-1");
    assertEquals([...kv.keys()], ["clerk.__clerk_client_jwt"]);
    assertEquals(await tokenCache.getToken("__clerk_client_jwt"), "jwt-1");
    await tokenCache.clearToken("__clerk_client_jwt");
    assertEquals(kv.size, 0);
  });
});

Deno.test("clerk bridge: without secure-store the token lives in memory (never thrown)", async () => {
  await inDesktop({}, async () => {
    const { tokenCache } = installClerkDesktopBridge({ keyPrefix: "x." })!.bridge;
    await tokenCache.saveToken("k", "v");
    assertEquals(await tokenCache.getToken("k"), "v");
    await tokenCache.clearToken("k");
    assertEquals(await tokenCache.getToken("k"), null);
  });
});

Deno.test("clerk bridge: getRedirectUrl is the custom origin plus / (or the option)", async () => {
  await inDesktop({}, async () => {
    const t = installClerkDesktopBridge()!.bridge.oauthTransport;
    assertEquals(await t.getRedirectUrl(), "t3code://app/");
    const o =
      installClerkDesktopBridge({ redirectUrl: "t3code-dev://app/" })!.bridge.oauthTransport;
    assertEquals(await o.getRedirectUrl(), "t3code-dev://app/");
  });
  // A loopback (stock runtime) page has no custom origin: a clear error, not a wrong redirect.
  await inDesktop({}, async () => {
    const t = installClerkDesktopBridge()!.bridge.oauthTransport;
    await assertRejects(() => t.getRedirectUrl(), Error, "custom page origin");
  }, { protocol: "http:", href: "http://127.0.0.1:8000/" });
});

Deno.test("clerk bridge: open() runs the custom-scheme session exactly like @clerk/electron", async () => {
  const starts: Record<string, unknown>[] = [];
  let release: (v: unknown) => void = () => {};
  await inDesktop({
    authSession: {
      start: (a) => {
        starts.push(a as Record<string, unknown>);
        return new Promise((r) => (release = r));
      },
    },
  }, async () => {
    const t = installClerkDesktopBridge()!.bridge.oauthTransport;
    const providerUrl = "https://accounts.google.com/o/oauth2/auth?redirect_uri=" +
      encodeURIComponent("https://clerk.example.com/v1/oauth_callback") + "&state=clerk-state";
    const run = t.open(providerUrl);
    await new Promise((r) => setTimeout(r, 10));
    // One flow at a time (the main process throws the same).
    await assertRejects(() => t.open(providerUrl), Error, "already pending");
    release({ url: "t3code://app/?rotating_token_nonce=n1" });
    assertEquals(await run, { callbackUrl: "t3code://app/?rotating_token_nonce=n1" });
    assertEquals(starts.length, 1);
    const s = starts[0];
    assertEquals(s.url, providerUrl);
    assertEquals(s.callbackScheme, "t3code");
    assertEquals(s.callbackPrefix, "t3code://app/");
    assertEquals(s.pkce, "not-applicable");
    assert(typeof s.reason === "string" && s.reason.includes("rotating_token_nonce"));
    assertEquals(s.timeoutMs, 180_000); // @clerk/electron's CALLBACK_TIMEOUT_MS
    await assertRejects(() => t.open("javascript:alert(1)"), TypeError);
  });
});

/** A fake Clerk instance answering hosted_auth and the redemption. */
function fakeClerk(onRedeem?: (body: Record<string, unknown>) => void) {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const active: string[] = [];
  let loaded: unknown;
  const clerk: ClerkLike = {
    getFapiClient: () => ({
      request: (init) => {
        requests.push({ path: init.path, body: init.body });
        if (init.path === "/client/hosted_auth") {
          return Promise.resolve({
            ok: true,
            status: 200,
            payload: {
              response: { object: "hosted_auth", url: "https://accounts.example.com/sign-in?x=1" },
            },
          });
        }
        onRedeem?.(init.body!);
        return Promise.resolve({
          ok: true,
          status: 200,
          payload: { response: { object: "client", sessions: [{ id: "sess_1" }] } },
        });
      },
    }),
    client: { fromJSON: (json) => (loaded = json) },
    setActive: ({ session }) => Promise.resolve(void active.push(session)),
  };
  return { clerk, requests, active, loaded: () => loaded };
}

async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An authSession.start that answers the hosted callback for the state it was given. */
function hostedCallback(extra = "&rotating_token_nonce=n1&created_session_id=sess_1") {
  return (a: unknown) => ({ url: `t3code://app/?state=${(a as { state: string }).state}${extra}` });
}

Deno.test("startClerkBrowserSignIn: state + PKCE bound end to end, then the session activates", async () => {
  let verifierOk = false;
  const starts: Record<string, unknown>[] = [];
  const f = fakeClerk();
  await inDesktop({
    authSession: {
      start: (a) => {
        starts.push(a as Record<string, unknown>);
        return hostedCallback()(a);
      },
    },
  }, async () => {
    const { createdSessionId } = await startClerkBrowserSignIn(
      {
        ...f.clerk,
        getFapiClient: () => ({
          request: async (init) => {
            if (init.path === "/client") {
              const challenge = f.requests[0].body!.codeChallenge as string;
              verifierOk = await s256(init.body!.codeVerifier as string) === challenge;
            }
            return f.clerk.getFapiClient().request(init);
          },
        }),
      },
      { redirectUrl: "t3code://app/" },
    );
    assertEquals(createdSessionId, "sess_1");
  });
  assert(verifierOk, "the redemption must carry the verifier of the S256 challenge");
  const created = f.requests[0].body!;
  assertEquals(created.redirectUrl, "t3code://app/");
  assertEquals(starts[0].state, created.state);
  assertEquals(starts[0].callbackPrefix, "t3code://app/");
  assertEquals(f.requests[1].body!.rotatingTokenNonce, "n1");
  assertEquals(f.requests[1].body!._method, "GET");
  assertEquals(f.active, ["sess_1"]);
});

Deno.test("startClerkBrowserSignIn: a callback with a wrong state or no nonce is refused", async () => {
  for (
    const start of [
      () => ({ url: "t3code://app/?state=forged&rotating_token_nonce=n&created_session_id=s" }),
      hostedCallback("&created_session_id=sess_1"),
    ]
  ) {
    const f = fakeClerk();
    await inDesktop({ authSession: { start } }, async () => {
      await assertRejects(() => startClerkBrowserSignIn(f.clerk, { redirectUrl: "t3code://app/" }));
    });
    assertEquals(f.requests.length, 1); // never redeemed
    assertEquals(f.active, []);
  }
});

const getOpts = { challenge: "YQ", rpId: "clerk.example.com", allowCredentials: [] };

Deno.test("clerk passkeys: get forwards the options JSON and returns the envelope", async () => {
  const calls: unknown[] = [];
  await inDesktop({
    passkeys: {
      get: (a) => {
        calls.push(a);
        return { ok: true, credential: { id: "c" } };
      },
      capabilities: () => ({ available: true, platformAuthenticator: true, securityKeys: false }),
    },
  }, async () => {
    const pk = installClerkDesktopBridge({ passkeys: true })!.passkeys!;
    assertEquals(await pk.get(getOpts), { ok: true, credential: { id: "c" } });
    assertEquals(calls, [{ optionsJson: JSON.stringify(getOpts) }]);
    assertEquals(await pk.capabilities(), {
      available: true,
      platformAuthenticator: true,
      securityKeys: false,
    });
  });
});

Deno.test("clerk passkeys: invalid_rp hides native passkeys and continues in the browser", async () => {
  const f = fakeClerk();
  const starts: unknown[] = [];
  await inDesktop({
    passkeys: {
      get: () => ({ ok: false, error: { code: "invalid_rp", message: "no AASA" } }),
      create: () => ({ ok: false, error: { code: "invalid_rp", message: "no AASA" } }),
      capabilities: () => ({ available: true, platformAuthenticator: true, securityKeys: false }),
    },
    authSession: {
      start: (a) => {
        starts.push(a);
        return hostedCallback()(a);
      },
    },
  }, async () => {
    const pk = installClerkDesktopBridge({ passkeys: true, getClerk: () => f.clerk })!.passkeys!;
    // A registration is not a sign-in: the error comes back as is.
    assertEquals(await pk.create({}), {
      ok: false,
      error: { code: "invalid_rp", message: "no AASA" },
    });
    assertEquals(pk.platform, "none"); // @clerk/electron/passkeys: nativeAvailable → false
    assertEquals((await pk.capabilities()).available, false);
    assertEquals(starts.length, 0);
    // A sign-in: Clerk sees a quiet cancel, and the hosted sign-in runs in the browser.
    const out = await pk.get(getOpts) as { ok: boolean; error?: { code: string } };
    assertEquals(out.error?.code, "cancelled");
    for (let i = 0; i < 50 && f.active.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assertEquals(f.active, ["sess_1"]);
  });
});

Deno.test("clerk passkeys: passkeyFallback none reports invalid_rp; no capability → not_supported", async () => {
  await inDesktop({
    passkeys: { get: () => ({ ok: false, error: { code: "invalid_rp", message: "x" } }) },
  }, async () => {
    const pk = installClerkDesktopBridge({
      passkeys: true,
      passkeyFallback: "none",
      getClerk: () => fakeClerk().clerk,
    })!.passkeys!;
    assertEquals((await pk.get(getOpts) as { error: { code: string } }).error.code, "invalid_rp");
  });
  await inDesktop({}, async () => {
    const pk = installClerkDesktopBridge({ passkeys: true })!.passkeys!;
    assertEquals(
      (await pk.get(getOpts) as { error: { code: string } }).error.code,
      "not_supported",
    );
    assertEquals((await pk.capabilities()).available, false);
  });
  await inDesktop({ passkeys: { get: () => ({ weird: true }) } }, async () => {
    const pk = installClerkDesktopBridge({ passkeys: true })!.passkeys!;
    assertEquals((await pk.get(getOpts) as { error: { code: string } }).error.code, "unknown");
  });
});
