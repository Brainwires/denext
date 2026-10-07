// Passkeys end to end through the auth routes, driven by a software authenticator (an ES256 key
// in this test, its attestation and assertions encoded by hand): register from a fresh session,
// sign in usernameless, complete a pending second factor, list and delete — and the refusals:
// a stale session, a replayed response (single-use challenge), a response from another browser
// (cookie binding), a wrong origin / RP ID, a counter that went backwards, another user's
// credential at a step-up, a user handle that isn't the owner, a duplicate credential ID, the
// config-time checks, and both adapters' passkey group.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { confirmTotp, enrollTotp } from "../src/server/auth/mfa.ts";
import { deletePasskey, listPasskeys } from "../src/server/auth/passkeys.ts";
import { readAuthSession } from "../src/server/auth/session.ts";
import type { AuthAdapter, PasskeyRecord } from "../src/server/auth/adapter.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import { decodeBase32 } from "@std/encoding/base32";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery staple";

// ---- a tiny CBOR encoder (the test's own, independent of the decoder under test) ----------

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function cbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const put = (v: Cbor): void => {
    if (typeof v === "number") out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    else if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v);
    else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(put);
    } else {
      out.push(...head(5, v.size));
      for (const [k, item] of v) {
        put(k);
        put(item);
      }
    }
  };
  put(value);
  return Uint8Array.from(out);
}

// ---- a software authenticator ------------------------------------------------------------

const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), at += p.length);
  return out;
};

/** Raw r‖s → DER (what an authenticator emits for ES256, WebAuthn §6.5.5). */
function toDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    const body = v[0] & 0x80 ? concat(Uint8Array.of(0), v) : v;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const seq = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, seq.length), seq);
}

/** An ES256 authenticator holding one credential. */
class Authenticator {
  counter = 0;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  constructor(
    private readonly keys: CryptoKeyPair,
    private readonly cose: Uint8Array,
    /** UV + BE flags it reports. */
    public flags = 0x05,
  ) {}

  static async create(): Promise<Authenticator> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const cose = cbor(
      new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64u(jwk.x!)], [
        -3,
        fromB64u(jwk.y!),
      ]]),
    );
    return new Authenticator(keys, cose);
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  async authData(rpId: string, attested: boolean): Promise<Uint8Array> {
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.counter);
    const flags = Uint8Array.of(this.flags | (attested ? 0x40 : 0));
    const base = concat(await sha256(new TextEncoder().encode(rpId)), flags, counter);
    if (!attested) return base;
    const len = Uint8Array.of(0, this.credentialId.length);
    return concat(base, new Uint8Array(16), len, this.credentialId, this.cose);
  }

  clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  /** A `RegistrationResponseJSON` for `options` (the server's creation options). */
  async register(
    options: { challenge: string; rp: { id: string } },
    over: { origin?: string; rpId?: string } = {},
  ) {
    const clientDataJSON = this.clientData(
      "webauthn.create",
      options.challenge,
      over.origin ?? ORIGIN,
    );
    const authData = await this.authData(over.rpId ?? options.rp.id, true);
    const attestationObject = cbor(
      new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** An `AuthenticationResponseJSON` for `options`, as this authenticator signs it. */
  async assert(
    options: { challenge: string; rpId: string },
    over: { origin?: string; userHandle?: string; counter?: number } = {},
  ) {
    if (over.counter === undefined) this.counter++;
    else this.counter = over.counter;
    const clientDataJSON = this.clientData(
      "webauthn.get",
      options.challenge,
      over.origin ?? ORIGIN,
    );
    const authenticatorData = await this.authData(options.rpId, false);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.keys.privateKey,
        concat(authenticatorData, await sha256(clientDataJSON)) as BufferSource,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(toDer(raw)),
        ...(over.userHandle ? { userHandle: over.userHandle } : {}),
      },
    };
  }
}

// ---- the app ------------------------------------------------------------------------------

interface App {
  config: AuthConfig;
  adapter: AuthAdapter;
  userId: string;
  failures: string[];
}

