/**
 * **Account linking** — the one rule that decides whether a provider sign-in joins an
 * existing local identity or starts a new one. It runs between the provider round-trip
 * and `callbacks.signIn`, and it is the whole reason
 * {@link ./types.ts | OAuthProvider.allowDangerousEmailAccountLinking} exists.
 *
 * The matrix {@linkcode resolveSignInUser} implements:
 *
 * | Situation | Outcome |
 * | --- | --- |
 * | the `(provider, providerAccountId)` is already linked | that user signs in |
 * | not linked, provider asserts a **verified** email, a local user has that address **verified** | link the account (`linkAccount` event) |
 * | not linked, either side's email is **unverified** | **refused** — `AccountNotLinkedError` |
 * | not linked, no local user with that address (or no address at all) | create the user (`createUser` + `linkAccount` events) |
 *
 * The refusal is the security-relevant row. Matching on an unverified address means an
 * attacker who registers a local account with the victim's email — or a provider that
 * hands out an address it never checked — takes over the victim's account at their next
 * login. denext refuses by default; `allowDangerousEmailAccountLinking: true` on the
 * provider opts back in, and is named for what it is.
 *
 * With **no adapter configured** this is a pass-through: the profile the provider mapper
 * produced is the session user, byte-for-byte what denext did before 2.5.
 *
 * @module
 */

import type { AdapterAccount, AdapterUser, AuthAdapter } from "./adapter.ts";
import { emitAuthEvent } from "./events.ts";
import type { ResolvedAuthOptions } from "./options.ts";
import type { AuthUser, OAuthProvider } from "./types.ts";

/**
 * A sign-in refused because linking it to the existing local account would rest on an
 * **unverified** email address. Carries the stable `"account_not_linked"` code, so the
 * callback can answer `?error=account_not_linked` without echoing anything the provider
 * said.
 */
export class AccountNotLinkedError extends Error {
  /** The machine-readable reason — the `?error=` code the sign-in page receives. */
  readonly code: "account_not_linked" = "account_not_linked";

  /**
   * @param message A developer-facing explanation (logged, never shown to the user).
   */
  constructor(message: string) {
    super(message);
    this.name = "AccountNotLinkedError";
  }
}

/**
 * The stable `?error=` code for a linking refusal, or `undefined` when `error` is
 * anything else — what the OAuth callback branches on, so a refusal answers
 * `?error=account_not_linked` and every other failure keeps its own code.
 *
 * @param error The value a sign-in threw.
 * @returns `"account_not_linked"` for an {@linkcode AccountNotLinkedError}, else `undefined`.
 */
export function accountNotLinkedCode(error: unknown): string | undefined {
  if (!(error instanceof AccountNotLinkedError)) return undefined;
  const refusal: AccountNotLinkedError = error;
  return refusal.code;
}

// ---- the one boolean ⇄ epoch-seconds conversion pair -----------------------
//
// `AuthUser.emailVerified` is a BOOLEAN claim ("the provider said so"), while
// `AdapterUser.emailVerified` is epoch SECONDS ("we recorded it then"). Every conversion
// between the two goes through these two functions and nowhere else.

/**
 * Is a stored verification timestamp a verified address?
 *
 * @param storedAt The adapter's `emailVerified` (epoch seconds) or `undefined`.
 * @returns `true` when the address was ever verified.
 */
function isVerified(storedAt: number | undefined): boolean {
  return storedAt !== undefined;
}

/**
 * The timestamp to store for a provider's boolean claim.
 *
 * @param claim The provider's `emailVerified` claim (`undefined` = didn't say).
 * @param now Epoch seconds to record.
 * @returns `now` when the claim is `true`, else `undefined` (nothing is written).
 */
function verifiedAt(claim: boolean | undefined, now: number): number | undefined {
  return claim === true ? now : undefined;
}

/** The current time in epoch seconds — the unit every adapter record uses. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Copy the defined entries of `values` onto `target` — `undefined` never overwrites. */
function assignDefined<T extends object>(target: T, values: Partial<T>): T {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) Reflect.set(target, key, value);
  }
  return target;
}

/** Project an adapter record onto the session user, `emailVerified` back to a boolean. */
/**
 * The session user for a stored adapter user (`emailVerified` becomes a boolean).
 *
 * @param user The adapter's user record.
 * @returns The {@link AuthUser} the session carries.
 */
export function toAuthUser(user: AdapterUser): AuthUser {
  return assignDefined<AuthUser>(
    { id: user.id, emailVerified: isVerified(user.emailVerified) },
    { email: user.email, name: user.name, image: user.image, roles: user.roles },
  );
}

/** The record to create for a first-time provider profile. */
function toAdapterUser(profile: AuthUser, now: number): Omit<AdapterUser, "id"> {
  return assignDefined<Omit<AdapterUser, "id">>({}, {
    email: profile.email,
    emailVerified: verifiedAt(profile.emailVerified, now),
    name: profile.name,
    image: profile.image,
    roles: profile.roles,
  });
}

/**
 * Fields the provider knows and the stored record doesn't. The adapter always wins for a
 * field it already has — a user who renamed themselves locally is not renamed back by
 * every login — so only genuinely new knowledge is written.
 */
