// Passkeys from a native Android app: `passkeys.androidApps` turns each signing-certificate
// fingerprint into the exact `android:apk-key-hash:` origin Credential Manager puts in the client
// data, and the cookie-less `/native/passkey/*` rows run the ceremonies for an app (sign-in →
// native token pair, registration under a bearer from a recent sign-in). Covered: the
// fingerprint → origin conversion (a published vector), the spellings it refuses, the config-time
// checks, the origins accepted and refused at the endpoints, the ceremony binding between the
// cookie and native rows, the presence-only step-up, and the gates (no Origin needed, a foreign
// one refused, no feature → 404).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { confirmTotp, enrollTotp } from "../src/server/auth/mfa.ts";
import { apkKeyHashOrigin, resolvePasskeys } from "../src/server/auth/passkeys.ts";
import {
  resolveNative,
  snapshotFor,
  startNativeSession,
  verifyNativeAccessToken,
} from "../src/server/auth/native.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { AuthConfig, AuthPasskeyConfig } from "../src/server/auth/types.ts";
import { decodeBase32 } from "@std/encoding/base32";
import { Authenticator, b64u } from "./helpers/soft-authenticator.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "ada@example.com";
const REDIRECT = "com.example.app://auth/callback";
/** Google's documented example: this fingerprint is that origin. */
const FINGERPRINT =
  "B1:85:02:F2:9E:48:F5:2C:6A:15:EA:E7:04:F1:E6:0F:1C:FF:61:56:57:99:52:5D:5B:CB:3E:9B:74:53:4E:A1";
const APP_ORIGIN = "android:apk-key-hash:sYUC8p5I9SxqFernBPHmDxz_YVZXmVJdW8s-m3RTTqE";
const ANDROID = { packageName: "com.example.app", sha256CertFingerprints: [FINGERPRINT] };

// ---- the fingerprint → origin conversion --------------------------------------------------

Deno.test("apkKeyHashOrigin: the colon and plain hex spellings give the documented origin", () => {
  assertEquals(apkKeyHashOrigin(FINGERPRINT), APP_ORIGIN);
  assertEquals(apkKeyHashOrigin(FINGERPRINT.toLowerCase()), APP_ORIGIN);
  assertEquals(apkKeyHashOrigin(FINGERPRINT.replaceAll(":", "")), APP_ORIGIN);
  assertEquals(apkKeyHashOrigin(` ${FINGERPRINT} `), APP_ORIGIN, "surrounding space trimmed");
  // An independent encoding of 32 known bytes.
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(":");
  assertEquals(apkKeyHashOrigin(hex), `android:apk-key-hash:${b64u(bytes)}`);
});

Deno.test("apkKeyHashOrigin: refuses every other spelling", () => {
  const pairs = FINGERPRINT.split(":");
  for (
    const bad of [
      "",
      pairs.slice(0, 31).join(":"), // 31 bytes
      [...pairs, "AB"].join(":"), // 33 bytes
      FINGERPRINT.replace(":", ""), // a colon missing
      FINGERPRINT.replace(":", "::"), // a doubled colon
      FINGERPRINT.replace(":", "-"), // another separator
      FINGERPRINT.replaceAll(":", " "),
      `SHA256: ${FINGERPRINT}`, // keytool's label kept
      FINGERPRINT.replace("B1", "G1"), // not hex
      FINGERPRINT.replaceAll(":", "").slice(1), // 63 digits
      `${FINGERPRINT}:`,
      APP_ORIGIN, // already an origin
    ]
  ) {
    assertThrows(() => apkKeyHashOrigin(bad), Error, "SHA-256", JSON.stringify(bad));
  }
});

// ---- config ---------------------------------------------------------------------------------

function config(passkeys: AuthPasskeyConfig, adapter: AuthAdapter = inMemoryAuthAdapter()) {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [{ id: "credentials", type: "credentials" as const }],
    adapter,
    passkeys,
  } satisfies AuthConfig;
}

Deno.test("passkeys.androidApps: each fingerprint adds its exact origin beside the RP origin", () => {
  const second = "00".repeat(32);
  const rp = resolvePasskeys(config({
    androidApps: [ANDROID, { packageName: "com.example.debug", sha256CertFingerprints: [second] }],
  }))!;
  assertEquals(rp.origins, [
    ORIGIN,
    APP_ORIGIN,
    `android:apk-key-hash:${b64u(new Uint8Array(32))}`,
  ]);
  // Listed in `origins` as well: no duplicate.
  const both = resolvePasskeys(config({ origins: [ORIGIN, APP_ORIGIN], androidApps: [ANDROID] }))!;
  assertEquals(both.origins, [ORIGIN, APP_ORIGIN]);
});