async function app(
  passkeys: AuthConfig["passkeys"] = true,
  adapter: AuthAdapter = inMemoryAuthAdapter(),
): Promise<App> {
  const user = await adapter.createUser({ email: EMAIL, name: "Ada" });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const failures: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    passkeys,
    mfa: { window: 2 },
    events: { signInFailed: ({ reason }) => void failures.push(reason) },
  };
  return { config, adapter, userId: user.id, failures };
}

/** The same app (adapter, user, event log) under a changed config — options resolve per config. */
function withConfig(a: App, patch: Partial<AuthConfig>): App {
  return { ...a, config: { ...a.config, ...patch } };
}

/** A browser: a cookie jar it sends with every request and updates from every answer. */
class Browser {
  private jar = new Map<string, string>();
  constructor(private readonly a: App) {}

  get cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async send(method: string, path: string, body?: unknown, origin = ORIGIN): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", origin };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.jar.size) headers.cookie = this.cookie;
    const request = new Request(`${ORIGIN}/auth${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ctx = createRequestContext(request);
    const res = await runWithContext(ctx, () => handleAuthRequest(request, this.a.config));
    this.absorb(ctx);
    assert(res, `${method} ${path} was claimed`);
    return res;
  }

  private absorb(ctx: RequestContext): void {
    for (const line of ctx.outgoingHeaders.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim())) ||
        attrs.some((a) => /^\s*max-age=0$/i.test(a));
      if (expired || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async session(): Promise<AuthSession | null> {
    const request = new Request(`${ORIGIN}/`, {
      headers: this.jar.size ? { cookie: this.cookie } : {},
    });
    return await runWithContext(
      createRequestContext(request),
      () => readAuthSession(this.a.config),
    );
  }

  async passwordSignIn(): Promise<Response> {
    return await this.send("POST", "/callback/credentials", { email: EMAIL, password: PASSWORD });
  }
}

/** Register `auth` from a freshly signed-in browser; returns that browser. */
async function registered(a: App, auth: Authenticator): Promise<Browser> {
  const b = new Browser(a);
  assertEquals((await b.passwordSignIn()).status, 200);
  const options = await (await b.send("POST", "/passkey/register/options", {})).json();
  const res = await b.send("POST", "/passkey/register", {
    credential: await auth.register(options),
    name: "Laptop",
  });
  assertEquals(res.status, 200, await res.clone().text());
  return b;
}

/** A fresh browser's usernameless sign-in options. */
async function signInOptions(b: Browser) {
  const res = await b.send("POST", "/passkey/authenticate/options", {});
  assertEquals(res.status, 200);
  return await res.json();
}

// ---- registration ---------------------------------------------------------------------------

Deno.test("passkeys: register from a fresh session — options, verification, storage", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  const b = new Browser(a);
  await b.passwordSignIn();
  const options = await (await b.send("POST", "/passkey/register/options", {})).json();
  assertEquals(options.rp, { id: "app.test", name: "app.test" });
  assertEquals(options.user.name, EMAIL);
  assertEquals(new TextDecoder().decode(fromB64u(options.user.id)), a.userId);
  assertEquals(options.pubKeyCredParams.map((p: { alg: number }) => p.alg), [-8, -7, -257]);
  assertEquals(options.authenticatorSelection.userVerification, "required");
  assertEquals(options.authenticatorSelection.residentKey, "required");
  assertEquals(options.excludeCredentials, []);
  assertEquals(fromB64u(options.challenge).length, 32);
  const res = await b.send("POST", "/passkey/register", {
    credential: await auth.register(options),
    name: "  Laptop  ",
  });
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.passkey.id, auth.id);
  assertEquals(body.passkey.name, "Laptop");
  const stored = (await a.adapter.getPasskey!(auth.id))!;
  assertEquals(stored.userId, a.userId);
  assertEquals(stored.alg, -7);
  assertEquals(stored.transports, ["internal"]);
  assertEquals((await listPasskeys(a.config, a.userId)).map((p) => p.id), [auth.id]);
  // Registering again excludes the credential the user already has.
  const again = await (await b.send("POST", "/passkey/register/options", {})).json();
  assertEquals(again.excludeCredentials.map((d: { id: string }) => d.id), [auth.id]);
});

Deno.test("passkeys: registration needs a complete, recent, same-origin session", async () => {
  const a = await app();
  const anonymous = new Browser(a);
  assertEquals((await anonymous.send("POST", "/passkey/register/options", {})).status, 401);
  const b = new Browser(a);
  await b.passwordSignIn();
  assertEquals(
    (await b.send("POST", "/passkey/register/options", {}, "https://evil.test")).status,
    403,
  );
  // A session whose sign-in is older than mfa.freshness (here 0 → the 5-minute floor) is stale.
  const stale = withConfig(await app(), { mfa: { freshness: 0 } });
  const sb = new Browser(stale);
  await sb.passwordSignIn();
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try {
    const res = await sb.send("POST", "/passkey/register/options", {});
    assertEquals(res.status, 403);
    assertEquals((await res.json()).error, "reauth_required");
  } finally {
    Date.now = realNow;
  }
});

Deno.test("passkeys: a registration's challenge is single-use and bound to its browser", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  const b = new Browser(a);
  await b.passwordSignIn();
  const options = await (await b.send("POST", "/passkey/register/options", {})).json();
  const credential = await auth.register(options);
  assertEquals((await b.send("POST", "/passkey/register", { credential })).status, 200);
  // Replayed: the challenge was consumed.
  const replay = await b.send("POST", "/passkey/register", { credential });
  assertEquals(replay.status, 400);
  assertEquals((await replay.json()).code, "challenge");
});

Deno.test("passkeys: a registration for another origin or RP ID is refused", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  const b = new Browser(a);
  await b.passwordSignIn();
  for (const over of [{ origin: "https://evil.test" }, { rpId: "evil.test" }]) {
    const options = await (await b.send("POST", "/passkey/register/options", {})).json();
    const res = await b.send("POST", "/passkey/register", {
      credential: await auth.register(options, over),
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).code, over.origin ? "origin" : "rp_id");
  }
  assertEquals(await a.adapter.getPasskey!(auth.id), undefined);
});

Deno.test("passkeys: one credential ID can't be registered twice (§7.1 step 25)", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  const b = await registered(a, auth);
  const options = await (await b.send("POST", "/passkey/register/options", {})).json();
  const res = await b.send("POST", "/passkey/register", {
    credential: await auth.register(options),
  });
  assertEquals(res.status, 409);
});

// ---- sign-in ---------------------------------------------------------------------------------

Deno.test("passkeys: usernameless sign-in with UV issues a complete, multi-factor session", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  await registered(a, auth);
  const b = new Browser(a);
  const options = await signInOptions(b);
  assertEquals(options.rpId, "app.test");
  assertEquals(options.allowCredentials, []);
  assertEquals(options.userVerification, "required");
  const res = await b.send("POST", "/passkey/authenticate", {
    credential: await auth.assert(options, {
      userHandle: b64u(new TextEncoder().encode(a.userId)),
    }),
    callbackUrl: "https://evil.test/steal",
  });
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.user.id, a.userId);
  assertEquals(body.url, "/", "callbackUrl is coerced same-origin");
  const session = (await b.session())!;
  assertEquals(session.provider, "passkey");
  assertEquals(session.amr, ["hwk", "mfa"]);
  assertEquals(session.mfaPending, undefined);
  assertEquals((await a.adapter.getPasskey!(auth.id))!.signCount, 1);
  assert((await a.adapter.getPasskey!(auth.id))!.lastUsedAt);
});

Deno.test("passkeys: a UV passkey satisfies MFA; a presence-only one leaves the TOTP step-up", async () => {
  for (
    const [policy, flags, pending] of [["required", 0x05, false], [
      "preferred",
      0x01,
      true,
    ]] as const
  ) {
    const a = await app({ userVerification: policy });
    const auth = await Authenticator.create();
    auth.flags = flags;
    await registered(a, auth);
    // Enroll TOTP for the user.
    const now = Math.floor(Date.now() / 1000);
    const enrolment = await enrollTotp(a.config, {
      user: { id: a.userId, email: EMAIL },
      provider: "credentials",
      expiresAt: now + 3600,
      authTime: now,
    });
    assert(enrolment.ok);
    const confirmed = await confirmTotp(a.config, {
      user: { id: a.userId },
      code: await totpAt(enrolment.secret),
    });
    assert(confirmed.ok);
    const b = new Browser(a);
    const res = await b.send("POST", "/passkey/authenticate", {
      credential: await auth.assert(await signInOptions(b)),
    });
    const body = await res.json();
    assertEquals(body.mfa === "required", pending, `${policy}: ${JSON.stringify(body)}`);
    assertEquals((await b.session())!.mfaPending === true, pending);
  }
});

Deno.test("passkeys: a replayed assertion is refused — the challenge is single-use", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  await registered(a, auth);
  const b = new Browser(a);
  const options = await signInOptions(b);
  const credential = await auth.assert(options);
  assertEquals((await b.send("POST", "/passkey/authenticate", { credential })).status, 200);
  const replay = await b.send("POST", "/passkey/authenticate", { credential });
  assertEquals(replay.status, 401);
  assertEquals(await replay.json(), { error: "invalid passkey" });
  assertEquals(a.failures, ["invalid_passkey"]);
});

Deno.test("passkeys: an assertion is accepted only from the browser that asked for it", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  await registered(a, auth);
  const victim = new Browser(a);
  const options = await signInOptions(victim);
  // The response is relayed to another browser (no ceremony cookie): refused, and the challenge
  // is spent, so the victim can't be raced with it either.
  const attacker = new Browser(a);
  const relayed = await attacker.send("POST", "/passkey/authenticate", {
    credential: await auth.assert(options),
  });
  assertEquals(relayed.status, 401);
  assertEquals(await attacker.session(), null);
});

Deno.test("passkeys: wrong origin, cross-origin POST, unknown credential and bad signature are refused", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  await registered(a, auth);
  const b = new Browser(a);
  const wrongOrigin = await b.send("POST", "/passkey/authenticate", {
    credential: await auth.assert(await signInOptions(b), { origin: "https://evil.test" }),
  });
  assertEquals(wrongOrigin.status, 401);
  assertEquals(
    (await b.send("POST", "/passkey/authenticate", {}, "https://evil.test")).status,
    403,
  );
  const stranger = await Authenticator.create();
  assertEquals(
    (await b.send("POST", "/passkey/authenticate", {
      credential: await stranger.assert(await signInOptions(b)),
    })).status,
    401,
  );
  const forged = await auth.assert(await signInOptions(b));
  const sig = fromB64u(forged.response.signature);
  sig[sig.length - 1] ^= 1;
  forged.response.signature = b64u(sig);
  assertEquals((await b.send("POST", "/passkey/authenticate", { credential: forged })).status, 401);
  assertEquals(await b.session(), null);
});

Deno.test("passkeys: a counter that went backwards (a cloned authenticator) is refused", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  await registered(a, auth);
  const b = new Browser(a);
  await b.send("POST", "/passkey/authenticate", {
    credential: await auth.assert(await signInOptions(b), { counter: 10 }),
  });
  const clone = await b.send("POST", "/passkey/authenticate", {
    credential: await auth.assert(await signInOptions(b), { counter: 7 }),
  });
  assertEquals(clone.status, 401);
  assertEquals((await a.adapter.getPasskey!(auth.id))!.signCount, 10, "the counter didn't move");
});

Deno.test("passkeys: a user handle that isn't the credential's owner is refused", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  await registered(a, auth);
  const b = new Browser(a);
  const res = await b.send("POST", "/passkey/authenticate", {
    credential: await auth.assert(await signInOptions(b), {
      userHandle: b64u(new TextEncoder().encode("someone-else")),
    }),
  });
  assertEquals(res.status, 401);
});

// ---- the second factor ------------------------------------------------------------------------

/** The current TOTP code for `secret` (RFC 6238), computed independently. */
async function totpAt(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(decodeBase32(secret)),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(Date.now() / 30_000) - 1));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const at = mac[mac.length - 1] & 15;
  const bin = ((mac[at] & 0x7f) << 24 | mac[at + 1] << 16 | mac[at + 2] << 8 | mac[at + 3]) >>> 0;
  return String(bin % 1_000_000).padStart(6, "0");
}

Deno.test("passkeys: a pending session's step-up offers the user's passkeys and completes with one", async () => {
  const base = await app();
  const auth = await Authenticator.create();
  await registered(base, auth); // registered from a complete session
  const a = withConfig(base, { mfa: { required: "always" } });
  const b = new Browser(a);
  const pending = await (await b.passwordSignIn()).json();
  assertEquals(pending, { ok: true, mfa: "required" });
  const options = await signInOptions(b);
  assertEquals(options.allowCredentials.map((d: { id: string }) => d.id), [auth.id]);
  const res = await b.send("POST", "/passkey/authenticate", {
    credential: await auth.assert(options),
  });
  assertEquals(res.status, 200);
  const session = (await b.session())!;
  assertEquals(session.mfaPending, undefined);
  assertEquals(session.amr, ["pwd", "hwk", "mfa"]);
});

Deno.test("passkeys: a step-up refuses another user's passkey", async () => {
  const a = await app();
  const theirs = await Authenticator.create();
  // A second user registers a passkey.
  const other = await a.adapter.createUser({ email: "eve@example.com" });
  await a.adapter.setCredential!(other.id, await hashPassword(PASSWORD));
  const eve = new Browser(a);
  await eve.send("POST", "/callback/credentials", { email: "eve@example.com", password: PASSWORD });
  const regOptions = await (await eve.send("POST", "/passkey/register/options", {})).json();
  await eve.send("POST", "/passkey/register", { credential: await theirs.register(regOptions) });
  // Ada owes a second factor; Eve's passkey can't pay it.
  const always = withConfig(a, { mfa: { required: "always" } });
  const ada = new Browser(always);
  await ada.passwordSignIn();
  const res = await ada.send("POST", "/passkey/authenticate", {
    credential: await theirs.assert(await signInOptions(ada)),
  });
  assertEquals(res.status, 401);
  assertEquals((await ada.session())!.mfaPending, true);
  assertEquals(a.failures, ["invalid_mfa_code"]);
});

// ---- management --------------------------------------------------------------------------------

Deno.test("passkeys: list and delete — the owner only, from a recent session", async () => {
  const a = await app();
  const auth = await Authenticator.create();
  const b = await registered(a, auth);
  const list = await (await b.send("GET", "/passkeys")).json();
  assertEquals(list.passkeys.map((p: { id: string }) => p.id), [auth.id]);
  assert(!("publicKey" in list.passkeys[0]), "no key material");
  assertEquals((await new Browser(a).send("GET", "/passkeys")).status, 401);
  assertEquals((await b.send("DELETE", `/passkeys/${encodeURIComponent("nope")}`)).status, 404);
  assertEquals((await b.send("DELETE", `/passkeys/${auth.id}`)).status, 200);
  assertEquals(await a.adapter.getPasskey!(auth.id), undefined);
  assertEquals(await deletePasskey(a.config, { userId: a.userId, id: auth.id }), false);
});

Deno.test("passkeys: without `passkeys` the endpoints don't exist", async () => {
  const a = withConfig(await app(), { passkeys: undefined });
  const request = new Request(`${ORIGIN}/auth/passkey/authenticate/options`, {
    method: "POST",
    headers: { origin: ORIGIN },
  });
  assertEquals(
    await runWithContext(createRequestContext(request), () => handleAuthRequest(request, a.config)),
    null,
  );
});

// ---- configuration ------------------------------------------------------------------------------

Deno.test("passkeys: config-time checks — RP ID source, origins, adapter group", () => {
  const base = { secret: SECRET, providers: [{ id: "c", type: "credentials" as const }] };
  // No canonicalOrigin and no rpId: never derive the RP from the Host header.
  assertThrows(
    () => denextAuth({ ...base, adapter: inMemoryAuthAdapter(), passkeys: true }),
    Error,
    "canonicalOrigin",
  );
  // An origin outside the RP ID, or plain http off localhost.
  assertThrows(
    () =>
      denextAuth({
        ...base,
        canonicalOrigin: ORIGIN,
        adapter: inMemoryAuthAdapter(),
        passkeys: { origins: ["https://app.test", "https://evil.test"] },
      }),
    Error,
    "origins",
  );
  assertThrows(
    () =>
      denextAuth({
        ...base,
        canonicalOrigin: ORIGIN,
        adapter: inMemoryAuthAdapter(),
        passkeys: { origins: ["http://app.test"] },
      }),
    Error,
    "origins",
  );
  // A registrable-suffix RP ID covers a subdomain origin.
  denextAuth({
    ...base,
    canonicalOrigin: "https://login.example.com",
    adapter: inMemoryAuthAdapter(),
    passkeys: { rpId: "example.com" },
  });
  // An adapter without the passkey group.
  const { createPasskey: _c, ...lacking } = inMemoryAuthAdapter();
  assertThrows(
    () =>
      denextAuth({
        ...base,
        canonicalOrigin: ORIGIN,
        adapter: lacking as AuthAdapter,
        passkeys: true,
      }),
    Error,
    "passkey group",
  );
});

// ---- the adapter group, both adapters --------------------------------------------------------------

for (
  const [name, make] of [
    ["inMemoryAuthAdapter", () => inMemoryAuthAdapter()],
    ["sqliteAuthAdapter", () => sqliteAuthAdapter({ path: ":memory:" })],
  ] as const
) {
  Deno.test(`passkeys adapter contract: ${name}`, async () => {
    const adapter: AuthAdapter = make();
    const user = await adapter.createUser({ email: "x@example.com" });
    const record: PasskeyRecord = {
      id: "cred-1",
      userId: user.id,
      publicKey: "pk",
      alg: -7,
      signCount: 0,
      backupEligible: true,
      backedUp: false,
      transports: ["internal", "hybrid"],
      createdAt: 100,
    };
    assertEquals(await adapter.createPasskey!(record), true);
    assertEquals(await adapter.createPasskey!({ ...record, userId: "someone-else" }), false);
    assertEquals(await adapter.getPasskey!("cred-1"), record);
    assertEquals((await adapter.listPasskeys!(user.id)).length, 1);
    // Compare-and-swap on the counter.
    const update = { signCount: 3, backedUp: true, lastUsedAt: 200 };
    assertEquals(await adapter.updatePasskey!("cred-1", 1, update), false, "stale counter");
    assertEquals(await adapter.updatePasskey!("cred-1", 0, update), true);
    assertEquals(await adapter.updatePasskey!("cred-1", 0, update), false, "already advanced");
    assertEquals((await adapter.getPasskey!("cred-1"))!.signCount, 3);
    // Challenges: consumed exactly once; an expired one never resolves.
    const now = Math.floor(Date.now() / 1000);
    await adapter.createPasskeyChallenge!({ hash: "h1", expiresAt: now + 60, data: "{}" });
    const [first, second] = await Promise.all([
      adapter.usePasskeyChallenge!("h1"),
      adapter.usePasskeyChallenge!("h1"),
    ]);
    assertEquals([!!first, !!second].filter(Boolean).length, 1);
    await adapter.createPasskeyChallenge!({ hash: "h2", expiresAt: now - 1, data: "{}" });
    assertEquals(await adapter.usePasskeyChallenge!("h2"), undefined);
    assertEquals(await adapter.usePasskeyChallenge!("h2"), undefined, "consumed even when expired");
    // Deleting the user deletes their passkeys.
    await adapter.deleteUser!(user.id);
    assertEquals(await adapter.getPasskey!("cred-1"), undefined);
    await adapter.close?.();
  });
}