function learned(user: AdapterUser, profile: AuthUser, now: number): Partial<AdapterUser> {
  return assignDefined<Partial<AdapterUser>>({}, {
    email: user.email === undefined ? profile.email : undefined,
    name: user.name === undefined ? profile.name : undefined,
    image: user.image === undefined ? profile.image : undefined,
    emailVerified: user.emailVerified === undefined
      ? verifiedAt(profile.emailVerified, now)
      : undefined,
  });
}

/** Persist anything new the provider told us about an existing user. */
async function mergeProfile(
  adapter: AuthAdapter,
  user: AdapterUser,
  profile: AuthUser,
): Promise<AdapterUser> {
  const patch = learned(user, profile, nowSeconds());
  if (Object.keys(patch).length === 0) return user;
  return await adapter.updateUser({ ...patch, id: user.id });
}

/**
 * May this provider account be attached to this existing local user? Both sides must have
 * a verified address, unless the provider opted into the dangerous behaviour.
 *
 * @throws {AccountNotLinkedError} When either side's address is unverified.
 */
function assertLinkable(
  provider: OAuthProvider,
  profile: AuthUser,
  existing: AdapterUser,
): void {
  if (provider.allowDangerousEmailAccountLinking) return;
  if (profile.emailVerified === true && isVerified(existing.emailVerified)) return;
  throw new AccountNotLinkedError(
    `denextAuth: refusing to link the "${provider.id}" account to the existing user ` +
      `${JSON.stringify(existing.id)} — ` +
      (profile.emailVerified === true
        ? "that account's email address has never been verified"
        : "the provider did not assert that the email address is verified") +
      ", so the match proves nothing. Verify the address first, or set " +
      "`allowDangerousEmailAccountLinking: true` on the provider if you accept the risk.",
  );
}

/**
 * Store the account under `user` and announce it.
 *
 * The account is persisted **with** whatever tokens the provider returned (that is what an
 * adapter is for), but the `linkAccount` event payload carries only the identity —
 * provider, provider-side id, type, owner. An event handler is an audit sink, and an
 * access/refresh/id token in an audit line is a credential in a log; a handler that
 * genuinely needs them can read the stored account back through the adapter.
 */
async function link(
  options: ResolvedAuthOptions,
  adapter: AuthAdapter,
  user: AdapterUser,
  account: Omit<AdapterAccount, "userId">,
): Promise<void> {
  const linked: AdapterAccount = { ...account, userId: user.id };
  await adapter.linkAccount(linked);
  await emitAuthEvent(options, "linkAccount", {
    user,
    account: {
      userId: linked.userId,
      provider: linked.provider,
      providerAccountId: linked.providerAccountId,
      type: linked.type,
    },
  });
}

/** What {@linkcode resolveSignInUser} decided a sign-in is. */
export interface ResolvedSignIn {
  /** The user to issue a session for. */
  user: AuthUser;
  /** Whether this sign-in created the adapter's user record (the `signIn` event's `isNewUser`). */
  isNewUser: boolean;
}

/**
 * Resolve the {@link ./types.ts | AuthUser} a provider sign-in should become, creating or
 * linking the adapter records it implies. Called by the OAuth callback between the
 * provider round-trip and `callbacks.signIn`.
 *
 * Without a configured adapter it returns `profile` unchanged. With one it applies the
 * linking matrix documented at the top of this module, fires the `createUser` /
 * `linkAccount` events, and returns the *adapter's* view of the user — so
 * `session.user.id` is the adapter id and `session.user.roles` are the stored roles.
 *
 * @param options The resolved auth options (adapter, events, logger).
 * @param provider The provider that authenticated the profile.
 * @param profile The normalised profile `provider.profile` produced.
 * @param account The provider account to link, minus the `userId` this resolves.
 * @returns The session user plus whether this sign-in CREATED the adapter record — which
 * is what the `signIn` event's documented `isNewUser` reports. Without an adapter nothing
 * is created, so `isNewUser` is `false`.
 * @throws {AccountNotLinkedError} When an existing local account matches by email but the
 * match rests on an unverified address and the provider did not opt in.
 */
export async function resolveSignInUser(
  options: ResolvedAuthOptions,
  provider: OAuthProvider,
  profile: AuthUser,
  account: Omit<AdapterAccount, "userId">,
): Promise<ResolvedSignIn> {
  const adapter = options.adapter;
  if (!adapter) return { user: profile, isNewUser: false };

  const linked = await adapter.getUserByAccount(account);
  if (linked) {
    return { user: toAuthUser(await mergeProfile(adapter, linked, profile)), isNewUser: false };
  }

  const existing = profile.email ? await adapter.getUserByEmail(profile.email) : undefined;
  if (existing) {
    assertLinkable(provider, profile, existing);
    const user = await mergeProfile(adapter, existing, profile);
    await link(options, adapter, user, account);
    return { user: toAuthUser(user), isNewUser: false };
  }

  const created = await adapter.createUser(toAdapterUser(profile, nowSeconds()));
  await emitAuthEvent(options, "createUser", { user: created });
  await link(options, adapter, created, account);
  return { user: toAuthUser(created), isNewUser: true };
}
