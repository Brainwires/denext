/**
 * The optional adapter groups behind three `/auth/v1` surfaces:
 *
 * - **the OAuth 2.1 authorization server** (`supabase.auth.admin.oauth.*`,
 *   `supabase.auth.oauth.*`, `/oauth/authorize` + `/oauth/token`): registered clients, pending
 *   authorization requests, the user's consents (grants), and which session families a client
 *   holds for a user (so revoking a grant revokes its tokens);
 * - **stored OAuth / OIDC providers** (`supabase.auth.admin.customProviders.*`);
 * - **Web3 sign-in** (`signInWithWeb3`): single-use message nonces.
 *
 * Each group is all-or-nothing: an adapter implements every method of a group or none, and the
 * surface that needs a missing group answers 500 rather than half-working. denext's in-memory,
 * SQLite and Postgres adapters implement all three.
 *
 * **Atomicity.** {@linkcode OAuthServerAdapter.updateOAuthAuthorization} is a compare-and-swap,
 * {@linkcode CustomProviderAdapter.createCustomProvider} an insert-unless-present and
 * {@linkcode Web3NonceAdapter.claimWeb3Nonce} a claim-unless-present; each MUST be atomic
 * against concurrent callers (one statement, not a read followed by a write), or an
 * authorization code, a consent or a signed message becomes replayable.
 *
 * @module
 */

import type { MaybePromise } from "./adapter.ts";

/** One registered OAuth client (Supabase's `OAuthClient`, secret hashed). */
export interface OAuthClientRecord {
  /** The client id (a UUID). */
  id: string;
  /** Display name. */
  name: string;
  /** `confidential` clients authenticate at the token endpoint; `public` ones cannot. */
  clientType: "public" | "confidential";
  /** How the client authenticates at the token endpoint. */
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  /** `manual` (the admin API) or `dynamic` (registration). */
  registrationType: "manual" | "dynamic";
  /** The client's home page. */
  clientUri?: string;
  /** The client's logo. */
  logoUri?: string;
  /** Registered redirect URIs — a request's `redirect_uri` must equal one byte for byte. */
  redirectUris: string[];
  /** Allowed grant types (`authorization_code`, `refresh_token`). */
  grantTypes: string[];
  /** Allowed response types (`code`). */
  responseTypes: string[];
  /** The scopes the client may ask for (space-separated); absent = every supported scope. */
  scope?: string;
  /** SHA-256 (hex, domain-separated) of the client secret — never the secret itself. */
  secretHash?: string;
  /** Creation time, epoch seconds. */
  createdAt: number;
  /** Last update, epoch seconds. */
  updatedAt: number;
}

/** A pending (then settled) authorization request — `/oauth/authorize` creates one. */
export interface OAuthAuthorizationRecord {
  /** The authorization id the consent page is handed (random, unguessable). */
  id: string;
  /** The client asking. */
  clientId: string;
  /** The user who opened it on the consent page (bound on first read). */
  userId?: string;
  /** The redirect URI the request named (one of the client's, exactly). */
  redirectUri: string;
  /** The requested scopes, space-separated. */
  scope: string;
  /** The client's `state`, echoed on the redirect. */
  state?: string;
  /** The client's OIDC `nonce`, carried into the id_token. */
  nonce?: string;
  /** The PKCE S256 challenge. */
  codeChallenge: string;
  /** `pending` → `approved` (a code was issued) or `denied`; `approved` → `used`. */
  status: "pending" | "approved" | "denied" | "used";
  /** SHA-256 (hex) of the authorization code, once approved. */
  codeHash?: string;
  /** The session family the code was exchanged for (revoked when the code is replayed). */
  sessionId?: string;
  /**
   * Set at approval when the consenting session was started by the user's identity provider
   * (a SAML sign-in). The tokens a code from an SSO user's request is exchanged for live only
   * with it; an approval without it (or a row from before it existed) reads as not SSO-consented.
   */
  ssoConsent?: true;
  /** Creation time, epoch seconds. */
  createdAt: number;
  /** When the request (or its unexchanged code) expires, epoch seconds. */
  expiresAt: number;
}

