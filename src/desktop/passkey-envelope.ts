/**
 * The passkey result envelope of `@clerk/electron-passkeys` (what `Deno.desktop.passkeys`
 * returns and `@clerk/electron/passkeys` reads): `{ ok: true, credential }` or
 * `{ ok: false, error: { code, message } }`. Shared by the runtime's `passkeys` capability and the
 * page's Clerk bridge. Client-safe, nothing runs at import.
 *
 * @module
 */

/** The error codes an envelope may carry (`@clerk/electron`'s `NATIVE_ERROR_CODES`). */
const ERROR_CODES = ["cancelled", "invalid_rp", "not_supported", "timeout", "unknown"];

/** A passkey result envelope. */
export type PasskeyEnvelope =
  | { readonly ok: true; readonly credential: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Whether `value` is a passkey envelope (`@clerk/electron`'s `isPasskeyIpcResult`). */
export function isPasskeyEnvelope(value: unknown): value is PasskeyEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { ok?: unknown; credential?: unknown; error?: { code?: unknown } };
  if (typeof v.ok !== "boolean") return false;
  return v.ok ? v.credential !== undefined : ERROR_CODES.includes(v.error?.code as string);
}

/** A failure envelope. */
export function passkeyFailure(code: string, message: string): PasskeyEnvelope {
  return { ok: false, error: { code, message } };
}
