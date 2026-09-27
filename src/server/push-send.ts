/**
 * Send push notifications from a denext server with no npm dependency and no push service in
 * between: APNs (Apple) over HTTP/2 with a token-based (`.p8`) provider JWT, and Firebase Cloud
 * Messaging HTTP v1 with a service-account OAuth2 token. Both run on `fetch` and WebCrypto
 * (`crypto.subtle`), so the same code runs on Deno, Deno Deploy and any web-standard runtime.
 *
 * APNs accepts HTTP/2 only; Deno's `fetch` negotiates HTTP/2 over TLS (ALPN) on its own, so no
 * client library is needed. A runtime whose `fetch` speaks HTTP/1.1 only cannot reach APNs.
 *
 * - {@linkcode createPushSender}: one sender per credential set; it caches the APNs JWT (50
 *   minutes) and the FCM access token (until a minute before it expires).
 * - {@linkcode sendPush}: a one-shot convenience (no caching across calls).
 *
 * Every per-message failure is a {@linkcode PushResult} value, never a throw: an
 * `"invalid-token"` result means the device token is dead and should be pruned.
 *
 * @module
 */

/** Token-based APNs credentials (a `.p8` key from the Apple Developer portal). */
export interface ApnsConfig {
  /** The key's 10-character Key ID. */
  readonly keyId: string;
  /** Your 10-character Team ID. */
  readonly teamId: string;
  /** The `.p8` file's contents (a PKCS#8 `-----BEGIN PRIVATE KEY-----` PEM). */
  readonly p8: string;
  /** The app's bundle id (the `apns-topic`). */
  readonly topic: string;
  /**
   * `true` sends to `api.push.apple.com` (TestFlight / App Store builds); default `false` sends
   * to `api.sandbox.push.apple.com` (development builds, `aps-environment: development`).
   */
  readonly production?: boolean;
}

/** The fields of a Firebase service-account JSON key that FCM needs. */
export interface FcmServiceAccount {
  /** The service account's email (the JWT issuer). */
  readonly client_email: string;
  /** Its private key: a PKCS#8 PEM (`\n` escapes are accepted). */
  readonly private_key: string;
  /** The Firebase project id. */
  readonly project_id: string;
  /** The OAuth2 token endpoint. Default `https://oauth2.googleapis.com/token`. */
  readonly token_uri?: string;
}

/** FCM HTTP v1 credentials. */
export interface FcmConfig {
  /** The parsed service-account JSON (Firebase console → Project settings → Service accounts). */
  readonly serviceAccount: FcmServiceAccount;
}

