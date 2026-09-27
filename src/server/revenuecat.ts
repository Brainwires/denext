/**
 * RevenueCat webhooks for a denext server: {@linkcode verifyRevenueCatWebhook} checks the
 * `Authorization` header RevenueCat sends (the value you set in the dashboard's webhook
 * integration) in constant time, and parses the body into a typed event. Purchases made through
 * `denext/mobile`'s purchases API reach your server this way, so entitlements can be granted and
 * revoked server-side (never trust the app's own report of a purchase).
 *
 * @module
 */

/** The event types RevenueCat sends (a newer one arrives as its own string). */
export type RevenueCatEventType =
  | "TEST"
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "CANCELLATION"
  | "UNCANCELLATION"
  | "NON_RENEWING_PURCHASE"
  | "SUBSCRIPTION_PAUSED"
  | "EXPIRATION"
  | "BILLING_ISSUE"
  | "PRODUCT_CHANGE"
  | "TRANSFER"
  | "SUBSCRIBER_ALIAS"
  | "SUBSCRIPTION_EXTENDED"
  | "TEMPORARY_ENTITLEMENT_GRANT"
  | "REFUND_REVERSED"
  | "INVOICE_ISSUANCE"
  | "VIRTUAL_CURRENCY_TRANSACTION"
  | "EXPERIMENT_ENROLLMENT"
  | (string & Record<never, never>);

/** One webhook event (the fields RevenueCat documents; others are kept on the object). */
export interface RevenueCatWebhookEvent {
  /** The event's unique id: deduplicate on it, RevenueCat retries until you answer 200. */
  readonly id: string;
  /** What happened. */
  readonly type: RevenueCatEventType;
  /** The app user id the event is for (the `appUserId` given to `configurePurchases`). */
  readonly app_user_id: string;
  /** The first app user id this customer had. */
  readonly original_app_user_id?: string;
  /** Every app user id aliased to this customer. */
  readonly aliases?: readonly string[];
  /** The product id. */
  readonly product_id?: string;
  /** The entitlements the product grants. */
  readonly entitlement_ids?: readonly string[] | null;
  /** `NORMAL`, `TRIAL`, `INTRO`, `PROMOTIONAL`, `PREPAID`. */
  readonly period_type?: string;
  /** When it was bought, in ms since the epoch. */
  readonly purchased_at_ms?: number;
  /** When it expires, in ms since the epoch (null for a non-expiring purchase). */
  readonly expiration_at_ms?: number | null;
  /** When the event happened, in ms since the epoch. */
  readonly event_timestamp_ms?: number;
  /** `PRODUCTION` or `SANDBOX`. */
  readonly environment?: "PRODUCTION" | "SANDBOX" | (string & Record<never, never>);
  /** `APP_STORE`, `PLAY_STORE`, `STRIPE`, … */
  readonly store?: string;
  /** The store's transaction id. */
  readonly transaction_id?: string;
  /** The store's original transaction id. */
  readonly original_transaction_id?: string;
  /** The price in USD. */
  readonly price?: number | null;
  /** The ISO 4217 currency of `price_in_purchased_currency`. */
  readonly currency?: string | null;
  /** Why a `CANCELLATION` / `EXPIRATION` happened. */
  readonly cancel_reason?: string;
  /** Anything else RevenueCat sent. */
  readonly [key: string]: unknown;
}

/** The whole webhook body. */
export interface RevenueCatWebhookBody {
  /** The webhook API version (`"1.0"`). */
  readonly api_version: string;
  /** The event. */
  readonly event: RevenueCatWebhookEvent;
}

/** Options for {@linkcode verifyRevenueCatWebhook}. */
export interface VerifyRevenueCatWebhookOptions {
  /**
   * The exact `Authorization` header value set in the RevenueCat dashboard's webhook
   * integration (for example `"Bearer <a long random secret>"`). Keep it in an env var.
   */
  readonly authorization: string;
  /** The largest body accepted, in bytes (default 1 MiB). */
  readonly maxBodyBytes?: number;
}

