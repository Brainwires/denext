// denext/mobile/clerk in a faked Capacitor shell: the bridge shapes `@clerk/electron/react` reads,
// the token cache over the secure-storage plugin (memory without it — never the WebView's
// IndexedDB), the OAuth transport over the DenextAuthSession plugin (one flow at a time, https
// only, the callback held to the redirect's scheme / host / path), stray Clerk callbacks dropped
// from onDeepLink, native mode for the SDK's clerk-js, the passkey browser path, and the hosted
// sign-in's state + PKCE binding.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type ClerkLike,
  installClerkMobileBridge,
  startClerkMobileBrowserSignIn,
} from "../src/mobile/clerk.ts";
import { isAuthSessionCallback, resetAuthSessionForTesting } from "../src/mobile/auth-session.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** A fake secure-storage plugin over a map. */
function securePlugin() {
  const kv = new Map<string, string>();
  return {
    kv,
    plugin: {
      internalGetItem: ({ prefixedKey }: Any) => Promise.resolve({ data: kv.get(prefixedKey) }),
      internalSetItem: ({ prefixedKey, data }: Any) =>
        Promise.resolve(void kv.set(prefixedKey, data)),
      internalRemoveItem: ({ prefixedKey }: Any) => Promise.resolve(void kv.delete(prefixedKey)),
    },
  };
}

/** Run `fn` in a faked shell with `plugins`, restoring every global after. */
async function inShell(
  plugins: Record<string, unknown>,
  fn: () => unknown,
  platform = "ios",
): Promise<void> {
  const saved = ["Capacitor", "Clerk", "__clerk_internal_electron", "__internal_onBeforeSetActive"]
    .map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  Object.defineProperty(g, "Capacitor", {
    configurable: true,
    writable: true,
    value: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins },
  });
  try {
    await fn();
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(g, k, desc);
      else delete g[k];
    }
    resetAuthSessionForTesting();
  }
}

/** A DenextAuthSession plugin answering `url` (or a function of the start options). */
function authPlugin(answer: string | ((o: Any) => string)) {
  const starts: Any[] = [];
  return {
    starts,
    plugin: {
      start: (o: Any) => {
        starts.push(o);
        return Promise.resolve({ url: typeof answer === "string" ? answer : answer(o) });
      },
      cancel: () => Promise.resolve(),
    },
  };
}

Deno.test("clerk mobile: off the shell nothing is installed", () => {
  assertEquals(installClerkMobileBridge({ scheme: "myapp", nativeClerk: true }), undefined);
  assertEquals(g.__clerk_internal_electron, undefined);
});

Deno.test("clerk mobile: the scheme and redirect are checked", async () => {
  await inShell({}, () => {
    for (const scheme of ["", "My App", "https", "capacitor", "MYAPP"]) {
      assertThrows(() => installClerkMobileBridge({ scheme }), TypeError);
    }
    assertThrows(
      () => installClerkMobileBridge({ scheme: "myapp", redirectUrl: "other://app/" }),
      TypeError,
    );
    const ok = installClerkMobileBridge({ scheme: "myapp" })!;
    assertEquals(ok.redirectUrl, "myapp://app/");
    assertEquals(Object.keys(g.__clerk_internal_electron).sort(), ["oauthTransport", "tokenCache"]);
  });
});

Deno.test("clerk mobile: the token cache uses the Keychain / Keystore under a prefix", async () => {
  const store = securePlugin();
  await inShell({ SecureStorage: store.plugin }, async () => {
    const { tokenCache } = installClerkMobileBridge({ scheme: "myapp" })!.bridge;
    await tokenCache.saveToken("__clerk_client_jwt", "jwt-1");
    assertEquals([...store.kv.values()], ["jwt-1"]);
    assert([...store.kv.keys()][0].endsWith("clerk.__clerk_client_jwt"));
    assertEquals(await tokenCache.getToken("__clerk_client_jwt"), "jwt-1");
    await tokenCache.clearToken("__clerk_client_jwt");
    assertEquals(store.kv.size, 0);
  });
});