/** Options for {@linkcode createPushSender}. */
export interface PushSenderConfig {
  /** APNs credentials; `ios` targets fail with `"config"` without them. */
  readonly apns?: ApnsConfig;
  /** FCM credentials; `android` targets fail with `"config"` without them. */
  readonly fcm?: FcmConfig;
  /** The `fetch` to use (tests inject one). Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** The clock, in ms since the epoch (tests inject one). Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Where a push goes: an `ios` device token (the hex APNs token `registerForPush` returns on
 * iOS) is sent through APNs, an `android` one (an FCM registration token) through FCM.
 */
export interface PushTarget {
  /** The platform the token came from. */
  readonly platform: "ios" | "android";
  /** The device token. */
  readonly token: string;
}

/** A Live Activity update (iOS 16.1+, APNs only). */
export interface LiveActivityPush {
  /** `start` (push-to-start, iOS 17.2+), `update` or `end`. */
  readonly event: "start" | "update" | "end";
  /** The activity's new `ContentState`, as JSON. */
  readonly contentState: Record<string, unknown>;
  /** When this state was produced, in ms since the epoch. Default: now. */
  readonly timestamp?: number;
  /** `end`: when the ended activity leaves the Lock Screen, in ms since the epoch. */
  readonly dismissalDate?: number;
  /** When the state is outdated, in ms since the epoch. */
  readonly staleDate?: number;
  /** `start`: the activity's `ActivityAttributes` type name (required for `start`). */
  readonly attributesType?: string;
  /** `start`: the static attributes (required for `start`). */
  readonly attributes?: Record<string, unknown>;
  /** An alert that lights the screen with the update. */
  readonly alert?: { readonly title?: string; readonly body?: string; readonly sound?: string };
}

/** What to send. Every field is optional; unsupported ones are ignored per platform. */
export interface PushPayload {
  /** The alert title. */
  readonly title?: string;
  /** The alert subtitle (iOS only). */
  readonly subtitle?: string;
  /** The alert body. */
  readonly body?: string;
  /**
   * Custom data. APNs: top-level keys beside `aps` (any JSON; the key `aps` is refused). FCM:
   * the `data` map, whose values must be strings, so a non-string value is sent as its JSON.
   */
  readonly data?: Record<string, unknown>;
  /** The app icon badge count (Android: `notification_count`, launcher-dependent). */
  readonly badge?: number;
  /** A sound name (`"default"` for the system sound). */
  readonly sound?: string;
  /** The notification category (iOS action buttons; Android `click_action`). */
  readonly category?: string;
  /** iOS `thread-id` grouping. */
  readonly threadId?: string;
  /**
   * Wake the app in the background (`content-available: 1`). With no title, body, badge or
   * sound it is a background push (`apns-push-type: background`, priority 5).
   */
  readonly contentAvailable?: boolean;
  /** Let a Notification Service Extension modify it (`mutable-content: 1`, iOS). */
  readonly mutableContent?: boolean;
  /**
   * Replace an earlier notification with the same id (`apns-collapse-id`, at most 64 bytes;
   * FCM `collapse_key`).
   */
  readonly collapseId?: string;
  /** `"high"` (default; APNs priority 10, FCM HIGH) or `"normal"` (5 / NORMAL). */
  readonly priority?: "high" | "normal";
  /** Seconds to keep retrying an offline device (0: deliver now or never). Default: the service's. */
  readonly ttl?: number;
  /** The Android notification channel (Android 8+). */
  readonly channelId?: string;
  /** A Live Activity update instead of a notification (iOS only). */
  readonly liveActivity?: LiveActivityPush;
}

/**
 * Why a push failed:
 * - `invalid-token`: the token is dead (uninstalled app, wrong topic): prune it;
 * - `auth`: the credentials were refused (after one retry with a fresh token);
 * - `rate-limited`: slow down (see `retryAfter`);
 * - `payload`: the message is malformed or too large;
 * - `server`: the push service failed (5xx); retry later;
 * - `network`: `fetch` itself failed;
 * - `config`: no credentials for the target's platform, or an option that platform lacks;
 * - `rejected`: any other refusal (see `reason`).
 */
export type PushErrorCode =
  | "invalid-token"
  | "auth"
  | "rate-limited"
  | "payload"
  | "server"
  | "network"
  | "config"
  | "rejected";

/** The outcome of one send. */
export type PushResult =
  /** Accepted; `id` is the `apns-id` or the FCM message name. */
  | { readonly ok: true; readonly id?: string }
  /**
   * Refused. `status` is the HTTP status (0 when nothing was sent), `reason` the service's
   * reason string (`BadDeviceToken`, `UNREGISTERED`, …) or a description, `retryAfter` the
   * `Retry-After` header in seconds when there was one.
   */
  | {
    readonly ok: false;
    readonly status: number;
    readonly reason: string;
    readonly error: PushErrorCode;
    readonly retryAfter?: number;
  };

/** A configured sender (see {@linkcode createPushSender}). */
export interface PushSender {
  /**
   * Send one push.
   *
   * @param target The platform and device token.
   * @param payload What to send.
   * @returns The result; it never rejects for a delivery failure.
   */
  send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

type Failure = Extract<PushResult, { ok: false }>;

/** APNs caps a (non-VoIP) payload at 4 KB. */
const APNS_MAX_PAYLOAD = 4096;
/** Apple refuses a provider token older than an hour; refresh well before. */
const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const APNS_INVALID_TOKEN = [
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
];
const APNS_AUTH_RETRY = ["InvalidProviderToken", "ExpiredProviderToken"];

function fail(status: number, error: PushErrorCode, reason: string, retryAfter?: number): Failure {
  return retryAfter === undefined
    ? { ok: false, status, reason, error }
    : { ok: false, status, reason, error, retryAfter };
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** The DER bytes of a PKCS#8 PEM; a TypeError naming `what` for anything else. */
function pkcs8Der(pem: string, what: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/\\n/g, "\n").trim();
  if (/-----BEGIN (EC|RSA) PRIVATE KEY-----/.test(text)) {
    throw new TypeError(
      `${what}: expected a PKCS#8 key (-----BEGIN PRIVATE KEY-----), got a SEC1/PKCS#1 one; ` +
        "convert it with `openssl pkcs8 -topk8 -nocrypt`",
    );
  }
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(text);
  if (!match) throw new TypeError(`${what}: not a PEM private key (-----BEGIN PRIVATE KEY-----)`);
  try {
    const bin = atob(match[1].replace(/\s+/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new TypeError(`${what}: the PEM body is not valid base64`);
  }
}

async function importKey(
  pem: string,
  what: string,
  algorithm: EcKeyImportParams | RsaHashedImportParams,
): Promise<CryptoKey> {
  const der = pkcs8Der(pem, what);
  try {
    return await crypto.subtle.importKey("pkcs8", der, algorithm, false, ["sign"]);
  } catch (err) {
    throw new TypeError(
      `${what}: the key could not be imported (${err instanceof Error ? err.message : err})`,
    );
  }
}

/** A compact JWS over `header`.`claims`, signed with `key`. */
async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  algorithm: EcdsaParams | AlgorithmIdentifier,
): Promise<string> {
  const input = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  // WebCrypto's ECDSA signature is already the raw r‖s JOSE expects.
  const sig = await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

/** `Retry-After` in seconds, when it is a number or an HTTP date. */
function retryAfterOf(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && value.trim() !== "") return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function requireString(value: unknown, name: string): void {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`createPushSender: ${name} must be a non-empty string`);
  }
}

function checkConfig(config: PushSenderConfig): void {
  if (typeof config !== "object" || config === null) {
    throw new TypeError("createPushSender: pass { apns?, fcm? }");
  }
  if (config.apns !== undefined) {
    for (const key of ["keyId", "teamId", "p8", "topic"] as const) {
      requireString(config.apns[key], `apns.${key}`);
    }
  }
  if (config.fcm !== undefined) {
    const account = config.fcm.serviceAccount;
    if (typeof account !== "object" || account === null) {
      throw new TypeError("createPushSender: fcm.serviceAccount must be the service-account JSON");
    }
    for (const key of ["client_email", "private_key", "project_id"] as const) {
      requireString(account[key], `fcm.serviceAccount.${key}`);
    }
  }
}

// ---- APNs -------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function secondsOf(ms: number): number {
  return Math.floor(ms / 1000);
}

/** The `aps` dictionary for a Live Activity push, or a failure. */
function liveActivityAps(live: LiveActivityPush, now: number): Json | Failure {
  if (live.event === "start" && (!live.attributesType || !live.attributes)) {
    return fail(0, "payload", "a Live Activity start needs attributesType and attributes");
  }
  const aps: Json = {
    timestamp: secondsOf(live.timestamp ?? now),
    event: live.event,
    "content-state": live.contentState,
  };
  if (live.dismissalDate !== undefined) aps["dismissal-date"] = secondsOf(live.dismissalDate);
  if (live.staleDate !== undefined) aps["stale-date"] = secondsOf(live.staleDate);
  if (live.attributesType !== undefined) aps["attributes-type"] = live.attributesType;
  if (live.attributes !== undefined) aps.attributes = live.attributes;
  if (live.alert) {
    const { sound, ...alert } = live.alert;
    aps.alert = alert;
    if (sound !== undefined) aps.sound = sound;
  }
  return aps;
}

/** The `aps` dictionary for a notification. */
function notificationAps(payload: PushPayload): Json {
  const aps: Json = {};
  const alert: Json = {};
  if (payload.title !== undefined) alert.title = payload.title;
  if (payload.subtitle !== undefined) alert.subtitle = payload.subtitle;
  if (payload.body !== undefined) alert.body = payload.body;
  if (Object.keys(alert).length > 0) aps.alert = alert;
  if (payload.badge !== undefined) aps.badge = payload.badge;
  if (payload.sound !== undefined) aps.sound = payload.sound;
  if (payload.category !== undefined) aps.category = payload.category;
  if (payload.threadId !== undefined) aps["thread-id"] = payload.threadId;
  if (payload.contentAvailable) aps["content-available"] = 1;
  if (payload.mutableContent) aps["mutable-content"] = 1;
  return aps;
}

/** Whether a payload only wakes the app (nothing the user sees). */
function isBackground(payload: PushPayload): boolean {
  return payload.contentAvailable === true && payload.title === undefined &&
    payload.subtitle === undefined && payload.body === undefined &&
    payload.badge === undefined && payload.sound === undefined;
}

interface ApnsRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** `entries` without its `undefined` values. */
function defined<T>(entries: Record<string, T | undefined>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, v]) => v !== undefined),
  ) as Record<string, T>;
}