/** A refused webhook: `status` is the HTTP status to answer with. */
export class RevenueCatWebhookError extends Error {
  /** 401 for a missing or wrong `Authorization`, 400 for a malformed body, 413 for a large one. */
  readonly status: 400 | 401 | 413;

  /**
   * Build the error.
   *
   * @param status The HTTP status to answer with.
   * @param message What was wrong.
   */
  constructor(status: 400 | 401 | 413, message: string) {
    super(`verifyRevenueCatWebhook: ${message}`);
    this.name = "RevenueCatWebhookError";
    this.status = status;
  }
}

/** SHA-256 of `text`. */
async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Whether `a` equals `b`, in time independent of where they differ and of their lengths: both
 * are hashed first, and the digests compared without an early exit.
 */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** The body as text, refusing one over `max` bytes. */
async function readBody(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    throw new RevenueCatWebhookError(413, `body over ${max} bytes`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > max) throw new RevenueCatWebhookError(413, `body over ${max} bytes`);
  return new TextDecoder().decode(bytes);
}

/** The parsed body, checked for the fields every event has. */
function parseBody(text: string): RevenueCatWebhookBody {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RevenueCatWebhookError(400, "the body is not JSON");
  }
  const event = (body as { event?: unknown } | null)?.event as Record<string, unknown> | undefined;
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new RevenueCatWebhookError(400, "no event object in the body");
  }
  for (const key of ["id", "type", "app_user_id"]) {
    if (typeof event[key] !== "string" || event[key] === "") {
      throw new RevenueCatWebhookError(400, `event.${key} is missing`);
    }
  }
  const version = (body as { api_version?: unknown }).api_version;
  return {
    api_version: typeof version === "string" ? version : "1.0",
    event: event as unknown as RevenueCatWebhookEvent,
  };
}

/**
 * Verify a RevenueCat webhook request and parse its event.
 *
 * It compares the request's `Authorization` header with `options.authorization` in constant
 * time, then reads (at most `maxBodyBytes`) and parses the JSON body, checking that the event
 * has an `id`, a `type` and an `app_user_id`. It rejects with a {@linkcode RevenueCatWebhookError}
 * whose `status` is the answer to give (401, 400, 413).
 *
 * RevenueCat retries a delivery that does not get a 200 within 60 seconds: answer quickly,
 * deduplicate on `event.id`, and fetch the subscriber from RevenueCat's REST API when you need
 * the full current state rather than the event's snapshot.
 *
 * @param request The incoming webhook request.
 * @param options The expected `Authorization` value and the body limit.
 * @returns The parsed body (`api_version` and the typed `event`).
 * @example
 * ```ts
 * // app/api/revenuecat/route.ts
 * import { RevenueCatWebhookError, verifyRevenueCatWebhook } from "denext/server";
 *
 * export async function POST(request: Request): Promise<Response> {
 *   try {
 *     const { event } = await verifyRevenueCatWebhook(request, {
 *       authorization: Deno.env.get("REVENUECAT_WEBHOOK_AUTH")!,
 *     });
 *     if (event.type === "INITIAL_PURCHASE" || event.type === "RENEWAL") {
 *       await grant(event.app_user_id, event.entitlement_ids ?? [], event.expiration_at_ms);
 *     } else if (event.type === "EXPIRATION") {
 *       await revoke(event.app_user_id, event.entitlement_ids ?? []);
 *     }
 *     return new Response(null, { status: 200 });
 *   } catch (err) {
 *     if (err instanceof RevenueCatWebhookError) return new Response(null, { status: err.status });
 *     throw err;
 *   }
 * }
 * ```
 */
export async function verifyRevenueCatWebhook(
  request: Request,
  options: VerifyRevenueCatWebhookOptions,
): Promise<RevenueCatWebhookBody> {
  if (typeof options?.authorization !== "string" || options.authorization === "") {
    throw new TypeError(
      "verifyRevenueCatWebhook: options.authorization must be a non-empty string",
    );
  }
  const header = request.headers.get("authorization");
  if (header === null || !(await sameSecret(header, options.authorization))) {
    throw new RevenueCatWebhookError(401, "the Authorization header does not match");
  }
  return parseBody(await readBody(request, options.maxBodyBytes ?? 1024 * 1024));
}