Deno.test("clerk mobile: without the plugin the token stays in memory (never IndexedDB)", async () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  const savedIdb = Object.getOwnPropertyDescriptor(g, "indexedDB");
  Object.defineProperty(g, "indexedDB", {
    configurable: true,
    get: () => {
      throw new Error("IndexedDB must not be used");
    },
  });
  try {
    await inShell({}, async () => {
      const { tokenCache } = installClerkMobileBridge({ scheme: "myapp" })!.bridge;
      await tokenCache.saveToken("k", "v");
      assertEquals(await tokenCache.getToken("k"), "v");
      await tokenCache.clearToken("k");
      assertEquals(await tokenCache.getToken("k"), null);
    });
    assert(warnings.some((w) => w.includes("denext mobile add clerk")));
  } finally {
    console.warn = warn;
    if (savedIdb) Object.defineProperty(g, "indexedDB", savedIdb);
    else delete g.indexedDB;
  }
});

Deno.test("clerk mobile: OAuth runs in the auth session and must return to the redirect", async () => {
  const auth = authPlugin("myapp://app/?rotating_token_nonce=n1");
  await inShell({ DenextAuthSession: auth.plugin }, async () => {
    const t = installClerkMobileBridge({ scheme: "myapp" })!.bridge.oauthTransport;
    assertEquals(await t.getRedirectUrl(), "myapp://app/");
    const provider = "https://accounts.google.com/o/oauth2/auth?x=1";
    assertEquals(await t.open(provider), { callbackUrl: "myapp://app/?rotating_token_nonce=n1" });
    assertEquals(auth.starts[0].url, provider);
    assertEquals(auth.starts[0].callbackScheme, "myapp");
    await assertRejects(() => t.open("http://evil.example/"), TypeError);
  });
  // Another path or host of the scheme is not this session's answer.
  for (
    const other of ["myapp://evil/?rotating_token_nonce=n1", "myapp://app/x?rotating_token_nonce=n"]
  ) {
    await inShell({ DenextAuthSession: authPlugin(other).plugin }, async () => {
      const t = installClerkMobileBridge({ scheme: "myapp" })!.bridge.oauthTransport;
      await assertRejects(() => t.open("https://accounts.google.com/o"), Error, "another URL");
      // The transport is free again afterwards.
      await assertRejects(() => t.open("https://accounts.google.com/o"), Error, "another URL");
    }, "android");
  }
});

Deno.test("clerk mobile: one OAuth flow at a time", async () => {
  let release: (v: unknown) => void = () => {};
  const plugin = {
    start: () => new Promise((r) => (release = r)),
    cancel: () => Promise.resolve(),
  };
  await inShell({ DenextAuthSession: plugin }, async () => {
    const t = installClerkMobileBridge({ scheme: "myapp" })!.bridge.oauthTransport;
    const first = t.open("https://accounts.google.com/o");
    await new Promise((r) => setTimeout(r, 5));
    await assertRejects(() => t.open("https://accounts.google.com/o"), Error, "already pending");
    release({ url: "myapp://app/?rotating_token_nonce=n" });
    await first;
  });
});

Deno.test("clerk mobile: a Clerk callback outside a session never reaches onDeepLink", async () => {
  await inShell({}, () => {
    installClerkMobileBridge({ scheme: "myapp" });
    assertEquals(isAuthSessionCallback("myapp://app/?rotating_token_nonce=forged"), true);
    assertEquals(isAuthSessionCallback("MYAPP://APP/?rotating_token_nonce=forged"), true);
    // Other links of the scheme still route normally.
    assertEquals(isAuthSessionCallback("myapp://app/threads/1"), false);
    assertEquals(isAuthSessionCallback("myapp://other/?rotating_token_nonce=x"), false);
  });
});

/** A stand-in clerk-js instance: records its hooks and the options `load()` gets. */
function fakeClerkJs() {
  const before: Array<(r: Any) => unknown> = [];
  const after: Array<(q: unknown, r: Any) => unknown> = [];
  const loads: Any[] = [];
  const clerk: Any = {
    __internal_onBeforeRequest: (h: Any) => void before.push(h),
    __internal_onAfterResponse: (h: Any) => void after.push(h),
    load: (o: Any) => Promise.resolve(void loads.push(o)),
  };
  return { clerk, before, after, loads };
}