/** The APNs headers (minus authorization) for a payload. */
function apnsHeaders(topic: string, payload: PushPayload, now: number): Record<string, string> {
  const live = payload.liveActivity !== undefined;
  const background = !live && isBackground(payload);
  const ttl = payload.ttl;
  return defined({
    "apns-topic": live ? `${topic}.push-type.liveactivity` : topic,
    "apns-push-type": live ? "liveactivity" : background ? "background" : "alert",
    "apns-priority": background || payload.priority === "normal" ? "5" : "10",
    "content-type": "application/json",
    "apns-expiration": ttl === undefined
      ? undefined
      : ttl <= 0
      ? "0"
      : String(secondsOf(now) + Math.floor(ttl)),
    "apns-collapse-id": payload.collapseId,
  });
}

/** The APNs request body and headers (minus authorization), or a failure. */
function apnsRequest(
  topic: string,
  payload: PushPayload,
  now: number,
): ApnsRequest | Failure {
  if (payload.data && Object.hasOwn(payload.data, "aps")) {
    return fail(0, "payload", 'data must not use the key "aps" (APNs reserves it)');
  }
  const live = payload.liveActivity;
  const aps = live ? liveActivityAps(live, now) : notificationAps(payload);
  if ("ok" in aps) return aps as Failure;
  const body = JSON.stringify({ ...payload.data, aps });
  const size = new TextEncoder().encode(body).byteLength;
  if (size > APNS_MAX_PAYLOAD) {
    return fail(
      0,
      "payload",
      `the APNs payload is ${size} bytes; the limit is ${APNS_MAX_PAYLOAD}`,
    );
  }
  return { body, headers: apnsHeaders(topic, payload, now) };
}