/** The fields {@linkcode OAuthServerAdapter.updateOAuthAuthorization} may change. */
export type OAuthAuthorizationPatch = Partial<
  Pick<
    OAuthAuthorizationRecord,
    "userId" | "status" | "codeHash" | "sessionId" | "expiresAt" | "ssoConsent"
  >
>;

/** What {@linkcode OAuthServerAdapter.updateOAuthAuthorization} requires of the stored row. */
export interface OAuthAuthorizationExpect {
  /** The status the row must still have. */
  status?: OAuthAuthorizationRecord["status"];
  /** The bound user it must have — `null` for "no user bound yet". */
  userId?: string | null;
}

/** A user's consent to a client (Supabase's `OAuthGrant`). */
export interface OAuthConsentRecord {
  /** The user. */
  userId: string;
  /** The client. */
  clientId: string;
  /** The scopes granted. */
  scopes: string[];
  /** When it was (last) granted, epoch seconds. */
  grantedAt: number;
  /** When it was revoked, epoch seconds. */
  revokedAt?: number;
}

/** A session family issued to a client on a user's behalf. */
export interface OAuthSessionLink {
  /** The session family id. */
  sessionId: string;
  /** The user. */
  userId: string;
  /** The client. */
  clientId: string;
  /** Issue time, epoch seconds. */
  createdAt: number;
}

/** The OAuth 2.1 authorization-server group. */
export interface OAuthServerAdapter {
  /** Store a new client. */
  createOAuthClient?(client: OAuthClientRecord): MaybePromise<void>;
  /** A client by id, or `undefined`. */
  getOAuthClient?(id: string): MaybePromise<OAuthClientRecord | undefined>;
  /** One page of clients (oldest first) and the total. */
  listOAuthClients?(
    page: { page: number; perPage: number },
  ): MaybePromise<{ clients: OAuthClientRecord[]; total: number }>;
  /** Replace a stored client (a no-op for an unknown id). */
  updateOAuthClient?(client: OAuthClientRecord): MaybePromise<void>;
  /** Delete a client with its authorizations, consents and session links. */
  deleteOAuthClient?(id: string): MaybePromise<void>;
  /** Store a new authorization request (expired ones may be reclaimed on the way). */
  createOAuthAuthorization?(record: OAuthAuthorizationRecord): MaybePromise<void>;
  /** An authorization request by id, exactly as stored (expired ones included). */
  getOAuthAuthorization?(id: string): MaybePromise<OAuthAuthorizationRecord | undefined>;
  /** The authorization request a code was issued for, by the code's hash. */
  getOAuthAuthorizationByCode?(
    codeHash: string,
  ): MaybePromise<OAuthAuthorizationRecord | undefined>;
  /**
   * **Atomically** apply `patch` when the stored row still matches `expect` — a
   * compare-and-swap. Two racing callers with the same `expect` see exactly one `true`.
   */
  updateOAuthAuthorization?(
    id: string,
    patch: OAuthAuthorizationPatch,
    expect: OAuthAuthorizationExpect,
  ): MaybePromise<boolean>;
  /** Store (or replace) a user's consent to a client. */
  putOAuthConsent?(consent: OAuthConsentRecord): MaybePromise<void>;
  /** A user's consent to a client, revoked ones included. */
  getOAuthConsent?(userId: string, clientId: string): MaybePromise<OAuthConsentRecord | undefined>;
  /** Every consent of a user (revoked ones included), oldest first. */
  listOAuthConsents?(userId: string): MaybePromise<OAuthConsentRecord[]>;
  /** Record that a session family belongs to a client's grant. */
  linkOAuthSession?(link: OAuthSessionLink): MaybePromise<void>;
  /** The session families a client holds for a user. */
  listOAuthSessions?(userId: string, clientId: string): MaybePromise<string[]>;
  /** The session families a client holds for anyone. */
  listOAuthClientSessions?(clientId: string): MaybePromise<string[]>;
}

