/**
 * The **persistence port** for denext auth: an {@linkcode AuthAdapter} is where users,
 * linked provider accounts, credentials, verification tokens, API tokens and MFA
 * factors live. It is deliberately NOT a session mechanism — sessions stay with
 * {@link ./session-store.ts | SessionStore}, and an adapter only *optionally* exposes
 * one as {@linkcode AuthAdapter.sessions}. Passing an adapter therefore never flips a
 * stateless (signed-cookie) deployment to database sessions; that is
 * `session: { strategy: "database" }`.
 *
 * Shape notes, so every implementation agrees:
 * - Every method may be **sync or async** ({@linkcode Await}).
 * - Timestamps are **epoch seconds**, never `Date`.
 * - A miss is `undefined`, never `null`.
 * - The `users` + `accounts` methods are **required**; every other group is optional
 *   and gates the feature that needs it (verification tokens gate email verification /
 *   password reset / magic links, `getCredential`/`setCredential` gate first-party
 *   password storage, the api-token group gates bearer tokens, the MFA group gates TOTP).
 *
 * @module
 */

import type { SessionStore } from "./session-store.ts";

/** A value an adapter may return directly or as a promise. */
export type Await<T> = T | Promise<T>;

/** What a verification token is for (one token space per purpose). */
export type VerificationPurpose = "email" | "reset" | "magic" | "otp";

/** A user record as the adapter stores it. `id` is the identity `session.user.id` carries. */
export interface AdapterUser {
  /** The adapter-assigned, stable user id. */
  id: string;
  /** Primary email, when known. */
  email?: string;
  /** When the email was verified (epoch seconds); `undefined` while unverified. */
  emailVerified?: number;
  /** Display name. */
  name?: string;
  /** Avatar URL. */
  image?: string;
  /** Authorization roles — the values `requireAuth({ role })` / `requireSession({ role })` match. */
  roles?: string[];
}

/** A provider account linked to an {@linkcode AdapterUser}. */
export interface AdapterAccount {
  /** The {@linkcode AdapterUser.id} this account belongs to. */
  userId: string;
  /** The denext provider id (the `[provider]` route segment), e.g. `"google"`. */
  provider: string;
  /** The provider's own account id (the OIDC `sub`, the GitHub numeric id, …). */
  providerAccountId: string;
  /** How the account authenticates. */
  type?: "oauth" | "oidc" | "credentials" | "email";
  /** The provider access token, when the app chose to persist it. */
  accessToken?: string;
  /** The provider refresh token, when the app chose to persist it. */
  refreshToken?: string;
  /** Access-token expiry (epoch seconds). */
  expiresAt?: number;
  /** The token type the provider returned (`"bearer"`). */
  tokenType?: string;
  /** The scopes the token carries. */
  scope?: string;
  /** The raw `id_token`, when the app chose to persist it. */
  idToken?: string;
}

/**
 * A single-use token proving control of an identifier (an email verification link, a
 * password-reset link, a magic link, a one-time code). Only the **hash** is stored, so a
 * database read never yields a usable token.
 */
export interface VerificationTokenRecord {
  /** What the token proves control of — an email address, in practice. */
  identifier: string;
  /** SHA-256 (hex) of the presented token, scoped by `identifier` + `purpose`. */
  tokenHash: string;
  /** Expiry, epoch seconds. */
  expires: number;
  /** The token space this belongs to. */
  purpose: VerificationPurpose;
  /** Opaque payload the flow wants back on redemption (e.g. a pending email change). */
  data?: string;
}

/** A long-lived bearer API token. The presented secret is never stored, only its hash. */
export interface ApiTokenRecord {
  /** The token's own id (what `/tokens/:id` deletes). */
  id: string;
  /** The owning {@linkcode AdapterUser.id}. */
  userId: string;
  /** A human label ("CI", "laptop"). */
  name?: string;
  /** SHA-256 (hex) of the presented `tok_…` string. */
  tokenHash: string;
  /** Creation time, epoch seconds. */
  createdAt: number;
  /** Expiry, epoch seconds; `undefined` never expires. */
  expiresAt?: number;
  /** Last successful presentation, epoch seconds. */
  lastUsedAt?: number;
  /** Optional scope strings the app interprets. */
  scopes?: string[];
  /** When the token was revoked, epoch seconds; a revoked token must never authenticate. */
  revokedAt?: number;
}