Deno.test("clerk mobile: nativeClerk runs the SDK's clerk-js natively, with the JWT in the store", async () => {
  const store = securePlugin();
  await inShell({ SecureStorage: store.plugin }, async () => {
    installClerkMobileBridge({ scheme: "myapp", nativeClerk: true });
    const sdk = fakeClerkJs();
    g.Clerk = sdk.clerk;
    await sdk.clerk.load({ publishableKey: "pk_test_x" });
    assertEquals(sdk.loads[0].standardBrowser, false);
    assertEquals(await sdk.loads[0].__internal_oauthTransport.getRedirectUrl(), "myapp://app/");
    await sdk.after[0]({}, { headers: new Headers({ authorization: "Bearer jwt-9" }) });
    const req: Any = { url: new URL("https://x.clerk.accounts.dev/v1/client") };
    await sdk.before[0](req);
    assertEquals(req.credentials, "omit");
    assertEquals(new Headers(req.headers).get("authorization"), "Bearer jwt-9");
    // Passkeys: supported (through the browser), never created in the app.
    assertEquals(sdk.clerk.__internal_isWebAuthnSupported(), true);
    const created = await sdk.clerk.__internal_createPublicCredentials({});
    assertEquals(created.error.code, "passkey_not_supported");
  });
});

Deno.test("clerk mobile: passkeys none hides them", async () => {
  await inShell({}, () => {
    installClerkMobileBridge({ scheme: "myapp", nativeClerk: true, passkeys: "none" });
    const sdk = fakeClerkJs();
    g.Clerk = sdk.clerk;
    assertEquals(sdk.clerk.__internal_isWebAuthnSupported(), false);
  });
});

/** A fake Clerk answering hosted_auth and the redemption. */
function fakeClerk(onRedeem?: (body: Any) => void) {
  const active: string[] = [];
  const requests: Any[] = [];
  const clerk: ClerkLike = {
    getFapiClient: () => ({
      request: (init) => {
        requests.push(init);
        if (init.path === "/client/hosted_auth") {
          return Promise.resolve({
            ok: true,
            status: 200,
            payload: { response: { object: "hosted_auth", url: "https://accounts.example.com/x" } },
          });
        }
        onRedeem?.(init.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          payload: { response: { object: "client", sessions: [{ id: "sess_1" }] } },
        });
      },
    }),
    client: { fromJSON: () => undefined },
    setActive: ({ session }) => Promise.resolve(void active.push(session)),
  };
  return { clerk, active, requests };
}

Deno.test("clerk mobile: the hosted (passkey) sign-in binds state and PKCE to this page", async () => {
  let redeemed: Any;
  const auth = authPlugin(() => "");
  await inShell({ DenextAuthSession: auth.plugin }, async () => {
    const { clerk, active, requests } = fakeClerk((b) => (redeemed = b));
    auth.plugin.start = (o: Any) => {
      auth.starts.push(o);
      const state = requests[0].body.state;
      return Promise.resolve({
        url: `myapp://app/?state=${state}&rotating_token_nonce=n1&created_session_id=sess_1`,
      });
    };
    const out = await startClerkMobileBrowserSignIn(clerk, {
      redirectUrl: "myapp://app/",
      scheme: "myapp",
    });
    assertEquals(out, { createdSessionId: "sess_1" });
    assertEquals(active, ["sess_1"]);
    assertEquals(auth.starts[0].url, "https://accounts.example.com/x");
    assertEquals(requests[0].body.redirectUrl, "myapp://app/");
    assert(typeof requests[0].body.codeChallenge === "string");
    assertEquals(redeemed.rotatingTokenNonce, "n1");
    assertEquals(redeemed.codeVerifier.length, 64);
  });
  // A callback with another state is refused; nothing is redeemed.
  await inShell({
    DenextAuthSession: authPlugin(
      "myapp://app/?state=forged&rotating_token_nonce=n&created_session_id=sess_1",
    ).plugin,
  }, async () => {
    let redeemedForged = false;
    const { clerk } = fakeClerk(() => (redeemedForged = true));
    await assertRejects(
      () => startClerkMobileBrowserSignIn(clerk, { redirectUrl: "myapp://app/", scheme: "myapp" }),
      Error,
      "state",
    );
    assertEquals(redeemedForged, false);
  });
});
