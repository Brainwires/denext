/**
 * SSO users: one rule for every sign-in that does not go through an identity provider. An SSO
 * user (GoTrue's `is_sso_user`) is an account a SAML sign-in created — its stored
 * `app_metadata.provider` is the `sso:<provider>` it signed up through — so its identity
 * provider owns its credentials, MFA policy and deprovisioning. Every lookup of a NON-SSO
 * sign-in, recovery or one-time code by email or phone treats it as "no such user" (GoTrue's
 * `FindUserByEmailAndAudience` / `FindUserByPhoneAndAudience` exclude it the same way), on
 * `/auth/v1` and on denextAuth's own endpoints alike: no message is sent, the answer is the
 * one an unknown address gets, and no second account is created for its address.
 *
 * The rule is sticky, as GoTrue's column is: linking another identity to an SSO user (from a
 * session its identity provider started) or unlinking one never turns it into a non-SSO user.
 * An existing account an identity provider was linked to (`linkExistingAccounts`) keeps the
 * provider it signed up with and is not an SSO user. An admin write never changes whether a user
 * is one ({@linkcode preserveSsoStatus}).
 *
 * The rule holds for sessions too ({@linkcode ssoSessionAllowed}): an SSO user's session lives
 * only when its identity provider started it, so one minted any other way (before the account
 * became an SSO user, or before such sign-ins were refused) is refused at refresh and at use. An
 * OAuth client's grant and a bearer API token carry the same fact from the session they came
 * from ({@linkcode snapshotAllowed}, {@linkcode apiTokenAllowed}).
 *
 * @module
 */

import type { AdapterUser } from "./adapter.ts";

/**
 * Whether a stored user is an SSO user.
 *
 * @param user The stored user.
 * @returns `true` for an account an SSO sign-in created.
 */
export function isSsoUser(user: Pick<AdapterUser, "appMetadata">): boolean {
  const provider = user.appMetadata?.provider;
  return typeof provider === "string" && provider.startsWith("sso:");
}

/**
 * The user a non-SSO sign-in, recovery or one-time-code lookup by email or phone may resolve:
 * the stored user, unless it is an SSO user (then `undefined`, exactly as for an unknown address).
 *
 * @param user What the adapter's `getUserByEmail` / `getUserByPhone` returned.
 * @returns The user, or `undefined`.
 */
export function nonSsoUser(user: AdapterUser | null | undefined): AdapterUser | undefined {
  return user && !isSsoUser(user) ? user : undefined;
}

/** The `amr` method an identity provider's (SAML) sign-in records. */
const SSO_AMR_METHOD = "sso/saml";

/**
 * Whether a session that proved `methods` was started by an identity provider (`sso/saml`; an
 * MFA step-up keeps that entry).
 *
 * @param methods The session's authentication methods (`amr`).
 * @returns `true` for a session a SAML sign-in started.
 */
export function ssoStarted(methods: Iterable<string>): boolean {
  for (const method of methods) if (method === SSO_AMR_METHOD) return true;
  return false;
}

/**
 * Whether a session of `user` that proved `methods` may live: any session of a non-SSO user, and
 * an SSO user's only when its identity provider started it (`methods` include `sso/saml`; an MFA
 * step-up keeps that entry). Every other session of an SSO user — a password, code, link,
 * passkey or OAuth sign-in from before the account became an SSO user, or from before non-SSO
 * sign-ins of SSO users were refused — is refused at refresh and at use. A denextAuth cookie or
 * native session lives for an SSO user only when a `saml()` provider's sign-in started it (its
 * `amr` carries `sso/saml`).
 *
 * @param user The stored user, read fresh.
 * @param methods The session's authentication methods (`amr`).
 * @returns `true` when the session may be used and refreshed.
 */
export function ssoSessionAllowed(
  user: Pick<AdapterUser, "appMetadata">,
  methods: Iterable<string>,
): boolean {
  return !isSsoUser(user) || ssoStarted(methods);
}

/**
 * The method names of a stored `/auth/v1` snapshot's `amr` (entries are `{ method }` objects).
 * The stored snapshot, never a token's `amr` claim: the custom access token hook may rewrite the
 * claim, not the snapshot.
 *
 * @param snapshot A session family's stored snapshot.
 * @returns Its methods, in order.
 */
export function snapshotMethods(snapshot: { amr?: unknown } | undefined): string[] {
  const amr = Array.isArray(snapshot?.amr) ? snapshot.amr : [];
  return amr.map((entry) =>
    typeof entry === "string" ? entry : String((entry as { method?: unknown })?.method ?? "")
  );
}

/**
 * Whether an `/auth/v1` session family of `user` may live: an SSO user's only when its identity
 * provider started it (an `sso/saml` entry, kept through an MFA step-up). A session issued to an
 * OAuth client lives when its grant was consented from a session the identity provider started
 * (`oauth.sso`); a grant consented from any other session — or one with no record of it (older
 * data) — is refused like the other non-IdP sessions.
 *
 * @param user The stored user, read fresh.
 * @param snapshot The family's stored snapshot (its `amr` entries and OAuth grant).
 * @returns `true` when the session may be refreshed and used.
 */
export function snapshotAllowed(
  user: Pick<AdapterUser, "appMetadata">,
  snapshot: { amr?: unknown; oauth?: unknown },
): boolean {
  if (!isSsoUser(user)) return true;
  if (snapshot.oauth) return (snapshot.oauth as { sso?: unknown }).sso === true;
  return ssoStarted(snapshotMethods(snapshot));
}

/**
 * Whether a bearer API token of `user` may authenticate: any of a non-SSO user's, and an SSO
 * user's only when it was minted from a session its identity provider started
 * (`ssoSession`). A token with no such record — minted without a session, from any other
 * session, or before the record existed — is refused.
 *
 * @param user The stored user, read fresh.
 * @param token The token's stored record.
 * @returns `true` when the token may authenticate.
 */
export function apiTokenAllowed(
  user: Pick<AdapterUser, "appMetadata">,
  token: { ssoSession?: boolean },
): boolean {
  return !isSsoUser(user) || token.ssoSession === true;
}

/**
 * The `app_metadata` an admin write may store: the user's SSO status never changes through it
 * (GoTrue's `is_sso_user` is not admin-writable). An SSO user keeps the `sso:` provider it signed
 * up through, and a non-SSO user's provider never becomes an `sso:` one; any other field is the
 * admin's to set.
 *
 * @param stored The stored `app_metadata` (`undefined` for a user being created).
 * @param next The merged `app_metadata` the admin asked for.
 * @returns `next`, with `provider` held to the stored SSO status.
 */
export function preserveSsoStatus(
  stored: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const wasSso = isSsoUser({ appMetadata: stored });
  if (wasSso ? next.provider === stored!.provider : !isSsoUser({ appMetadata: next })) return next;
  const out = { ...next };
  if (stored && Object.hasOwn(stored, "provider")) out.provider = stored.provider;
  else delete out.provider;
  return out;
}
