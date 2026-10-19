"use client";
/**
 * `next-auth/webauthn` on denext: `signIn` for a WebAuthn provider (`next-auth/providers/passkey`
 * or `…/webauthn`), on denext's passkey client. `signIn("passkey")` signs in with a passkey the
 * authenticator offers for this site; `signIn("passkey", { action: "register" })` registers one
 * for the signed-in user (denext requires a recent sign-in for that). With no `action`, a
 * signed-in user registers and anyone else signs in, as Auth.js decides.
 *
 * ```tsx
 * "use client";
 * import { useSession } from "next-auth/react";
 * import { signIn } from "next-auth/webauthn";
 * export function PasskeyButton() {
 *   const { status } = useSession();
 *   return status === "authenticated"
 *     ? <button onClick={() => signIn("passkey", { action: "register" })}>Add a passkey</button>
 *     : <button onClick={() => signIn("passkey")}>Sign in with a passkey</button>;
 * }
 * ```
 *
 * @module
 */

import { registerPasskey, signInWithPasskey } from "../../client/passkeys.ts";
import { clientState, navigate, refreshProviders, sameOrigin } from "./client-state.ts";
import { getProviders, getSession, type SignInOptions, type SignInResponse } from "./react.ts";

export type { SignInOptions, SignInResponse } from "./react.ts";

/** The ceremony: the one asked for, else register when signed in and sign in otherwise. */
async function actionOf(options: SignInOptions): Promise<"register" | "authenticate"> {
  if (options.action === "register" || options.action === "authenticate") return options.action;
  return (await getSession()) ? "register" : "authenticate";
}

/** Whether `provider` names a WebAuthn provider; `undefined` after navigating to the error page. */
async function isWebAuthnProvider(provider: string | undefined): Promise<boolean | undefined> {
  const providers = await getProviders();
  if (!providers) {
    navigate(`${clientState.basePath}/error`);
    return undefined;
  }
  return !!provider && Object.hasOwn(providers, provider) &&
    providers[provider].type === "webauthn";
}

/** What a failed ceremony answers: logged (navigating calls), or Auth.js's error shape. */
function failure(
  action: string,
  error: string,
  redirect: boolean,
): SignInResponse | undefined {
  if (redirect) {
    console.error(`[next-auth] WebAuthn ${action} failed: ${error}`);
    return undefined;
  }
  const status = error === "unauthorized" || error === "reauth_required" ? 401 : 400;
  return { error: "WebAuthnVerificationError", code: error, status, ok: false, url: null };
}

/**
 * Sign in with — or register — a passkey through a WebAuthn provider. Navigates to
 * `callbackUrl` / `redirectTo` (this page by default) on success unless `redirect: false`, which
 * resolves with the result instead. A provider id that isn't a WebAuthn provider throws, as in
 * Auth.js (use `next-auth/react`'s `signIn` for it).
 *
 * @param provider The WebAuthn provider's id (`"passkey"`).
 * @param options `action` (`"authenticate"` or `"register"`), `callbackUrl` / `redirectTo`,
 *   `redirect`.
 * @param _authorizationParams Accepted for Auth.js compatibility (a passkey ceremony has none).
 * @returns The result with `redirect: false`; otherwise it navigates.
 * @throws {TypeError} When `provider` is not a WebAuthn provider.
 */
export async function signIn(
  provider?: string,
  options: SignInOptions = {},
  _authorizationParams?: Record<string, string> | string | URLSearchParams | string[][],
): Promise<SignInResponse | undefined> {
  const callbackUrl = sameOrigin(options.redirectTo ?? options.callbackUrl);
  const redirect = options.redirect !== false;
  const webAuthn = await isWebAuthnProvider(provider);
  if (webAuthn === undefined) return undefined;
  if (!webAuthn) {
    throw new TypeError(
      `Provider id "${provider}" does not refer to a WebAuthn provider.\n` +
        'Please use `import { signIn } from "next-auth/react"` instead.',
    );
  }
  const action = await actionOf(options);
  const basePath = clientState.basePath;
  const result = action === "register"
    ? await registerPasskey({ basePath })
    : await signInWithPasskey({ basePath, callbackUrl, redirect: false });
  if (!result.ok) return failure(action, result.error, redirect);
  await refreshProviders();
  if (!redirect) {
    return { error: undefined, code: undefined, status: 200, ok: true, url: callbackUrl };
  }
  navigate(callbackUrl);
  return undefined;
}