Deno.test("passkeys.androidApps / origins: malformed Android entries fail at config time", () => {
  const throwsWith = (passkeys: AuthPasskeyConfig, text: string) =>
    assertThrows(() => denextAuth(config(passkeys)), Error, text, JSON.stringify(passkeys));
  throwsWith({ androidApps: [{ ...ANDROID, packageName: "app" }] }, "packageName");
  throwsWith({ androidApps: [{ ...ANDROID, packageName: "" }] }, "packageName");
  throwsWith({ androidApps: [{ ...ANDROID, sha256CertFingerprints: [] }] }, "at least one");
  throwsWith({ androidApps: [{ ...ANDROID, sha256CertFingerprints: ["AB:CD"] }] }, "SHA-256");
  throwsWith({ androidApps: {} as unknown as [] }, "androidApps");
  const hash = APP_ORIGIN.slice("android:apk-key-hash:".length);
  for (
    const bad of [
      "android:apk-key-hash:", // the prefix alone
      `${APP_ORIGIN}=`, // padded
      `${APP_ORIGIN}x`, // 44 characters
      APP_ORIGIN.slice(0, -1), // 42 characters
      `android:apk-key-hash:${hash.slice(0, -1)}F`, // not the canonical encoding of 32 bytes
      `android:apk-key-hash:${hash.replace("_", "/")}`, // base64, not base64url
      `Android:apk-key-hash:${hash}`, // another scheme spelling
      `android:apk-key-hash:${hash} `,
    ]
  ) {
    throwsWith({ origins: [ORIGIN, bad] }, "origins");
  }
  // The well-formed one is accepted in `origins`, as before.
  denextAuth(config({ origins: [ORIGIN, APP_ORIGIN] }));
});

// ---- the endpoints ---------------------------------------------------------------------------

interface App {
  config: AuthConfig;
  adapter: AuthAdapter;
  userId: string;
  failures: string[];
}

async function app(passkeys: AuthPasskeyConfig = { androidApps: [ANDROID] }): Promise<App> {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({
    email: EMAIL,
    name: "Ada",
    emailVerified: Math.floor(Date.now() / 1000),
  });
  const failures: string[] = [];
  return {
    config: {
      ...config(passkeys, adapter),
      native: { redirectUris: [REDIRECT] },
      mfa: { window: 2 },
      events: { signInFailed: ({ reason }) => void failures.push(reason) },
    },
    adapter,
    userId: user.id,
    failures,
  };
}

