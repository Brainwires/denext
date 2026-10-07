/**
 * The browser half of denext's passkeys (`denextAuth({ passkeys })`): register a passkey for
 * the signed-in user, and sign in — or finish a pending second factor — with one. Each call is
 * one WebAuthn ceremony: fetch the options from `{basePath}/passkey/*`, run
 * `navigator.credentials.create()` / `.get()`, and post the result back for the server to
 * verify. Uses the platform's `PublicKeyCredential.parse*OptionsFromJSON` and `toJSON()` where
 * the browser has them, and an equivalent base64url conversion where it doesn't.
 *
 * @module
 */

/** The endpoint prefix denext auth mounts on unless the app configured `basePath`. */
const DEFAULT_BASE_PATH = "/auth";

/** Why a passkey call failed. */
export type PasskeyClientError =
  | "unsupported"
  | "cancelled"
  | "invalid"
  | "unauthorized"
  | "reauth_required"
  | "exists"
  | "rate_limited"
  | "network";

/** Options shared by every passkey call. */
export interface PasskeyCallOptions {
  /** The auth endpoint prefix, when the app configured `denextAuth({ basePath })`. Default `"/auth"`. */
  basePath?: string;
}

/** What {@linkcode registerPasskey} resolves to. */
export type RegisterPasskeyResult =
  | { ok: true; passkey: { id: string; name?: string; createdAt: number; backedUp: boolean } }
  | { ok: false; error: PasskeyClientError };

/** What {@linkcode signInWithPasskey} resolves to. */
export type PasskeySignInResult =
  | { ok: true; mfa?: "required" }
  | { ok: false; error: PasskeyClientError };

/** Options for {@linkcode signInWithPasskey}. */
export interface PasskeySignInOptions extends PasskeyCallOptions {
  /** Where to go after signing in — kept same-origin by the server. Default `pages.afterSignIn`. */
  callbackUrl?: string;
  /** Navigate on success (default `true`); `false` resolves and leaves navigation to you. */
  redirect?: boolean;
}

/**
 * Whether this browser can run a WebAuthn ceremony at all.
 *
 * @returns `true` when `PublicKeyCredential` and `navigator.credentials` exist.
 */
export function passkeysSupported(): boolean {
  return typeof globalThis.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" && !!navigator.credentials;
}

/**
 * base64url → ArrayBuffer. Written inline rather than imported from `@std/encoding`: that
 * module builds its lookup tables at load time, a side effect the bundler can't drop, so it
 * would land in every app's shared chunk whether or not passkeys are used.
 */
function fromB64u(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  ).buffer;
}