/** Map an APNs refusal onto a {@linkcode PushErrorCode}. */
function apnsError(status: number, reason: string): PushErrorCode {
  if (status === 410 || APNS_INVALID_TOKEN.includes(reason)) return "invalid-token";
  if (status === 403) return "auth";
  if (status === 429) return "rate-limited";
  if (status === 413 || status === 400) return "payload";
  if (status >= 500) return "server";
  return "rejected";
}

function apnsSender(config: ApnsConfig, doFetch: typeof fetch, now: () => number) {
  const host = config.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  let key: Promise<CryptoKey> | undefined;
  let cached: { jwt: string; issuedAt: number } | undefined;

  async function providerToken(): Promise<string> {
    const at = now();
    if (cached && at - cached.issuedAt < APNS_TOKEN_TTL_MS) return cached.jwt;
    key ??= importKey(config.p8, "apns.p8", { name: "ECDSA", namedCurve: "P-256" });
    const jwt = await signJwt(
      { alg: "ES256", kid: config.keyId },
      { iss: config.teamId, iat: secondsOf(at) },
      await key,
      { name: "ECDSA", hash: "SHA-256" },
    );
    cached = { jwt, issuedAt: at };
    return jwt;
  }

  async function post(token: string, request: ApnsRequest): Promise<Response | Failure> {
    try {
      return await doFetch(`https://${host}/3/device/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { ...request.headers, authorization: `bearer ${await providerToken()}` },
        body: request.body,
      });
    } catch (err) {
      if (err instanceof TypeError && /apns\.p8/.test(err.message)) throw err;
      return fail(0, "network", err instanceof Error ? err.message : String(err));
    }
  }

  return async (token: string, payload: PushPayload): Promise<PushResult> => {
    const request = apnsRequest(config.topic, payload, now());
    if ("ok" in request) return request;
    for (let attempt = 0;; attempt++) {
      const response = await post(token, request);
      if (!(response instanceof Response)) return response;
      if (response.ok) {
        await response.body?.cancel();
        const id = response.headers.get("apns-id");
        return id === null ? { ok: true } : { ok: true, id };
      }
      const reason = String((await jsonOf(response)).reason ?? `HTTP ${response.status}`);
      // A refused provider token: sign a fresh one and try once more.
      if (response.status === 403 && APNS_AUTH_RETRY.includes(reason) && attempt === 0) {
        cached = undefined;
        continue;
      }
      return fail(
        response.status,
        apnsError(response.status, reason),
        reason,
        retryAfterOf(response, now()),
      );
    }
  };
}

// ---- FCM --------------------------------------------------------------------------------------

/** FCM `data` values must be strings: a non-string value is sent as its JSON. */
function fcmData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  }
  return out;
}

/** The FCM v1 `message` for an Android token, or a failure. */
function fcmMessage(token: string, payload: PushPayload): Json | Failure {
  if (payload.liveActivity) {
    return fail(0, "config", "Live Activities are iOS-only (send them to an ios target)");
  }
  const background = isBackground(payload);
  const shown = defined<unknown>({ title: payload.title, body: payload.body });
  const notification = defined<unknown>({
    channel_id: payload.channelId,
    sound: payload.sound,
    notification_count: payload.badge,
    click_action: payload.category,
  });
  const visible = (n: Record<string, unknown>) =>
    !background && Object.keys(n).length > 0 ? n : undefined;
  const android = defined<unknown>({
    priority: payload.priority === "normal" ? "NORMAL" : "HIGH",
    ttl: payload.ttl === undefined ? undefined : `${Math.max(0, Math.floor(payload.ttl))}s`,
    collapse_key: payload.collapseId,
    notification: visible(notification),
  });
  return defined<unknown>({
    token,
    notification: visible(shown),
    data: payload.data ? fcmData(payload.data) : undefined,
    android,
  }) as Json;
}

/** The FCM error code of a v1 error body (`details[].errorCode`, else `error.status`). */
function fcmReason(body: Json): { reason: string; message: string } {
  const error = (body.error ?? {}) as Json;
  const details = Array.isArray(error.details) ? error.details as Json[] : [];
  const code = details.map((d) => d.errorCode).find((c) => typeof c === "string");
  return {
    reason: String(code ?? error.status ?? "UNKNOWN"),
    message: String(error.message ?? ""),
  };
}

/** Map an FCM refusal onto a {@linkcode PushErrorCode}. */
function fcmError(status: number, reason: string, message: string): PushErrorCode {
  if (reason === "UNREGISTERED" || status === 404) return "invalid-token";
  if (reason === "INVALID_ARGUMENT" && /registration token|\btoken\b/i.test(message)) {
    return "invalid-token";
  }
  if (status === 401 || status === 403 || reason === "SENDER_ID_MISMATCH") return "auth";
  if (status === 429 || reason === "QUOTA_EXCEEDED") return "rate-limited";
  if (status === 400) return "payload";
  if (status >= 500) return "server";
  return "rejected";
}

function fcmSender(config: FcmConfig, doFetch: typeof fetch, now: () => number) {
  const account = config.serviceAccount;
  const tokenUri = account.token_uri ?? GOOGLE_TOKEN_URI;
  const endpoint = `https://fcm.googleapis.com/v1/projects/${
    encodeURIComponent(account.project_id)
  }/messages:send`;
  let key: Promise<CryptoKey> | undefined;
  let cached: { token: string; expiresAt: number } | undefined;

  /** A current access token, or a failure from the token exchange. */
  async function accessToken(): Promise<string | Failure> {
    const at = now();
    if (cached && at < cached.expiresAt - 60_000) return cached.token;
    key ??= importKey(account.private_key, "fcm.serviceAccount.private_key", {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    });
    const iat = secondsOf(at);
    const assertion = await signJwt(
      { alg: "RS256", typ: "JWT" },
      { iss: account.client_email, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 },
      await key,
      { name: "RSASSA-PKCS1-v1_5" },
    );
    let response: Response;
    try {
      response = await doFetch(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
    } catch (err) {
      return fail(0, "network", err instanceof Error ? err.message : String(err));
    }
    const body = await jsonOf(response);
    if (!response.ok || typeof body.access_token !== "string") {
      const reason = String(body.error_description ?? body.error ?? `HTTP ${response.status}`);
      return fail(response.status, response.status >= 500 ? "server" : "auth", reason);
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    cached = { token: body.access_token, expiresAt: at + expiresIn * 1000 };
    return cached.token;
  }

  /** POST one message body with a current access token. */
  async function send(body: string): Promise<Response | Failure> {
    const access = await accessToken();
    if (typeof access !== "string") return access;
    try {
      return await doFetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body,
      });
    } catch (err) {
      return fail(0, "network", err instanceof Error ? err.message : String(err));
    }
  }

  return async (token: string, payload: PushPayload): Promise<PushResult> => {
    const message = fcmMessage(token, payload);
    if ("ok" in message) return message as Failure;
    const body = JSON.stringify({ message });
    for (let attempt = 0;; attempt++) {
      const response = await send(body);
      if (!(response instanceof Response)) return response;
      const json = await jsonOf(response);
      if (response.ok) {
        return typeof json.name === "string" ? { ok: true, id: json.name } : { ok: true };
      }
      if (response.status === 401 && attempt === 0) {
        cached = undefined;
        continue;
      }
      const { reason, message: text } = fcmReason(json);
      return fail(
        response.status,
        fcmError(response.status, reason, text),
        text ? `${reason}: ${text}` : reason,
        retryAfterOf(response, now()),
      );
    }
  };
}

// ---- Public API -------------------------------------------------------------------------------

/**
 * Create a push sender for your APNs and/or FCM credentials. Keep one per process: it caches
 * the APNs provider JWT for 50 minutes (Apple refuses one older than an hour, and throttles
 * refreshing it more often than every 20 minutes) and the FCM access token until a minute
 * before it expires. A refused provider token (`ExpiredProviderToken` /
 * `InvalidProviderToken`, FCM 401) is re-signed and the send retried once.
 *
 * `ios` targets go to APNs, `android` targets to FCM HTTP v1. Delivery failures are results
 * (see {@linkcode PushErrorCode}); prune the token on `"invalid-token"`. A malformed config
 * throws a `TypeError` here, and a key that is not a PKCS#8 PEM rejects the first send with one.
 *
 * @param config APNs and/or FCM credentials, plus optional `fetch` / `now` for tests.
 * @returns A {@linkcode PushSender}.
 * @throws TypeError when a credential field is missing or not a string.
 * @example
 * ```ts
 * import { createPushSender } from "denext/server";
 *
 * const push = createPushSender({
 *   apns: {
 *     keyId: Deno.env.get("APNS_KEY_ID")!,
 *     teamId: Deno.env.get("APNS_TEAM_ID")!,
 *     p8: Deno.env.get("APNS_P8")!,
 *     topic: "com.example.app",
 *     production: true,
 *   },
 *   fcm: { serviceAccount: JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT")!) },
 * });
 * const result = await push.send({ platform: "ios", token }, { title: "Shipped", body: "Order #42" });
 * if (!result.ok && result.error === "invalid-token") await db.devices.delete(token);
 * ```
 */
export function createPushSender(config: PushSenderConfig): PushSender {
  checkConfig(config);
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  const now = config.now ?? Date.now;
  const apns = config.apns ? apnsSender(config.apns, doFetch, now) : undefined;
  const fcm = config.fcm ? fcmSender(config.fcm, doFetch, now) : undefined;
  return {
    send(target, payload) {
      if (typeof target?.token !== "string" || target.token === "") {
        return Promise.resolve(fail(0, "invalid-token", "the target has no token"));
      }
      if (target.platform === "ios") {
        return apns
          ? apns(target.token, payload)
          : Promise.resolve(fail(0, "config", "no apns credentials for an ios target"));
      }
      if (target.platform === "android") {
        return fcm
          ? fcm(target.token, payload)
          : Promise.resolve(fail(0, "config", "no fcm credentials for an android target"));
      }
      return Promise.resolve(fail(0, "config", `unknown platform ${String(target?.platform)}`));
    },
  };
}

/**
 * Send one push with a throwaway {@linkcode createPushSender}: convenient for a script, but it
 * signs a new token every call, so a server should keep a sender instead.
 *
 * @param config APNs and/or FCM credentials.
 * @param target The platform and device token.
 * @param payload What to send.
 * @returns The result; it never rejects for a delivery failure.
 * @example
 * ```ts
 * import { sendPush } from "denext/server";
 *
 * await sendPush({ fcm: { serviceAccount } }, { platform: "android", token }, {
 *   title: "Your order shipped",
 *   channelId: "orders",
 *   data: { orderId: "42" },
 * });
 * ```
 */
export function sendPush(
  config: PushSenderConfig,
  target: PushTarget,
  payload: PushPayload,
): Promise<PushResult> {
  return createPushSender(config).send(target, payload);
}
