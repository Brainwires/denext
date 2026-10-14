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
 * provider it signed up with and is not an SSO user.
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