/** A user's TOTP factor plus their single-use backup codes. */
export interface MfaRecord {
  /** The owning {@linkcode AdapterUser.id}. */
  userId: string;
  /** The base32 TOTP secret. Stored in plaintext — see the auth KNOWN-LIMITATIONS entry. */
  secret: string;
  /** When enrollment was confirmed (epoch seconds); `undefined` while pending. */
  confirmedAt?: number;
  /** Hashed backup codes (through the configured {@link ./hasher.ts | Hasher}). */
  backupCodeHashes: string[];
  /** The last TOTP step already spent, for the replay guard. */
  lastStep?: number;
}

/** Identifies one linked provider account. */
export interface AdapterAccountRef {
  /** The denext provider id. */
  provider: string;
  /** The provider's own account id. */
  providerAccountId: string;
}

/** Identifies one verification token (the tuple its uniqueness is scoped by). */
export interface VerificationTokenRef {
  /** The identifier the token was issued for. */
  identifier: string;
  /** SHA-256 (hex) of the presented token. */
  tokenHash: string;
  /** The token space. */
  purpose: VerificationPurpose;
}

/**
 * Where denext auth persists identities. Implement it over any store; denext ships
 * `inMemoryAuthAdapter()` and `sqliteAuthAdapter()`.
 *
 * **Atomicity contract.** Three methods are **consume-once** and MUST be atomic against
 * concurrent callers — a compare-and-delete / conditional update inside one transaction,
 * not a read followed by a write. Two racing requests must see exactly one success:
 * {@linkcode AuthAdapter.useVerificationToken} (delete-and-return),
 * {@linkcode AuthAdapter.consumeBackupCode} (match-and-remove) and
 * {@linkcode AuthAdapter.claimTotpStep} (claim a TOTP step). A non-atomic implementation
 * turns each of them into a replay window.
 */
export interface AuthAdapter {
  // ---- users (required) ----------------------------------------------------

  /**
   * Create a user.
   *
   * @param user The profile to store; supply `id` only to keep an externally minted one.
   * @returns The stored record, with its final `id`.
   */
  createUser(user: Omit<AdapterUser, "id"> & { id?: string }): Await<AdapterUser>;

  /**
   * Look a user up by id.
   *
   * @param id The {@linkcode AdapterUser.id}.
   * @returns The user, or `undefined`.
   */
  getUser(id: string): Await<AdapterUser | undefined>;

  /**
   * Look a user up by email (case-insensitively, if the store can).
   *
   * @param email The address.
   * @returns The user, or `undefined`.
   */
  getUserByEmail(email: string): Await<AdapterUser | undefined>;

  /**
   * Look a user up by a linked provider account — the primary sign-in path.
   *
   * @param account The provider + provider-side account id.
   * @returns The user, or `undefined` when the account is not linked.
   */
  getUserByAccount(account: AdapterAccountRef): Await<AdapterUser | undefined>;

  /**
   * Merge changed fields into a user.
   *
   * @param user The `id` plus the fields to change.
   * @returns The updated record.
   */
  updateUser(user: Partial<AdapterUser> & { id: string }): Await<AdapterUser>;

  // ---- accounts (required) -------------------------------------------------

  /**
   * Link a provider account to a user.
   *
   * @param account The account to store.
   */
  linkAccount(account: AdapterAccount): Await<void>;

  /**
   * Unlink a provider account (optional).
   *
   * @param account The provider + provider-side account id.
   */
  unlinkAccount?(account: AdapterAccountRef): Await<void>;

  /**
   * Every provider account linked to a user (optional).
   *
   * @param userId The owner.
   * @returns The linked accounts.
   */
  listAccounts?(userId: string): Await<AdapterAccount[]>;

  // ---- verification tokens (optional) --------------------------------------

  /**
   * Store a single-use verification token.
   *
   * @param token The record to store (hash only — never the presented token).
   */
  createVerificationToken?(token: VerificationTokenRecord): Await<void>;