/** One stored OAuth / OIDC identity provider (`custom:<name>`). */
export interface CustomProviderRecord {
  /** A UUID. */
  id: string;
  /** `custom:<name>` — what `signInWithOAuth({ provider })` names. */
  identifier: string;
  /** `oauth2` or `oidc`. */
  providerType: "oauth2" | "oidc";
  /** Display name. */
  name: string;
  /** The provider-issued client id. */
  clientId: string;
  /** The client secret, sealed under the auth secret (never stored or returned in clear). */
  clientSecretSealed: string;
  /** Whether sign-in through it is allowed. */
  enabled: boolean;
  /** Everything else Supabase's `CustomOAuthProvider` carries (endpoints, scopes, mapping). */
  settings: Record<string, unknown>;
  /** Creation time, epoch seconds. */
  createdAt: number;
  /** Last update, epoch seconds. */
  updatedAt: number;
}

/** The stored-provider group. */
export interface CustomProviderAdapter {
  /** **Atomically** store a provider unless its identifier exists; `false` when it does. */
  createCustomProvider?(record: CustomProviderRecord): MaybePromise<boolean>;
  /** A provider by identifier. */
  getCustomProvider?(identifier: string): MaybePromise<CustomProviderRecord | undefined>;
  /** Every provider, oldest first. */
  listCustomProviders?(): MaybePromise<CustomProviderRecord[]>;
  /** Replace a stored provider (a no-op for an unknown identifier). */
  updateCustomProvider?(record: CustomProviderRecord): MaybePromise<void>;
  /** Delete a provider. */
  deleteCustomProvider?(identifier: string): MaybePromise<void>;
}

/** The Web3 sign-in group. */
export interface Web3NonceAdapter {
  /**
   * **Atomically** claim a single-use value (a SIWE / SIWS nonce or message hash): `true` the
   * first time, `false` while an unexpired claim exists.
   */
  claimWeb3Nonce?(hash: string, expiresAt: number): MaybePromise<boolean>;
}

const OAUTH_SERVER_METHODS = [
  "createOAuthClient",
  "getOAuthClient",
  "listOAuthClients",
  "updateOAuthClient",
  "deleteOAuthClient",
  "createOAuthAuthorization",
  "getOAuthAuthorization",
  "getOAuthAuthorizationByCode",
  "updateOAuthAuthorization",
  "putOAuthConsent",
  "getOAuthConsent",
  "listOAuthConsents",
  "linkOAuthSession",
  "listOAuthSessions",
  "listOAuthClientSessions",
] as const;

const CUSTOM_PROVIDER_METHODS = [
  "createCustomProvider",
  "getCustomProvider",
  "listCustomProviders",
  "updateCustomProvider",
  "deleteCustomProvider",
] as const;

/** {@linkcode OAuthServerAdapter} with every method present. */
export type OAuthServerStore = Required<OAuthServerAdapter>;
/** {@linkcode CustomProviderAdapter} with every method present. */
export type CustomProviderStore = Required<CustomProviderAdapter>;

function hasAll(adapter: object | undefined, methods: readonly string[]): boolean {
  return !!adapter &&
    methods.every((m) => typeof (adapter as Record<string, unknown>)[m] === "function");
}

/**
 * The adapter's OAuth-server group, or `null` when it lacks one.
 *
 * @param adapter The configured adapter.
 * @returns The adapter narrowed to the group.
 */
export function oauthServerStoreOf(
  adapter: OAuthServerAdapter | undefined,
): OAuthServerStore | null {
  return hasAll(adapter, OAUTH_SERVER_METHODS) ? adapter as OAuthServerStore : null;
}

/**
 * The adapter's stored-provider group, or `null` when it lacks one.
 *
 * @param adapter The configured adapter.
 * @returns The adapter narrowed to the group.
 */
export function customProviderStoreOf(
  adapter: CustomProviderAdapter | undefined,
): CustomProviderStore | null {
  return hasAll(adapter, CUSTOM_PROVIDER_METHODS) ? adapter as CustomProviderStore : null;
}
