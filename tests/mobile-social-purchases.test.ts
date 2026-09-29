// denext/mobile's native social sign-in (signInWithApple / signInWithGoogle / signInNative,
// wired to the native session client) and in-app purchases (RevenueCat), each in a faked
// Capacitor shell and on the web (where both reject), plus denext/server's RevenueCat webhook
// verifier.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  configurePurchases,
  getCustomerInfo,
  getOfferings,
  purchasePackage,
  restorePurchases,
  signInNative,
  signInWithApple,
  signInWithGoogle,
  useEntitlement,
} from "../src/mobile/mod.ts";
import { resetSocialLoginForTesting } from "../src/mobile/social-login.ts";
import { resetPurchasesForTesting } from "../src/mobile/purchases.ts";
import { nativeSession } from "../src/runtime/native-session.ts";
import { RevenueCatWebhookError, verifyRevenueCatWebhook } from "../src/server/mod.ts";
import { type Any, fakePlugin, inShell, mount, settle, Target } from "./helpers/mobile-fakes.ts";

/** A JWT-shaped string (the client never decodes it). */
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- social login -----------------------------------------------------------------------------

Deno.test("signInWithApple: initializes once, sends the nonce's SHA-256, maps the result", async () => {
  resetSocialLoginForTesting();
  const social = fakePlugin(["initialize", "login"], {
    login: {
      provider: "apple",
      result: {
        idToken: ID_TOKEN,
        accessToken: null,
        authorizationCode: "c0de",
        profile: {
          user: "001.abc",
          email: "a@privaterelay.appleid.com",
          givenName: "Ada",
          familyName: "L",
        },
      },
    },
  });
  await inShell("ios", { SocialLogin: social.plugin }, async () => {
    assertEquals(await signInWithApple({ nonce: "n1" }), {
      idToken: ID_TOKEN,
      nonce: "n1",
      authorizationCode: "c0de",
      name: "Ada L",
      email: "a@privaterelay.appleid.com",
      user: "001.abc",
    });
    await signInWithApple();
  });
  assertEquals(social.calls, [
    ["initialize", { apple: { useProperTokenExchange: true } }],
    ["login", { provider: "apple", options: { nonce: await sha256Hex("n1") } }],
    ["login", { provider: "apple", options: {} }],
  ]);
});

Deno.test("signInWithApple: iOS only; cancel / no token / missing plugin errors", async () => {
  resetSocialLoginForTesting();
  await inShell("android", {}, async () => {
    const err = await assertRejects(() => signInWithApple(), Error, "iOS only");
    assertEquals((err as Any).code, "unsupported");
  });
  await inShell("ios", {}, async () => {
    const err = await assertRejects(() => signInWithApple(), Error, "mobile add social-login");
    assertEquals((err as Any).code, "unsupported");
  });
  const cancelled = fakePlugin(["initialize", "login"], {
    login: new Error("The operation couldn’t be completed. (AuthorizationError error 1001.)"),
  });
  await inShell("ios", { SocialLogin: cancelled.plugin }, async () => {
    const err = await assertRejects(() => signInWithApple(), Error);
    assertEquals((err as Any).code, "cancelled");
  });
  resetSocialLoginForTesting();
  const empty = fakePlugin(["initialize", "login"], { login: { result: { idToken: null } } });
  await inShell("ios", { SocialLogin: empty.plugin }, async () => {
    const err = await assertRejects(() => signInWithApple(), Error, "no identity token");
    assertEquals((err as Any).code, "no_id_token");
  });
});

Deno.test("signInWithGoogle: per-platform initialize, raw nonce, profile mapping", async () => {
  resetSocialLoginForTesting();
  const result = {
    result: {
      idToken: ID_TOKEN,
      responseType: "online",
      profile: { id: "g1", email: "a@x.dev", name: "Ada", givenName: "Ada", familyName: "L" },
    },
  };
  const ios = fakePlugin(["initialize", "login"], { login: result });
  await inShell("ios", { SocialLogin: ios.plugin }, async () => {
    assertEquals(
      await signInWithGoogle({
        webClientId: "web",
        iosClientId: "ios",
        nonce: "n2",
        scopes: ["email"],
      }),
      { idToken: ID_TOKEN, nonce: "n2", name: "Ada", email: "a@x.dev", user: "g1" },
    );
    await assertRejects(() => signInWithGoogle({ webClientId: "web" }), TypeError, "iosClientId");
  });
  assertEquals(ios.calls, [
    ["initialize", { google: { iOSClientId: "ios", iOSServerClientId: "web", mode: "online" } }],
    ["login", { provider: "google", options: { scopes: ["email"], nonce: "n2" } }],
  ]);
  resetSocialLoginForTesting();
  const android = fakePlugin(["initialize", "login"], { login: result });
  await inShell("android", { SocialLogin: android.plugin }, async () => {
    await signInWithGoogle({
      webClientId: "web",
      filterByAuthorizedAccounts: true,
      autoSelect: true,
    });
  });
  assertEquals(android.calls, [
    ["initialize", { google: { webClientId: "web", mode: "online" } }],
    ["login", {
      provider: "google",
      options: { filterByAuthorizedAccounts: true, autoSelectEnabled: true },
    }],
  ]);
  await assertRejects(() => signInWithGoogle({} as Any), TypeError, "webClientId");
  const err = await assertRejects(() => signInWithGoogle({ webClientId: "w" }), Error);
  assertEquals((err as Any).code, "unsupported", "no web fallback");
});

