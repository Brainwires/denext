// The session shapes shared by denext's request pipeline and the `@denext/auth` plugin: the
// signed-in user, the session payload, and the store contract revocable sessions live in. They
// stay in core so `auth()`, `requireSession()` and the store contracts type-check without the
// plugin installed.

/** A normalized user profile — the non-sensitive identity denext stores in the session. */
export interface AuthUser {
  /** Stable provider-scoped user id. */
  id: string;
  /** Display name, if the provider supplies one. */
  name?: string;
  /** Email, if granted. Dropped by the built-in OIDC mappers when the provider marks
   * it `email_verified: false` — so an app that links accounts by email can't be fed
   * an attacker-chosen, unverified address. Check {@link emailVerified} before trusting
   * it for account linking. */
  email?: string;
  /** Whether the provider asserted the email is verified (`email_verified` claim).
   * `undefined` when the provider doesn't say. Never treat an unverified/absent value
   * as proof of ownership when linking to an existing local account. */
  emailVerified?: boolean;
  /** Avatar URL, if any. */
  image?: string;
  /**
   * Authorization roles carried in the session — what `requireAuth(request, { role })` and
   * `requireSession({ role })` match (any-of). Populate them in `callbacks.signIn` /
   * `callbacks.session`, or from an `AuthAdapter` user record. Absent
   * means "no roles", so a role check on a session without them always refuses.
   */
  roles?: string[];
  /**
   * `true` for an anonymous user (`POST {basePath}/anonymous`, `signInAnonymously()`): signed
   * in with no email or phone yet. It becomes permanent — and loses the flag — by redeeming an
   * email link / code or a phone code for an identifier no other account has. Absent otherwise.
   */
  isAnonymous?: true;
}

/** The signed (readable, tamper-evident) session payload. Never stores tokens/secrets. */
export interface AuthSession {
  /** The signed-in user. */
  user: AuthUser;
  /** The provider id that authenticated this session. */
  provider: string;
  /** Expiry, epoch seconds. */
  expiresAt: number;
  /**
   * The server-side session id — present only when `denextAuth` runs with a
   * `sessionStore`. Pass it to `revokeSession` to end this one session (e.g. "sign out
   * this device"); stateless sessions have no id.
   */
  sessionId?: string;
  /**
   * A stateless cookie session's own random id (128 bits, base64url), minted with the session
   * and sealed in its httpOnly cookie; `/auth/session` and the client hooks leave it out.
   * SAML Single Logout names a session by it: an IdP's LogoutRequest puts exactly the sessions it
   * names on the auth adapter's revocation list, and a revoked session reads as signed out. A
   * cookie issued before denext minted it has none and can't be targeted. `revokeSession(sid)`
   * ends the session through the same list, and `currentSessionId()` reads it on the server.
   * (A store-backed session's id is {@linkcode sessionId}.)
   */
  sid?: string;
  /**
   * The native-app session family this request authenticated with — present only when the
   * caller presented a native access token (`Authorization: Bearer nat_…`, see
   * `AuthNativeConfig` in `@denext/auth`). Such a session is never slid forward and sets no cookie.
   */
  nativeSessionId?: string;
  /**
   * Payload version. Absent (or `1`) on a session issued before 2.5; `2` on every session
   * denext issues now. The cookie's MAC domain is unchanged, so a v1 cookie keeps
   * verifying — readers just treat the fields below as absent.
   */
  v?: 2;
  /**
   * When this session payload was last issued, epoch seconds: at sign-in, and again each
   * time sliding expiry (`session.updateAge`) re-issues the session — a slide re-stamps
   * `issuedAt` along with `expiresAt`. With sliding on it is therefore the time of the
   * last slide, not of the sign-in, so an age measured from it (the `mfa.freshness` rule)
   * says nothing about when a factor was proven (that is `authTime`). Absent on a v1
   * payload, where readers infer `expiresAt - maxAge`.
   */
  issuedAt?: number;
  /**
   * When the user last authenticated, epoch seconds: set at sign-in and again at a
   * second-factor step-up, and never moved by sliding expiry. It, not `issuedAt`, says how
   * recently a factor was proven: the `mfa.freshness` rule for `/mfa/disable`, and the recent
   * sign-in `/mfa/enroll` asks for. Absent on a session issued before 2.5.0-rc.3.
   */
  authTime?: number;
  /**
   * {@link authTime} in epoch milliseconds: what "sign out everywhere" (`sessionsValidAfter`)
   * compares, so a sign-in in the same second as a revocation is told apart from one before it.
   * Absent on a session issued before 4.6.0, which counts as signed in at the start of its
   * `authTime` second.
   */
  authTimeMs?: number;
  /**
   * Set while the user has passed the first factor but not yet the second. A pending
   * session **fails closed**: `auth()` reports `null` for it, so every guard built on
   * `auth()` (requireAuth, requireSession, Live `authorize`, Server Actions) refuses too.
   * Only the MFA endpoints read a pending session. Absent means the session is complete.
   */
  mfaPending?: true;
  /**
   * RFC 8176 authentication-method references — how the user proved identity
   * (e.g. `["pwd"]`, `["pwd", "otp"]`). Absent on a v1 payload; readers treat that as `[]`.
   */
  amr?: string[];
  /**
   * For a session a `saml()` provider's sign-in started: the assertion's NameID (with its Format
   * and the AuthnStatement's SessionIndex, when given) — what SAML Single Logout names the
   * session by. Set by the framework; a `callbacks.session` result can't change it.
   */
  saml?: AuthSessionSaml;
}

/** The SAML subject of a session a `saml()` provider started ({@linkcode AuthSession.saml}). */
export interface AuthSessionSaml {
  /** The Subject's NameID. */
  nameId: string;
  /** The NameID's Format, when the assertion gave one. */
  nameIdFormat?: string;
  /** The AuthnStatement's SessionIndex, when the assertion gave one. */
  sessionIndex?: string;
}

/**
 * Where store-backed sessions live. Every method may be sync or async; `get` must
 * return only an **unexpired** session (treat `expiresAt` in the past as a miss).
 */
export interface SessionStore {
  /** Persist `session` under the (random, unguessable) `id`. */
  create(id: string, session: AuthSession): void | Promise<void>;
  /**
   * Optional, but **required for sliding expiry** (`session.updateAge`): rewrite an
   * EXISTING record in place — write-only-if-present. It must NOT create a row: the
   * whole point is that a session revoked between the read and the refresh stays
   * revoked instead of being resurrected with a fresh lifetime by an upsert.
   *
   * A store that doesn't implement it simply never slides its sessions forward
   * (`@denext/auth`'s sliding refresh returns the session untouched and
   * warns once), which is safe — the session still expires on its original schedule.
   *
   * @param id The session id to rewrite.
   * @param session The refreshed payload.
   * @returns `true` when a live row was rewritten; `false` when `id` is unknown,
   * revoked or expired (nothing was written).
   */
  update?(id: string, session: AuthSession): boolean | Promise<boolean>;
  /** The live session for `id`, or `undefined` when absent, revoked, or expired. */
  get(id: string): AuthSession | undefined | Promise<AuthSession | undefined>;
  /** Revoke one session (a no-op for an unknown id). */
  delete(id: string): void | Promise<void>;
  /** Revoke every session belonging to `userId` ("sign out everywhere"). */
  deleteByUser(userId: string): void | Promise<void>;
  /** Optional: release resources (a DB handle) when the server drains. */
  close?(): void | Promise<void>;
}