/** ArrayBuffer (or a view) → unpadded base64url. */
function toB64u(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A credential descriptor list with its ids decoded. */
// deno-lint-ignore no-explicit-any
function descriptors(list: any[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((d) => ({ ...d, id: fromB64u(d.id) }));
}

/** The platform's JSON parsers, where the browser has them (WebAuthn L3 §5.1.9–10). */
interface PublicKeyCredentialStatics {
  parseCreationOptionsFromJSON?(json: unknown): PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?(json: unknown): PublicKeyCredentialRequestOptions;
}

/** Creation options from the server's JSON. */
// deno-lint-ignore no-explicit-any
function creationOptions(json: any): PublicKeyCredentialCreationOptions {
  const statics = globalThis.PublicKeyCredential as unknown as PublicKeyCredentialStatics;
  if (statics.parseCreationOptionsFromJSON) return statics.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: fromB64u(json.challenge),
    user: { ...json.user, id: fromB64u(json.user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
  };
}

/** Request options from the server's JSON. */
// deno-lint-ignore no-explicit-any
function requestOptions(json: any): PublicKeyCredentialRequestOptions {
  const statics = globalThis.PublicKeyCredential as unknown as PublicKeyCredentialStatics;
  if (statics.parseRequestOptionsFromJSON) return statics.parseRequestOptionsFromJSON(json);
  return {
    ...json,
    challenge: fromB64u(json.challenge),
    allowCredentials: descriptors(json.allowCredentials),
  };
}

/** A credential as the JSON the server verifies (`toJSON()`, or the same fields by hand). */
function credentialJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const native = (credential as unknown as { toJSON?: () => Record<string, unknown> }).toJSON;
  if (typeof native === "function") return native.call(credential);
  const r = credential.response as
    & AuthenticatorAttestationResponse
    & AuthenticatorAssertionResponse;
  const response: Record<string, unknown> = { clientDataJSON: toB64u(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = toB64u(r.attestationObject);
    response.transports = r.getTransports?.() ?? [];
  } else {
    response.authenticatorData = toB64u(r.authenticatorData);
    response.signature = toB64u(r.signature);
    if (r.userHandle) response.userHandle = toB64u(r.userHandle);
  }
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    type: credential.type,
    response,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

/** POST JSON to an auth endpoint; `null` on a network failure. */
async function post(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-denext-auth": "1",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

/** The client error a refused answer maps to. */
async function errorOf(res: Response | null): Promise<PasskeyClientError> {
  if (!res) return "network";
  if (res.status === 429) return "rate_limited";
  if (res.status === 409) return "exists";
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (body.error === "reauth_required") return "reauth_required";
  return res.status === 401 && body.error === "unauthorized" ? "unauthorized" : "invalid";
}

/** The ceremony options from `{base}/<path>`, or the typed refusal. */
async function ceremonyOptions(
  base: string,
  path: string,
): Promise<{ json: unknown } | { ok: false; error: PasskeyClientError }> {
  if (!passkeysSupported()) return { ok: false, error: "unsupported" };
  const res = await post(`${base}${path}`, {});
  if (!res?.ok) return { ok: false, error: await errorOf(res) };
  return { json: await res.json() };
}

/** Run a WebAuthn ceremony, mapping the user's cancel (or a timeout) to `"cancelled"`. */
async function ceremony<T>(run: () => Promise<T | null>): Promise<T | "cancelled"> {
  try {
    return (await run()) ?? "cancelled";
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
    throw error;
  }
}

/**
 * Register a passkey for the signed-in user: `{basePath}/passkey/register/options`, the
 * browser's create ceremony, then `{basePath}/passkey/register`. The server requires a recent
 * sign-in (`"reauth_required"` otherwise).
 *
 * @param options A label for the passkey, and the auth base path.
 * @returns `{ ok: true, passkey }`, or `{ ok: false, error }`.
 */
export async function registerPasskey(
  options: PasskeyCallOptions & { name?: string } = {},
): Promise<RegisterPasskeyResult> {
  const base = options.basePath ?? DEFAULT_BASE_PATH;
  const fetched = await ceremonyOptions(base, "/passkey/register/options");
  if (!("json" in fetched)) return fetched;
  const publicKey = creationOptions(fetched.json);
  const created = await ceremony(() =>
    navigator.credentials.create({ publicKey }) as Promise<PublicKeyCredential | null>
  );
  if (created === "cancelled") return { ok: false, error: "cancelled" };
  const res = await post(`${base}/passkey/register`, {
    credential: credentialJSON(created),
    name: options.name,
  });
  if (!res?.ok) return { ok: false, error: await errorOf(res) };
  return { ok: true, passkey: (await res.json()).passkey };
}

/**
 * Sign in with a passkey — or, while the session owes a second factor, complete it with one:
 * `{basePath}/passkey/authenticate/options`, the browser's get ceremony (the authenticator
 * offers its passkeys for this site), then `{basePath}/passkey/authenticate`. On success it
 * navigates to `callbackUrl` unless `redirect: false`.
 *
 * @param options Where to land, whether to navigate, and the auth base path.
 * @returns `{ ok: true }` (with `mfa: "required"` when a second factor is still owed), or
 * `{ ok: false, error }`.
 */
export async function signInWithPasskey(
  options: PasskeySignInOptions = {},
): Promise<PasskeySignInResult> {
  const base = options.basePath ?? DEFAULT_BASE_PATH;
  const fetched = await ceremonyOptions(base, "/passkey/authenticate/options");
  if (!("json" in fetched)) return fetched;
  const publicKey = requestOptions(fetched.json);
  const asserted = await ceremony(() =>
    navigator.credentials.get({ publicKey }) as Promise<PublicKeyCredential | null>
  );
  if (asserted === "cancelled") return { ok: false, error: "cancelled" };
  const res = await post(`${base}/passkey/authenticate`, {
    credential: credentialJSON(asserted),
    callbackUrl: options.callbackUrl,
  });
  if (!res?.ok) return { ok: false, error: await errorOf(res) };
  const body = await res.json() as { mfa?: "required"; url?: string };
  if (body.mfa === "required") return { ok: true, mfa: "required" };
  // `url` is the server's same-origin coercion of `callbackUrl`.
  if (options.redirect !== false) globalThis.location?.assign(body.url ?? "/");
  return { ok: true };
}