/** A native HTTP client's POST: no cookie, no Origin unless given. */
async function post(
  a: App,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request(`${ORIGIN}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, a.config),
  );
  assert(res, `POST ${path} was claimed`);
  return res;
}

/** A bearer for the user, from a sign-in `ageSeconds` ago. */
async function bearer(a: App, ageSeconds = 0, userId = a.userId): Promise<Record<string, string>> {
  const authTime = Math.floor(Date.now() / 1000) - ageSeconds;
  const snapshot = await snapshotFor(a.config, { id: userId }, "google", ["ext"], authTime);
  const tokens = await startNativeSession(a.config, resolveNative(a.config)!, snapshot);
  return { authorization: `Bearer ${tokens.access_token}` };
}

/** Register `auth` through the native rows, its client data naming `origin`. */
async function registerNative(a: App, auth: Authenticator, origin = APP_ORIGIN) {
  const headers = await bearer(a);
  const options = await (await post(a, "/native/passkey/register/options", {}, headers)).json();
  return await post(a, "/native/passkey/register", {
    credential: await auth.register(options, { origin }),
    ceremonyId: options.ceremonyId,
    name: "Pixel",
  }, headers);
}

/** A native sign-in with `auth`, its client data naming `origin`. */
async function signInNative(a: App, auth: Authenticator, origin = APP_ORIGIN) {
  const options = await (await post(a, "/native/passkey/authenticate/options", {})).json();
  return await post(a, "/native/passkey/authenticate", {
    credential: await auth.assert(options, { origin }),
    ceremonyId: options.ceremonyId,
  });
}

Deno.test("native passkeys: register under a fresh bearer, then sign in to a token pair", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  const registered = await registerNative(a, auth);
  assertEquals(registered.status, 200, await registered.clone().text());
  assertEquals((await registered.json()).passkey.name, "Pixel");
  const res = await signInNative(a, auth);
  assertEquals(res.status, 200, await res.clone().text());
  const tokens = await res.json();
  assert(tokens.access_token.startsWith("nat_"));
  assert(tokens.refresh_token.startsWith("nrt_"));
  assertEquals(tokens.user.id, a.userId);
  assertEquals(res.headers.get("cache-control"), "no-store");
});

Deno.test("native passkeys: only the exact configured origins are accepted", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  assertEquals((await registerNative(a, auth)).status, 200);
  const hash = APP_ORIGIN.slice("android:apk-key-hash:".length);
  const other = apkKeyHashOrigin("11".repeat(32));
  for (
    const refused of [
      other, // another signing certificate
      `${APP_ORIGIN}=`,
      `${APP_ORIGIN}A`, // the configured hash as a prefix
      APP_ORIGIN.slice(0, -1), // a prefix of it
      hash, // no scheme
      `android:apk-key-hash:${hash.toLowerCase()}`,
      "android:apk-key-hash:",
      "https://evil.test",
    ]
  ) {
    const res = await signInNative(a, auth, refused);
    assertEquals(res.status, 401, refused);
    assertEquals(await res.json(), { error: "invalid passkey" });
  }
  // The RP's own origin (an iOS app's associated domain) is accepted, as on the web.
  assertEquals((await signInNative(a, auth, ORIGIN)).status, 200);
  assertEquals((await signInNative(a, auth, APP_ORIGIN)).status, 200);
  // A registration naming an unlisted app is refused too.
  const second = await Authenticator.create();
  assertEquals((await registerNative(a, second, other)).status, 400);
});

Deno.test("native passkeys: without androidApps the app's origin is refused", async () => {
  const a = await app({});
  const auth = await Authenticator.create();
  assertEquals((await registerNative(a, auth)).status, 400);
  assertEquals((await registerNative(a, auth, ORIGIN)).status, 200);
  assertEquals((await signInNative(a, auth)).status, 401);
});

Deno.test("native passkeys: a ceremony completes only on the rows that started it", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  assertEquals((await registerNative(a, auth)).status, 200);
  // Started natively, finished on the cookie row (same-origin): refused.
  const native = await (await post(a, "/native/passkey/authenticate/options", {})).json();
  const cookieRow = await post(a, "/passkey/authenticate", {
    credential: await auth.assert(native, { origin: APP_ORIGIN }),
    ceremonyId: native.ceremonyId,
  }, { origin: ORIGIN });
  assertEquals(cookieRow.status, 401);
  // Started on the cookie row, finished natively: refused.
  const web = await (await post(a, "/passkey/authenticate/options", {}, { origin: ORIGIN })).json();
  const nativeRow = await post(a, "/native/passkey/authenticate", {
    credential: await auth.assert(web, { origin: APP_ORIGIN }),
    ceremonyId: web.ceremonyId,
  });
  assertEquals(nativeRow.status, 401);
  // A replayed native assertion: the challenge is spent.
  const options = await (await post(a, "/native/passkey/authenticate/options", {})).json();
  const body = {
    credential: await auth.assert(options, { origin: APP_ORIGIN }),
    ceremonyId: options.ceremonyId,
  };
  assertEquals((await post(a, "/native/passkey/authenticate", body)).status, 200);
  assertEquals((await post(a, "/native/passkey/authenticate", body)).status, 401);
  // A missing ceremony id.
  const again = await (await post(a, "/native/passkey/authenticate/options", {})).json();
  const missing = await post(a, "/native/passkey/authenticate", {
    credential: await auth.assert(again, { origin: APP_ORIGIN }),
  });
  assertEquals(missing.status, 401);
  assert(a.failures.every((r) => r === "invalid_passkey"));
});

Deno.test("native passkeys: the cookie rows accept the app origin for a same-origin page", async () => {
  // A hosted-mode shell: the page is on this origin, the ceremony ran in Credential Manager.
  const a = await app();
  const auth = await Authenticator.create();
  assertEquals((await registerNative(a, auth)).status, 200);
  const web = await (await post(a, "/passkey/authenticate/options", {}, { origin: ORIGIN })).json();
  const res = await post(a, "/passkey/authenticate", {
    credential: await auth.assert(web, { origin: APP_ORIGIN }),
    ceremonyId: web.ceremonyId,
  }, { origin: ORIGIN });
  assertEquals(res.status, 200, await res.clone().text());
});

Deno.test("native passkeys: registration needs a live bearer from a recent sign-in", async () => {
  const a = await app();
  assertEquals((await post(a, "/native/passkey/register/options", {})).status, 401);
  const forged = { authorization: "Bearer nat_forged.token" };
  assertEquals((await post(a, "/native/passkey/register/options", {}, forged)).status, 401);
  const stale = await post(a, "/native/passkey/register/options", {}, await bearer(a, 3600));
  assertEquals(stale.status, 403);
  assertEquals(await stale.json(), { error: "reauth_required" });
  // An unverified address can't register (the pre-account-hijacking rule of the cookie rows).
  const bob = await a.adapter.createUser({ email: "bob@example.com" });
  const unverified = await post(
    a,
    "/native/passkey/register/options",
    {},
    await bearer(a, 0, bob.id),
  );
  assertEquals(unverified.status, 403);
  assertEquals(await unverified.json(), { error: "email_unverified" });
});

Deno.test("native passkeys: a registration ceremony belongs to the bearer's user", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  const headers = await bearer(a);
  const options = await (await post(a, "/native/passkey/register/options", {}, headers)).json();
  // Another user's bearer can't finish it.
  const other = await a.adapter.createUser({
    email: "eve@example.com",
    emailVerified: Math.floor(Date.now() / 1000),
  });
  const eve = await startNativeSession(
    a.config,
    resolveNative(a.config)!,
    await snapshotFor(a.config, { id: other.id }, "google", ["ext"]),
  );
  const res = await post(a, "/native/passkey/register", {
    credential: await auth.register(options, { origin: APP_ORIGIN }),
    ceremonyId: options.ceremonyId,
  }, { authorization: `Bearer ${eve.access_token}` });
  assertEquals(res.status, 400);
});

async function totpAt(secret: string, step = -1): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(decodeBase32(secret)),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(Date.now() / 30_000) + step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const at = mac[mac.length - 1] & 15;
  const bin = ((mac[at] & 0x7f) << 24 | mac[at + 1] << 16 | mac[at + 2] << 8 | mac[at + 3]) >>> 0;
  return String(bin % 1_000_000).padStart(6, "0");
}

Deno.test("native passkeys: a presence-only passkey leaves the code step-up at /native/mfa", async () => {
  for (
    const [policy, flags, pending] of [["required", 0x05, false], [
      "preferred",
      0x01,
      true,
    ]] as const
  ) {
    const a = await app({ androidApps: [ANDROID], userVerification: policy });
    const auth = await Authenticator.create();
    auth.flags = flags;
    assertEquals((await registerNative(a, auth)).status, 200);
    const now = Math.floor(Date.now() / 1000);
    const enrolment = await enrollTotp(a.config, {
      user: { id: a.userId, email: EMAIL },
      provider: "credentials",
      expiresAt: now + 3600,
      authTime: now,
    });
    assert(enrolment.ok);
    const code = await totpAt(enrolment.secret);
    assert((await confirmTotp(a.config, { user: { id: a.userId }, code })).ok);
    const res = await signInNative(a, auth);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.mfa_required === true, pending, `${policy}: ${JSON.stringify(body)}`);
    assertEquals(typeof body.access_token === "string", !pending);
    if (pending) {
      // The step-up's session records the passkey as the first factor.
      const done = await post(a, "/native/mfa", {
        mfa_token: body.mfa_token,
        code: await totpAt(enrolment.secret, 0), // the next step: the last one is spent
      });
      const finished = await done.json();
      assertEquals(done.status, 200, JSON.stringify(finished));
      const session = await verifyNativeAccessToken(a.config, finished.access_token);
      assertEquals(session?.amr, ["hwk", "totp"]);
    }
  }
});

Deno.test("native passkeys: the origin gate and the feature switches", async () => {
  const a = await app();
  // A browser page on a foreign origin can't call them.
  const foreign = await post(a, "/native/passkey/authenticate/options", {}, {
    origin: "https://evil.test",
  });
  assertEquals(foreign.status, 403);
  assertEquals(
    (await post(a, "/native/passkey/authenticate/options", {}, { origin: "null" })).status,
    403,
  );
  // This app's own origin may.
  assertEquals(
    (await post(a, "/native/passkey/authenticate/options", {}, { origin: ORIGIN })).status,
    200,
  );
  // Without `native` (or without `passkeys`) the rows don't exist.
  for (const patch of [{ native: undefined }, { passkeys: undefined }]) {
    const off = { ...a, config: { ...a.config, ...patch } };
    const request = new Request(`${ORIGIN}/auth/native/passkey/authenticate/options`, {
      method: "POST",
      body: "{}",
    });
    const res = await runWithContext(
      createRequestContext(request),
      () => handleAuthRequest(request, off.config),
    );
    assertEquals(res?.status ?? 404, 404);
  }
});