Deno.test("signInNative: server nonce → Apple sheet → POST /auth/native/apple via nativeSession", async () => {
  resetSocialLoginForTesting();
  const requests: Array<{ url: string; body: Any }> = [];
  const fetch = (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    const json = url.endsWith("/nonce") ? { nonce: "srv-nonce", expires_in: 600 } : {
      access_token: "at",
      expires_in: 900,
      refresh_token: "rt",
      user: { id: "u1", name: "Ada L" },
    };
    return Promise.resolve(Response.json(json));
  };
  const stored = new Map<string, string>();
  const session = nativeSession({
    base: "https://api.example.com",
    redirectUri: "com.example.app://auth",
    storage: {
      get: (k) => Promise.resolve(stored.get(k) ?? null),
      set: (k, v) => Promise.resolve(void stored.set(k, v)),
      delete: (k) => Promise.resolve(void stored.delete(k)),
    },
    fetch: fetch as typeof globalThis.fetch,
  });
  const social = fakePlugin(["initialize", "login"], {
    login: {
      result: {
        idToken: ID_TOKEN,
        authorizationCode: "c0de",
        profile: { user: "001", givenName: "Ada", familyName: "L", email: null },
      },
    },
  });
  await inShell("ios", { SocialLogin: social.plugin }, async () => {
    assertEquals(await signInNative(session, "apple"), { id: "u1", name: "Ada L" });
  });
  assertEquals(requests.map((r) => r.url), [
    "https://api.example.com/auth/native/nonce",
    "https://api.example.com/auth/native/apple",
  ]);
  assertEquals(requests[1].body, {
    id_token: ID_TOKEN,
    nonce: "srv-nonce",
    authorization_code: "c0de",
    name: "Ada L",
  });
  assertEquals(social.calls[1], [
    "login",
    { provider: "apple", options: { nonce: await sha256Hex("srv-nonce") } },
  ]);
  assertEquals(stored.get("denext.native.refreshToken"), "rt");
  await assertRejects(() => signInNative(session, "google"), TypeError, "webClientId");
});

// ---- purchases ----------------------------------------------------------------------------------

const RC_METHODS = [
  "configure",
  "getOfferings",
  "purchasePackage",
  "restorePurchases",
  "getCustomerInfo",
];

function customerInfo(active: boolean) {
  const pro = {
    identifier: "pro",
    isActive: active,
    willRenew: active,
    expirationDate: null,
    productIdentifier: "pro_monthly",
  };
  return {
    entitlements: { all: { pro }, active: active ? { pro } : {} },
    activeSubscriptions: active ? ["pro_monthly"] : [],
    originalAppUserId: "$RCAnonymousID:1",
  };
}

const PACKAGE = {
  identifier: "$rc_monthly",
  packageType: "MONTHLY",
  offeringIdentifier: "default",
  product: {
    identifier: "pro_monthly",
    title: "Pro",
    description: "",
    price: 4.99,
    priceString: "$4.99",
    currencyCode: "USD",
  },
};

Deno.test("purchases: configure per-platform key, offerings, purchase, restore, errors", async () => {
  resetPurchasesForTesting();
  const offerings = { current: null, all: {} };
  const rc = fakePlugin(RC_METHODS, {
    getOfferings: offerings,
    purchasePackage: {
      productIdentifier: "pro_monthly",
      customerInfo: customerInfo(true),
      transaction: {},
    },
    restorePurchases: { customerInfo: customerInfo(true) },
    getCustomerInfo: { customerInfo: customerInfo(false) },
  });
  await inShell("android", { Purchases: rc.plugin }, async () => {
    const early = await assertRejects(() => getOfferings(), Error, "configurePurchases");
    assertEquals((early as Any).code, "not_configured");
    await assertRejects(
      () => configurePurchases({ apiKey: { ios: "appl_x" } }),
      TypeError,
      "android",
    );
    await configurePurchases({ apiKey: { ios: "appl_x", android: "goog_y" }, appUserId: "u1" });
    assertEquals(await getOfferings(), offerings);
    assertEquals((await purchasePackage(PACKAGE)).productIdentifier, "pro_monthly");
    assertEquals((await restorePurchases()).activeSubscriptions, ["pro_monthly"]);
    assertEquals((await getCustomerInfo()).activeSubscriptions, []);
  });
  assertEquals(rc.calls.slice(0, 3), [
    ["configure", { apiKey: "goog_y", appUserID: "u1" }],
    ["getOfferings", undefined],
    ["purchasePackage", { aPackage: PACKAGE }],
  ]);

  const cancelling = fakePlugin(RC_METHODS, {
    purchasePackage: Object.assign(new Error("Purchase was cancelled."), { code: "1" }),
    restorePurchases: Object.assign(new Error("Store problem"), { data: { code: 2 } }),
  });
  await inShell("ios", { Purchases: cancelling.plugin }, async () => {
    const cancelled = await assertRejects(() => purchasePackage(PACKAGE), Error, "cancelled");
    assertEquals((cancelled as Any).code, "cancelled");
    const store = await assertRejects(() => restorePurchases(), Error, "Store problem");
    assertEquals([(store as Any).code, (store as Any).storeCode], ["store", "2"]);
  });
  resetPurchasesForTesting();
  const web = await assertRejects(
    () => configurePurchases({ apiKey: "k" }),
    Error,
    "no web fallback",
  );
  assertEquals((web as Any).code, "unsupported");
});

