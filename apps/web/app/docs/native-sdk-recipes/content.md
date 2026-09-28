---
title: Native SDK recipes
slug: native-sdk-recipes
lead: What to use on denext in place of the native-only SDKs React Native apps lean on most, Firebase, in-app purchases and Stripe, and which half of each runs in the WebView and which needs a native plugin.
---

`@react-native-firebase/*`, `react-native-iap` and `@stripe/stripe-react-native` are native
modules: they have no web build and no denext alias, so in [React Native mode](/docs/react-native)
their imports resolve to the real packages and fail when called. Each has a replacement that
runs in the Capacitor shell, and usually in a browser too. Some are denext APIs; others are the
vendor's web SDK or a community Capacitor plugin, which denext neither wraps nor tests. This page
says which is which.

To move an existing React Native call site, put the calls behind a module of your own (say
`lib/payments.ts`) and give it a `.web.ts` twin: React Native mode picks the `.web.*` file, and
Metro keeps the native one. Or map the package to your module in `deno.json` `imports`
([Other native-only packages](/docs/react-native#other-native-only-packages)).

## Firebase (`@react-native-firebase/*`)

| Module                               | On denext                                                                                                            | Where it runs                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `messaging` (push)                   | `denext mobile add push` + `registerForPush` in the app, `createPushSender` / `sendPush` on your server (APNs + FCM) | Native (the Capacitor plugin); your server sends                |
| `auth`                               | The Firebase JS SDK (`firebase/auth`) with a native sign-in sheet: `signInWithApple` / `signInWithGoogle`            | Web SDK in the WebView; the sheet is native                     |
| `firestore`, `database`, `functions` | The Firebase JS SDK                                                                                                  | WebView and browser                                             |
| `storage`, `remote-config`           | The Firebase JS SDK                                                                                                  | WebView and browser                                             |
| `analytics`                          | `@capacitor-firebase/analytics` for app streams; the JS SDK's analytics in a browser                                 | Native plugin (not wrapped by denext)                           |
| `crashlytics`                        | `denext mobile add sentry` (`initCrashReporting`), or `@capacitor-firebase/crashlytics`                              | Native (Sentry is a denext capability; Crashlytics is a plugin) |

### Push through FCM and APNs

denext's push path needs no Firebase SDK in the app. `denext mobile add push` installs
`@capacitor/push-notifications`: `registerForPush()` resolves an **APNs device token on iOS** and
an **FCM registration token on Android** (Android still needs your Firebase project's
`android/app/google-services.json`). Your server sends to each through its own service:

```tsx
// app/push-opt-in.tsx: ask once, then send the token to your server
"use client";
import { registerForPush, requestPushPermission } from "denext/mobile";

export function PushOptIn({ userId }: { userId: string }) {
  async function enable() {
    if ((await requestPushPermission()) !== "granted") return;
    const { platform, token } = await registerForPush(); // call it on every launch: tokens change
    await fetch("https://api.example.com/api/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, platform, token }),
    });
  }
  return <button type="button" onClick={enable}>Turn on notifications</button>;
}
```

```ts
// lib/push.ts: server-only; APNs over HTTP/2 with a .p8 key, FCM HTTP v1 with a service account
import { createPushSender } from "denext/server";

export const push = createPushSender({
  apns: {
    keyId: Deno.env.get("APNS_KEY_ID")!,
    teamId: Deno.env.get("APNS_TEAM_ID")!,
    p8: Deno.env.get("APNS_P8")!,
    topic: "com.example.app",
    production: true, // TestFlight / App Store builds; false for development builds
  },
  fcm: { serviceAccount: JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT")!) },
});

// const result = await push.send({ platform, token }, { title: "Shipped", body: "Order #42" });
// if (!result.ok && result.error === "invalid-token") await db.devices.delete(token);
```

If your backend already sends through Firebase to **FCM tokens on both platforms** (the
`@react-native-firebase/messaging` model), keep it and get an FCM token on iOS from
`@capacitor-firebase/messaging` instead of `denext mobile add push`. Install one push plugin, not
both. denext's `registerForPush`, `onPushTapped` and the `expo-notifications` shim are built on
`@capacitor/push-notifications`, so with the Firebase plugin you use its API for tokens and taps.
The details are on [Push notifications](/docs/mobile#push-notifications).

### Auth, Firestore and the rest of the JS SDK

The Firebase JS SDK is plain JavaScript over HTTPS and WebSockets, so Firestore, the Realtime
Database, Cloud Functions, Storage and Remote Config run in the Capacitor WebView as they do in a
browser. Two things differ from a web app:

- **Sign-in popups and redirects do not work in the shell.** Sign in with the native sheet and
  hand its `id_token` to Firebase. For Google, pass your Firebase project's **Web client ID** as
  `webClientId`, so the token's audience is one Firebase accepts.
- **On iOS, initialize Auth with IndexedDB persistence** instead of `getAuth()`, which also sets
  up the popup and redirect handling the WebView cannot use.

```ts
// lib/firebase.ts: a client module
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  OAuthProvider,
  signInWithCredential,
} from "firebase/auth";
import { isNativeShell, signInWithApple, signInWithGoogle } from "denext/mobile";

export const app = initializeApp({
  apiKey: "…",
  authDomain: "example.firebaseapp.com",
  projectId: "example",
  appId: "…",
});
export const auth = isNativeShell()
  ? initializeAuth(app, { persistence: indexedDBLocalPersistence })
  : getAuth(app);

export async function signInGoogle() {
  const { idToken } = await signInWithGoogle({
    webClientId: "1234-web.apps.googleusercontent.com", // the Firebase project's Web client
    iosClientId: "1234-ios.apps.googleusercontent.com",
  });
  return signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
}

export async function signInApple() {
  const rawNonce = crypto.randomUUID(); // signInWithApple sends Apple its SHA-256, as Firebase expects
  const { idToken } = await signInWithApple({ nonce: rawNonce });
  return signInWithCredential(
    auth,
    new OAuthProvider("apple.com").credential({ idToken, rawNonce }),
  );
}
```

`signInWithApple` / `signInWithGoogle` need `denext mobile add social-login` and reject with
code `unsupported` in a browser, where Firebase's own `signInWithPopup` works. Firestore's
offline cache (`persistentLocalCache()`) lives in the WebView's IndexedDB, which the OS may clear
under storage pressure: treat it as a cache, not as the only copy.

### Analytics and Crashlytics

Firebase Analytics' JS SDK measures a **web** data stream. For app streams (the iOS and Android
apps in the Firebase console), use a native plugin such as `@capacitor-firebase/analytics`, which
needs the native Firebase setup its install guide describes (`GoogleService-Info.plist`,
`google-services.json`):

```ts
import { FirebaseAnalytics } from "@capacitor-firebase/analytics";

await FirebaseAnalytics.logEvent({ name: "purchase", params: { value: 9.99, currency: "USD" } });
```

For crash reports, denext's own capability is Sentry: `denext mobile add sentry` and
`initCrashReporting` report native and JavaScript crashes under the over-the-air UI version, with
hidden source maps from `denext export --sourcemaps hidden`
([Crash reporting](/docs/mobile#crash-reporting)). If you stay on Crashlytics,
`@capacitor-firebase/crashlytics` is the plugin.

## In-app purchases (`react-native-iap`, `react-native-purchases`)

Apple and Google require their own billing for digital goods and subscriptions sold in the app
(App Store Review Guideline 3.1.1), so purchases are a native call in every case.

**RevenueCat is denext's capability.** `denext mobile add purchases` installs
`@revenuecat/purchases-capacitor`, and `denext/mobile` wraps it. In React Native mode,
`react-native-purchases` already resolves to it, so an app on RevenueCat keeps its imports
([Community packages](/docs/react-native#community-packages)). There is no web fallback: every call
rejects with code `unsupported` in a browser.

```tsx
// app/paywall.tsx
"use client";
import { useEffect, useState } from "denext";
import {
  configurePurchases,
  getOfferings,
  type PurchasePackage,
  purchasePackage,
  useEntitlement,
} from "denext/mobile";

export function Paywall({ userId }: { userId: string }) {
  const [packages, setPackages] = useState<PurchasePackage[]>([]);
  const { active } = useEntitlement("pro");
  useEffect(() => {
    configurePurchases({ apiKey: { ios: "appl_…", android: "goog_…" }, appUserId: userId })
      .then(getOfferings)
      .then(({ current }) => setPackages([...(current?.availablePackages ?? [])]));
  }, [userId]);
  if (active) return <p>You have Pro.</p>;
  return (
    <ul>
      {packages.map((pkg) => (
        <li key={pkg.identifier}>
          <button
            type="button"
            onClick={() =>
              purchasePackage(pkg).catch((err) => {
                if (err.code !== "cancelled") console.error(err);
              })}
          >
            {pkg.product.title}: {pkg.product.priceString}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

On the server, `verifyRevenueCatWebhook(request, { authorization })` from `denext/server` checks
RevenueCat's webhook and types its event, so your database can grant and revoke entitlements
([App backend](/docs/app-backend)).

**`react-native-iap` has no alias.** It is a native module (current releases are built on Nitro
modules, which a WebView cannot load). Rewrite its call sites onto `denext/mobile`'s purchases, or,
to keep talking to StoreKit and Play Billing without RevenueCat, onto a Capacitor plugin such as
`@capgo/native-purchases` (not wrapped or tested by denext). Receipt validation then stays on
your server, as it was with `react-native-iap`.

## Payments with Stripe (`@stripe/stripe-react-native`)

Stripe is for physical goods and services used outside the app; digital goods sold in an iOS or
Android app go through the store's billing (above). `@stripe/stripe-react-native` is native-only.
Two replacements:

- **Stripe.js and the Payment Element** (`npm:@stripe/stripe-js`) run in the Capacitor WebView
  and in a browser: card entry, 3-D Secure and most payment methods, all inside Stripe's
  iframes. Apple Pay and Google Pay are the exception: WebKit turns Apple Pay off in a WKWebView
  that injects scripts, which Capacitor does, so do not count on the wallets appearing in the
  shell.
- **A Capacitor Stripe plugin** such as `@capacitor-community/stripe` presents the native
  Payment Sheet, Apple Pay and Google Pay (not wrapped or tested by denext).

Both take a PaymentIntent's client secret from your server. Create it with Stripe's REST API from
a route handler; the secret key never leaves the server (`denext mobile doctor --release` reports
a Stripe live secret key found in the export):

```ts
// app/api/payment-intent/route.ts
export async function POST(request: Request): Promise<Response> {
  const { amount } = await request.json(); // price it on the server in a real app
  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      amount: String(amount),
      currency: "usd",
      "automatic_payment_methods[enabled]": "true",
    }),
  });
  const intent = await res.json();
  if (!res.ok) return Response.json({ error: intent.error?.message }, { status: 502 });
  return Response.json({ clientSecret: intent.client_secret });
}
```

```tsx
// app/checkout.tsx: the Payment Element in a client component
"use client";
import { useEffect, useRef, useState } from "denext";
import { loadStripe, type Stripe, type StripeElements } from "@stripe/stripe-js";

const stripePromise = loadStripe("pk_live_…"); // the publishable key

export function Checkout({ clientSecret }: { clientSecret: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const ready = useRef<{ stripe: Stripe; elements: StripeElements } | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    stripePromise.then((stripe) => {
      if (!stripe || !box.current) return;
      const elements = stripe.elements({ clientSecret });
      elements.create("payment").mount(box.current);
      ready.current = { stripe, elements };
    });
  }, [clientSecret]);
  async function pay() {
    if (!ready.current) return;
    const { error } = await ready.current.stripe.confirmPayment({
      elements: ready.current.elements,
      confirmParams: { return_url: "https://example.com/checkout/done" },
      redirect: "if_required",
    });
    setMessage(error?.message ?? "Paid");
  }
  return (
    <div>
      <div ref={box} />
      <button type="button" onClick={pay}>Pay</button>
      <p>{message}</p>
    </div>
  );
}
```

A payment method that must leave the page (a bank redirect) returns to `return_url`; in the
shell, make that a universal link or App Link your app handles
([Deep links](/docs/mobile#deep-links)). On a server-rendered page, denext's strict
Content-Security-Policy blocks Stripe's iframes, because the `csp` options have no `frame-src`
([Known limitations](/docs/limitations)): set `export const csp = "off"` on the checkout route
and send a policy that allows `https://js.stripe.com` in `script-src` and `frame-src` and
`https://api.stripe.com` in `connect-src`.

Confirm the payment from Stripe's webhook, not from the page. The signature check needs no SDK:

```ts
// app/api/stripe/webhook/route.ts
const encoder = new TextEncoder();

async function verifyStripeEvent(request: Request, secret: string) {
  const body = await request.text();
  const fields = (request.headers.get("stripe-signature") ?? "").split(",").map((f) =>
    f.split("=")
  );
  const timestamp = fields.find(([k]) => k === "t")?.[1];
  const signatures = fields.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(`${timestamp}.${body}`);
  for (const hex of signatures) {
    const mac = new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
    if (await crypto.subtle.verify("HMAC", key, mac, signed)) return JSON.parse(body);
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const event = await verifyStripeEvent(request, Deno.env.get("STRIPE_WEBHOOK_SECRET")!);
  if (!event) return new Response(null, { status: 400 });
  if (event.type === "payment_intent.succeeded") await fulfil(event.data.object.id);
  return new Response(null, { status: 200 });
}
```

## Other native-only packages

The packages below are native modules without a denext alias either. Each row names the nearest
denext replacement; where there is none, the Capacitor plugin to look at.

| Package                                     | Replacement                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `react-native-fs`, `react-native-blob-util` | `readFile` / `writeFile` / `listDir` / `downloadToFile` from `denext/mobile` (`denext mobile add filesystem`) |
| `react-native-vision-camera`                | `pickImage` / `scanBarcode`, or the `expo-camera` shim (a `getUserMedia` preview); no frame processors        |
| `react-native-image-crop-picker`            | `pickImage` (one image, no crop editor)                                                                       |
| `react-native-config`                       | A module of your own mapped in `deno.json` `imports`, holding the build's public values                       |
| `@sentry/react-native`                      | `denext mobile add sentry` and `initCrashReporting`                                                           |
| CodePush (`react-native-code-push`)         | Over-the-air UI updates (`denext mobile add-ota`, `checkForUiUpdate`)                                         |
| OneSignal, `react-native-google-mobile-ads` | The vendor's Capacitor or Cordova plugin (not wrapped by denext), or denext's push for notifications          |