  /**
   * **Atomically** redeem a verification token: delete it and return what it was, or
   * return `undefined` when it is absent (already spent, or never existed). The delete
   * and the read MUST happen as one operation — two concurrent redemptions of the same
   * token must produce exactly one record. An expired token is consumed too but
   * resolves `undefined` (fail closed) — it is never left to be retried.
   *
   * @param ref The identifier + token hash + purpose to redeem.
   * @returns The consumed record, or `undefined`.
   */
  useVerificationToken?(ref: VerificationTokenRef): Await<VerificationTokenRecord | undefined>;

  // ---- credentials (optional) ----------------------------------------------

  /**
   * The stored password hash for a user (optional).
   *
   * @param userId The owner.
   * @returns The `scrypt$…` string, or `undefined` when the user has no password.
   */
  getCredential?(userId: string): Await<string | undefined>;

  /**
   * Set (or replace) a user's password hash (optional).
   *
   * @param userId The owner.
   * @param hash The value {@link ./hasher.ts | Hasher.hash} produced.
   */
  setCredential?(userId: string, hash: string): Await<void>;

  // ---- API tokens (optional) -----------------------------------------------

  /**
   * Store a bearer API token (optional).
   *
   * @param token The record to store (hash only).
   */
  createApiToken?(token: ApiTokenRecord): Await<void>;

  /**
   * Look a bearer token up by the hash of the presented string (optional).
   *
   * @param tokenHash SHA-256 (hex) of the presented token.
   * @returns The record, or `undefined`.
   */
  getApiTokenByHash?(tokenHash: string): Await<ApiTokenRecord | undefined>;

  /**
   * Record a successful presentation (optional; best-effort, never fails a request).
   *
   * @param id The token id.
   * @param lastUsedAt Epoch seconds.
   */
  touchApiToken?(id: string, lastUsedAt: number): Await<void>;

  /**
   * Revoke a bearer token (optional).
   *
   * @param id The token id.
   */
  revokeApiToken?(id: string): Await<void>;

  /**
   * A user's bearer tokens (optional). Implementations never return the secret.
   *
   * @param userId The owner.
   * @returns The records.
   */
  listApiTokens?(userId: string): Await<ApiTokenRecord[]>;

  // ---- MFA (optional) ------------------------------------------------------

  /**
   * A user's TOTP factor (optional).
   *
   * @param userId The owner.
   * @returns The record, or `undefined` when the user has no factor.
   */
  getMfa?(userId: string): Await<MfaRecord | undefined>;

  /**
   * Store (or replace) a user's TOTP factor (optional).
   *
   * @param record The factor to store.
   */
  setMfa?(record: MfaRecord): Await<void>;

  /**
   * **Atomically** spend one backup code. Backup codes are stored salted-and-hashed, so
   * the adapter cannot look one up by value: it walks
   * {@linkcode MfaRecord.backupCodeHashes}, `await`s `matches(hash)` for each, and — still
   * inside the same transaction / critical section — removes the first hash that matches
   * and reports `true`. Two concurrent redemptions of the same code must yield exactly
   * one `true`.
   *
   * @param userId The owner.
   * @param matches Constant-time comparison of the presented code against one stored hash.
   * @returns `true` when a code was matched AND removed.
   */
  consumeBackupCode?(userId: string, matches: (hash: string) => Await<boolean>): Await<boolean>;

  /**
   * **Atomically** claim a TOTP time step, the replay guard for a valid code presented
   * twice. Succeeds only when `step` is strictly greater than the stored
   * {@linkcode MfaRecord.lastStep}, and stores it in the same operation. Two concurrent
   * presentations of one code must yield exactly one `true`.
   *
   * @param userId The owner.
   * @param step The TOTP step the presented code verified against.
   * @returns `true` when the step was claimed (i.e. not a replay).
   */
  claimTotpStep?(userId: string, step: number): Await<boolean>;

  // ---- sessions + lifecycle ------------------------------------------------

  /**
   * An optional {@link ./session-store.ts | SessionStore} over the same storage. It is
   * used only when the app asks for `session: { strategy: "database" }` (or passes
   * `sessionStore` itself) — an adapter never silently makes sessions stateful.
   */
  sessions?: SessionStore;

  /** Optional: release resources (a database handle) when the server drains. */
  close?(): Await<void>;
}