Deno.test("useEntitlement: reads on mount, follows purchases and app resume", async () => {
  resetPurchasesForTesting();
  let active = false;
  const rc = fakePlugin(RC_METHODS, {
    purchasePackage: {
      productIdentifier: "pro_monthly",
      customerInfo: customerInfo(true),
      transaction: {},
    },
  });
  rc.plugin.getCustomerInfo = () => Promise.resolve({ customerInfo: customerInfo(active) });
  const doc = Object.assign(new Target(), { visibilityState: "visible" });
  await inShell("ios", { Purchases: rc.plugin }, async () => {
    await configurePurchases({ apiKey: "appl_x" });
    let state: Any;
    const { root, rerender } = mount(function Probe() {
      state = useEntitlement("pro");
      return null;
    });
    assertEquals(state.active, undefined, "unknown until RevenueCat answers");
    await settle();
    rerender();
    assertEquals(state.active, false);
    await purchasePackage(PACKAGE);
    rerender();
    assertEquals(state.active, true, "a purchase anywhere updates it");
    assertEquals(state.entitlement.productIdentifier, "pro_monthly");
    active = false;
    doc.fire("pause");
    doc.fire("resume");
    await settle();
    rerender();
    assertEquals(state.active, false, "re-read on resume");
    root.unmount();
  }, { document: doc });

  resetPurchasesForTesting();
  let webState: Any;
  const { root, rerender } = mount(function Probe() {
    webState = useEntitlement("pro");
    return null;
  });
  await settle();
  rerender();
  assertEquals(webState.error?.code, "unsupported");
  root.unmount();
});

// ---- RevenueCat webhook -----------------------------------------------------------------------------

function webhook(body: unknown, authorization?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  return new Request("https://api.example.com/api/revenuecat", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const EVENT = {
  api_version: "1.0",
  event: {
    id: "evt_1",
    type: "INITIAL_PURCHASE",
    app_user_id: "u1",
    product_id: "pro_monthly",
    entitlement_ids: ["pro"],
    environment: "SANDBOX",
    expiration_at_ms: 1_900_000_000_000,
  },
};

Deno.test("verifyRevenueCatWebhook: checks Authorization, parses the typed event", async () => {
  const opts = { authorization: "Bearer s3cret" };
  const parsed = await verifyRevenueCatWebhook(webhook(EVENT, "Bearer s3cret"), opts);
  assertEquals(parsed, EVENT);
  assertEquals(parsed.event.entitlement_ids, ["pro"]);

  const refusals: Array<[Request, number, string]> = [
    [webhook(EVENT), 401, "does not match"],
    [webhook(EVENT, "Bearer wrong"), 401, "does not match"],
    [webhook(EVENT, "Bearer s3cret-longer"), 401, "does not match"],
    [webhook("{not json", "Bearer s3cret"), 400, "not JSON"],
    [webhook({ event: [] }, "Bearer s3cret"), 400, "no event"],
    [webhook({ event: { id: "e", type: "RENEWAL" } }, "Bearer s3cret"), 400, "app_user_id"],
  ];
  for (const [request, status, message] of refusals) {
    const err = await assertRejects(
      () => verifyRevenueCatWebhook(request, opts),
      RevenueCatWebhookError,
      message,
    );
    assertEquals((err as RevenueCatWebhookError).status, status);
  }
  const big = await assertRejects(
    () => verifyRevenueCatWebhook(webhook(EVENT, "Bearer s3cret"), { ...opts, maxBodyBytes: 10 }),
    RevenueCatWebhookError,
  );
  assertEquals((big as RevenueCatWebhookError).status, 413);
  await assertRejects(
    () => verifyRevenueCatWebhook(webhook(EVENT, ""), { authorization: "" }),
    TypeError,
  );
  const noVersion = await verifyRevenueCatWebhook(
    webhook({ event: EVENT.event }, "Bearer s3cret"),
    opts,
  );
  assert(noVersion.api_version === "1.0");
});
