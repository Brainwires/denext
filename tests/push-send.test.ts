// denext/server's zero-npm push sender (src/server/push-send.ts): the APNs ES256 provider JWT
// and the FCM RS256 service-account exchange (claims + signatures verified), token caching and
// refresh, the retry on a refused provider token, the payload / header mapping (alerts,
// background, Live Activities) and every error mapping. fetch is injected: no network.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createPushSender,
  type PushErrorCode,
  type PushSenderConfig,
  sendPush,
} from "../src/server/push-send.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function toPem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${
    b64.match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----\n`;
}

const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]) as CryptoKeyPair;
const P8 = toPem(await crypto.subtle.exportKey("pkcs8", ec.privateKey));
const rsa = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
) as CryptoKeyPair;
const RSA_PEM = toPem(await crypto.subtle.exportKey("pkcs8", rsa.privateKey));

const APNS = { keyId: "KEY1234567", teamId: "TEAM123456", p8: P8, topic: "com.example.app" };
const ACCOUNT = {
  client_email: "push@example.iam.gserviceaccount.com",
  // Escaped newlines, as the key arrives from an env var.
  private_key: RSA_PEM.replace(/\n/g, "\\n"),
  project_id: "my-project",
};

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split(".");
  const json = (p: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  return { header: json(h), claims: json(c), input: `${h}.${c}`, sig: b64urlDecode(s) };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch answering each call with the next responder's Response. */
function fakeFetch(...responders: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ""),
    };
    calls.push(call);
    const next = responders.length > 1 ? responders.shift()! : responders[0];
    return Promise.resolve(next(call));
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const ok = (headers: Record<string, string> = {}) => () =>
  new Response(null, { status: 200, headers });
const apnsFail = (status: number, reason: string, headers: Record<string, string> = {}) => () =>
  Response.json({ reason }, { status, headers });

const IOS = { platform: "ios", token: "abcd1234" } as const;
const ANDROID = { platform: "android", token: "fcm-token" } as const;

// ---- APNs -------------------------------------------------------------------------------------

Deno.test("apns: ES256 provider JWT with kid / iss / iat, verifiable with the public key", async () => {
  const { fetch, calls } = fakeFetch(ok({ "apns-id": "uuid-1" }));
  const now = () => 1_800_000_000_000;
  const push = createPushSender({ apns: APNS, fetch, now });
  const result = await push.send(IOS, { title: "Hi", body: "There" });
  assertEquals(result, { ok: true, id: "uuid-1" });
  const auth = calls[0].headers.authorization;
  assert(auth.startsWith("bearer "));
  const jwt = decodeJwt(auth.slice(7));
  assertEquals(jwt.header, { alg: "ES256", kid: "KEY1234567" });
  assertEquals(jwt.claims, { iss: "TEAM123456", iat: 1_800_000_000 });
  assertEquals(jwt.sig.byteLength, 64, "raw r||s");
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      ec.publicKey,
      jwt.sig,
      new TextEncoder().encode(jwt.input),
    ),
  );
});

Deno.test("apns: sandbox by default, production host when asked; alert payload + headers", async () => {
  const { fetch, calls } = fakeFetch(ok());
  const now = () => 1_800_000_000_000;
  await createPushSender({ apns: APNS, fetch, now }).send(IOS, {
    title: "T",
    subtitle: "S",
    body: "B",
    badge: 3,
    sound: "default",
    category: "REPLY",
    threadId: "chat-1",
    mutableContent: true,
    collapseId: "c1",
    ttl: 3600,
    priority: "normal",
    data: { orderId: 42, nested: { a: 1 } },
  });
  await createPushSender({ apns: { ...APNS, production: true }, fetch, now }).send(IOS, {
    body: "x",
    ttl: 0,
  });
  assertEquals(calls[0].url, "https://api.sandbox.push.apple.com/3/device/abcd1234");
  assertEquals(calls[1].url, "https://api.push.apple.com/3/device/abcd1234");
  const h = calls[0].headers;
  assertEquals(h["apns-topic"], "com.example.app");
  assertEquals(h["apns-push-type"], "alert");
  assertEquals(h["apns-priority"], "5");
  assertEquals(h["apns-expiration"], String(1_800_000_000 + 3600));
  assertEquals(h["apns-collapse-id"], "c1");
  assertEquals(calls[1].headers["apns-expiration"], "0");
  assertEquals(calls[1].headers["apns-priority"], "10");
  assertEquals(JSON.parse(calls[0].body), {
    orderId: 42,
    nested: { a: 1 },
    aps: {
      alert: { title: "T", subtitle: "S", body: "B" },
      badge: 3,
      sound: "default",
      category: "REPLY",
      "thread-id": "chat-1",
      "mutable-content": 1,
    },
  });
});

Deno.test("apns: a content-available-only push is a background push at priority 5", async () => {
  const { fetch, calls } = fakeFetch(ok());
  await createPushSender({ apns: APNS, fetch }).send(IOS, {
    contentAvailable: true,
    priority: "high",
    data: { sync: "1" },
  });
  assertEquals(calls[0].headers["apns-push-type"], "background");
  assertEquals(calls[0].headers["apns-priority"], "5");
  assertEquals(JSON.parse(calls[0].body), { sync: "1", aps: { "content-available": 1 } });
});

Deno.test("apns: Live Activity push type, topic suffix and aps fields", async () => {
  const { fetch, calls } = fakeFetch(ok());
  const now = () => 1_800_000_000_500;
  const push = createPushSender({ apns: APNS, fetch, now });
  await push.send(IOS, {
    liveActivity: {
      event: "update",
      contentState: { eta: 5 },
      staleDate: 1_800_000_600_000,
      alert: { title: "Nearly there", body: "5 min", sound: "default" },
    },
  });
  await push.send(IOS, {
    liveActivity: {
      event: "end",
      contentState: { eta: 0 },
      timestamp: 1_700_000_000_000,
      dismissalDate: 1_800_000_900_000,
    },
  });
  await push.send(IOS, {
    liveActivity: {
      event: "start",
      contentState: { eta: 20 },
      attributesType: "DeliveryAttributes",
      attributes: { orderId: "42" },
    },
  });
  assertEquals(calls[0].headers["apns-push-type"], "liveactivity");
  assertEquals(calls[0].headers["apns-topic"], "com.example.app.push-type.liveactivity");
  assertEquals(JSON.parse(calls[0].body).aps, {
    timestamp: 1_800_000_000,
    event: "update",
    "content-state": { eta: 5 },
    "stale-date": 1_800_000_600,
    alert: { title: "Nearly there", body: "5 min" },
    sound: "default",
  });
  assertEquals(JSON.parse(calls[1].body).aps, {
    timestamp: 1_700_000_000,
    event: "end",
    "content-state": { eta: 0 },
    "dismissal-date": 1_800_000_900,
  });
  const start = JSON.parse(calls[2].body).aps;
  assertEquals(start["attributes-type"], "DeliveryAttributes");
  assertEquals(start.attributes, { orderId: "42" });
});

Deno.test("apns: payload refusals happen before sending", async () => {
  const { fetch, calls } = fakeFetch(ok());
  const push = createPushSender({ apns: APNS, fetch });
  const big = await push.send(IOS, { body: "x".repeat(5000) });
  assertEquals(big.ok === false && big.error, "payload");
  const aps = await push.send(IOS, { data: { aps: 1 } });
  assertEquals(aps.ok === false && aps.error, "payload");
  const start = await push.send(IOS, { liveActivity: { event: "start", contentState: {} } });
  assertEquals(start.ok === false && start.error, "payload");
  assertEquals(calls.length, 0);
});

Deno.test("apns: the provider token is cached for 50 minutes, then re-signed", async () => {
  const { fetch, calls } = fakeFetch(ok());
  let t = 1_800_000_000_000;
  const push = createPushSender({ apns: APNS, fetch, now: () => t });
  await push.send(IOS, { body: "1" });
  t += 49 * 60_000;
  await push.send(IOS, { body: "2" });
  t += 60_000;
  await push.send(IOS, { body: "3" });
  const tokens = calls.map((c) => c.headers.authorization);
  assertEquals(tokens[0], tokens[1]);
  assert(tokens[2] !== tokens[1]);
  assertEquals(decodeJwt(tokens[2].slice(7)).claims.iat, 1_800_000_000 + 50 * 60);
});

Deno.test("apns: ExpiredProviderToken re-signs and retries once; a second refusal is auth", async () => {
  let t = 1_800_000_000_000;
  const retry = fakeFetch(
    () => {
      t += 1000; // the fresh token differs from the cached one
      return apnsFail(403, "ExpiredProviderToken")();
    },
    ok({ "apns-id": "x" }),
  );
  const push = createPushSender({ apns: APNS, fetch: retry.fetch, now: () => t });
  assertEquals(await push.send(IOS, { body: "b" }), { ok: true, id: "x" });
  assertEquals(retry.calls.length, 2);
  assert(retry.calls[0].headers.authorization !== retry.calls[1].headers.authorization);

  const twice = fakeFetch(apnsFail(403, "InvalidProviderToken"));
  const result = await createPushSender({ apns: APNS, fetch: twice.fetch }).send(IOS, {
    body: "b",
  });
  assertEquals(twice.calls.length, 2);
  assertEquals(result, {
    ok: false,
    status: 403,
    reason: "InvalidProviderToken",
    error: "auth",
  });
});

Deno.test("apns: error mapping (invalid-token, rate-limited + Retry-After, payload, server)", async () => {
  const cases: Array<[number, string, string, Record<string, string>?]> = [
    [400, "BadDeviceToken", "invalid-token"],
    [410, "Unregistered", "invalid-token"],
    [400, "DeviceTokenNotForTopic", "invalid-token"],
    [429, "TooManyRequests", "rate-limited", { "retry-after": "30" }],
    [413, "PayloadTooLarge", "payload"],
    [400, "BadCollapseId", "payload"],
    [503, "ServiceUnavailable", "server"],
    [405, "MethodNotAllowed", "rejected"],
  ];
  for (const [status, reason, error, headers] of cases) {
    const { fetch } = fakeFetch(apnsFail(status, reason, headers));
    const result = await createPushSender({ apns: APNS, fetch }).send(IOS, { body: "b" });
    assertEquals(result.ok, false);
    if (result.ok) continue;
    assertEquals([result.status, result.reason, result.error], [status, reason, error]);
    if (headers) assertEquals(result.retryAfter, 30);
  }
  const network = await createPushSender({
    apns: APNS,
    fetch: () => Promise.reject(new TypeError("connection reset")),
  }).send(IOS, { body: "b" });
  assertEquals(network, { ok: false, status: 0, reason: "connection reset", error: "network" });
});

// ---- FCM --------------------------------------------------------------------------------------

function fcmFetch(...messageResponders: Array<(call: Call) => Response>) {
  let n = 0;
  return fakeFetch((call) => {
    if (call.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: `at-${++n}`, expires_in: 3600, token_type: "Bearer" });
    }
    const next = messageResponders.length > 1 ? messageResponders.shift()! : messageResponders[0];
    return next(call);
  });
}

const fcmOk = () => Response.json({ name: "projects/my-project/messages/1" });

Deno.test("fcm: RS256 service-account assertion exchanged for an access token", async () => {
  const { fetch, calls } = fcmFetch(fcmOk);
  const now = () => 1_800_000_000_000;
  const result = await createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch, now }).send(
    ANDROID,
    { title: "Hi" },
  );
  assertEquals(result, { ok: true, id: "projects/my-project/messages/1" });
  const exchange = calls[0];
  assertEquals(exchange.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(exchange.body);
  assertEquals(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const jwt = decodeJwt(form.get("assertion")!);
  assertEquals(jwt.header, { alg: "RS256", typ: "JWT" });
  assertEquals(jwt.claims, {
    iss: ACCOUNT.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
  assert(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      rsa.publicKey,
      jwt.sig,
      new TextEncoder().encode(jwt.input),
    ),
  );
  assertEquals(calls[1].url, "https://fcm.googleapis.com/v1/projects/my-project/messages:send");
  assertEquals(calls[1].headers.authorization, "Bearer at-1");
});

Deno.test("fcm: message shape, data stringified, background = data-only", async () => {
  const { fetch, calls } = fcmFetch(fcmOk);
  const push = createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch });
  await push.send(ANDROID, {
    title: "T",
    body: "B",
    subtitle: "ignored",
    data: { id: 42, flag: true, text: "s", obj: { a: 1 } },
    priority: "normal",
    ttl: 90,
    collapseId: "orders",
    channelId: "orders",
    sound: "default",
    badge: 2,
    category: "OPEN_ORDER",
  });
  await push.send(ANDROID, { contentAvailable: true, data: { sync: "1" } });
  assertEquals(JSON.parse(calls[1].body), {
    message: {
      token: "fcm-token",
      notification: { title: "T", body: "B" },
      data: { id: "42", flag: "true", text: "s", obj: '{"a":1}' },
      android: {
        priority: "NORMAL",
        ttl: "90s",
        collapse_key: "orders",
        notification: {
          channel_id: "orders",
          sound: "default",
          notification_count: 2,
          click_action: "OPEN_ORDER",
        },
      },
    },
  });
  assertEquals(JSON.parse(calls[2].body), {
    message: { token: "fcm-token", data: { sync: "1" }, android: { priority: "HIGH" } },
  });
});

Deno.test("fcm: the access token is cached until a minute before expiry", async () => {
  const { fetch, calls } = fcmFetch(fcmOk);
  let t = 1_800_000_000_000;
  const push = createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch, now: () => t });
  await push.send(ANDROID, { title: "1" });
  t += 58 * 60_000;
  await push.send(ANDROID, { title: "2" });
  t += 2 * 60_000;
  await push.send(ANDROID, { title: "3" });
  const exchanges = calls.filter((c) => c.url.includes("oauth2")).length;
  assertEquals(exchanges, 2);
  const auth = calls.filter((c) => c.url.includes("fcm.")).map((c) => c.headers.authorization);
  assertEquals(auth, ["Bearer at-1", "Bearer at-1", "Bearer at-2"]);
});

Deno.test("fcm: a 401 refreshes the token and retries once", async () => {
  const { fetch, calls } = fcmFetch(
    () => Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 }),
    fcmOk,
  );
  const result = await createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch }).send(
    ANDROID,
    { title: "x" },
  );
  assertEquals(result.ok, true);
  assertEquals(calls.filter((c) => c.url.includes("oauth2")).length, 2);
});

Deno.test("fcm: error mapping", async () => {
  const err = (status: number, s: string, message = "", errorCode?: string) => () =>
    Response.json({
      error: {
        code: status,
        status: s,
        message,
        details: errorCode
          ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }]
          : [],
      },
    }, { status, headers: status === 429 ? { "retry-after": "12" } : {} });
  const cases: Array<[() => Response, PushErrorCode]> = [
    [err(404, "NOT_FOUND", "Requested entity was not found.", "UNREGISTERED"), "invalid-token"],
    [
      err(
        400,
        "INVALID_ARGUMENT",
        "The registration token is not a valid FCM registration token",
        "INVALID_ARGUMENT",
      ),
      "invalid-token",
    ],
    [
      err(400, "INVALID_ARGUMENT", "Invalid value at 'message.android.ttl'", "INVALID_ARGUMENT"),
      "payload",
    ],
    [err(403, "PERMISSION_DENIED", "", "SENDER_ID_MISMATCH"), "auth"],
    [err(429, "RESOURCE_EXHAUSTED", "", "QUOTA_EXCEEDED"), "rate-limited"],
    [err(503, "UNAVAILABLE", "", "UNAVAILABLE"), "server"],
  ];
  for (const [responder, error] of cases) {
    const { fetch } = fcmFetch(responder);
    const result = await createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch }).send(
      ANDROID,
      { title: "x" },
    );
    assertEquals(result.ok === false && result.error, error);
    if (error === "rate-limited") assertEquals(result.ok === false && result.retryAfter, 12);
  }
  const { fetch } = fakeFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  const denied = await createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch }).send(
    ANDROID,
    { title: "x" },
  );
  assertEquals(denied, { ok: false, status: 400, reason: "invalid_grant", error: "auth" });
});

Deno.test("fcm: Live Activities are refused for android targets", async () => {
  const { fetch, calls } = fcmFetch(fcmOk);
  const result = await createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch }).send(
    ANDROID,
    { liveActivity: { event: "update", contentState: {} } },
  );
  assertEquals(result.ok === false && result.error, "config");
  assertEquals(calls.length, 0);
});

// ---- config -----------------------------------------------------------------------------------

Deno.test("config: missing platform credentials, bad shapes and non-PKCS#8 keys", async () => {
  const { fetch } = fakeFetch(ok());
  const onlyApns = createPushSender({ apns: APNS, fetch });
  const android = await onlyApns.send(ANDROID, { title: "x" });
  assertEquals(android.ok === false && android.error, "config");
  const ios = await createPushSender({ fcm: { serviceAccount: ACCOUNT }, fetch }).send(IOS, {});
  assertEquals(ios.ok === false && ios.error, "config");
  const noToken = await onlyApns.send({ platform: "ios", token: "" }, {});
  assertEquals(noToken.ok === false && noToken.error, "invalid-token");

  assertThrows(
    () => createPushSender({ apns: { ...APNS, teamId: "" } } as PushSenderConfig),
    TypeError,
    "apns.teamId",
  );
  assertThrows(
    () => createPushSender({ fcm: { serviceAccount: { ...ACCOUNT, project_id: 1 } as Any } }),
    TypeError,
    "project_id",
  );
  await assertRejects(
    () =>
      sendPush(
        {
          apns: {
            ...APNS,
            p8: "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----",
          },
          fetch,
        },
        IOS,
        { body: "x" },
      ),
    TypeError,
    "PKCS#8",
  );
  await assertRejects(
    () => sendPush({ apns: { ...APNS, p8: "nope" }, fetch }, IOS, { body: "x" }),
    TypeError,
    "not a PEM",
  );
});
