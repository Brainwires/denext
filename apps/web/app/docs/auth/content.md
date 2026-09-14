---
title: Auth
slug: auth
lead: First-party OAuth 2.0 / OIDC, Credentials and passwordless email auth — zero-npm, secure by default — with a database adapter, email verification and password reset, TOTP two-factor, roles, bearer API tokens, and the low-level signed-cookie sessions it is built on.
---

## Overview

`denextAuth` is a **plugin**. Add it to `plugins` in `denext.config.ts` and it mounts
the `/auth/*` endpoints itself — there is nothing to write under `app/`, and it
registers exactly one request handler, so it never competes with your routes. A path
under the base path that no endpoint claims falls through to the rest of the app as a
normal 404.

Three facts shape everything below:

- **One cookie.** A signed (HMAC-SHA256), `__Host-`-prefixed cookie carries the session.
  It is readable but tamper-evident, and it never stores provider tokens or secrets.
- **Stateless by default.** The whole payload lives in that cookie, which is what makes
  zero-config edge / serverless / multi-replica deploys work. Opt into server-side,
  revocable sessions with a `sessionStore` (or `session.strategy: "database"`).
- **Persistence is optional and separate.** An `adapter` is where users, linked provider
  accounts, credentials, API tokens and MFA factors live. Passing one never by itself
  makes sessions stateful — those are two different decisions.

Everything comes from `denext/server` (the client half from `denext` or
`denext/client`). There is no `denext/auth` subpath.

On top of sign-in, the plugin runs the account flows an app would otherwise hand-roll:
[password sign-in with no `authorize`](#password-sign-in-without-an-authorize),
[email verification and password reset](#email-verification-and-password-reset),
[passwordless magic links and one-time codes](#passwordless-magic-links-and-one-time-codes)
and [TOTP two-factor authentication](#two-factor-authentication-totp). All four need an
`adapter`; the emailed ones also need your `sendVerificationRequest`, because denext ships
no mailer.

## Quick start

```ts
// denext.config.ts
import { credentials, denextAuth, google, verifyPassword } from "denext/server";

export default {
  plugins: [
    denextAuth({
      secret: Deno.env.get("AUTH_SECRET")!, // HMAC secret (string | string[] to rotate)
      canonicalOrigin: "https://example.com", // required in prod (stable redirect_uri)
      providers: [
        google({ clientId: G_ID, clientSecret: G_SECRET }),
        credentials({
          authorize: async ({ email, password }) => {
            const row = findUser(email); // may be undefined — verify still does full work
            const ok = await verifyPassword(password ?? "", row?.password_hash ?? "");
            return ok && row ? { id: String(row.id), name: row.name, email } : null;
          },
        }),
      ],
    }),
  ],
};
```

`secret` must be at least 32 characters (shorter warns in development and **throws in
production**) and accepts an array to rotate — every secret verifies, the first one
signs. `canonicalOrigin` warns in development and throws in production: without it the
OAuth `redirect_uri` and the same-origin checks derive from the attacker-controllable
`Host` header. An OAuth provider whose `clientId` / `clientSecret` is empty — or the
literal string `"undefined"`, which a missing `Deno.env.get("…")!` produces — is refused
at config time rather than failing every login later.

With an `adapter` that stores password hashes, `credentials()` needs no `authorize` at
all — see [Password sign-in without an `authorize`](#password-sign-in-without-an-authorize).

Read the session anywhere on the server with `auth()`, and gate routes with
`requireAuth()`:

```tsx
import { auth, requireAuth } from "denext/server";

// A Server Component
export default async function Account() {
  const session = await auth();
  if (!session) return <a href="/auth/signin/google">Sign in</a>;
  return <p>Hello {session.user.name}</p>;
}

// middleware.ts — redirect anonymous users to sign-in
export async function middleware(request: Request) {
  return await requireAuth(request); // Response (redirect) or null to continue
}
export const config = { matcher: ["/dashboard/:path*"] };
```

In a typed route handler, `requireSession()` is the `createApi()` middleware form — it
runs before validation, so a rejected caller never reaches a schema:

```ts
// app/api/me/route.ts
import { createApi, requireSession } from "denext/server";

export const GET = createApi().use(requireSession()).define(
  { response: MeSchema },
  ({ ctx }) => loadProfile(ctx.session.user.id),
);
```

On the client, the familiar NextAuth-style surface:

```tsx
"use client";
import { SessionProvider, signIn, signOut, useSession } from "denext";

function UserMenu() {
  const { user, status } = useSession();
  if (status === "loading") return null;
  return user
    ? <button onClick={() => signOut()}>Sign out {user.name}</button>
    : <button onClick={() => signIn("google")}>Sign in</button>;
}
```

### The endpoints

Every path is relative to `basePath` (default `/auth`).

| Endpoint              | Method      | What it does                                                                                                                                                         |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/session`            | GET         | `{ user, expires }` (or nulls). `no-store`. The sliding-expiry path. Rate-limited.                                                                                   |
| `/providers`          | GET         | The configured providers' `id` + `type` (and an email provider's `name`) — never client ids, secrets or endpoints.                                                   |
| `/signin/:provider`   | GET         | Starts the OAuth flow (PKCE + `state` + `nonce`). Rate-limited per client IP.                                                                                        |
| `/callback/:provider` | GET or POST | By provider type: GET is the OAuth callback and the magic-link click; POST is the Credentials sign-in and the email send / redeem. A verb the type lacks is a `405`. |
| `/signout`            | POST        | Clears the cookie (and the store record). Same-origin only.                                                                                                          |
| `/tokens`             | POST, GET   | Mint / list bearer API tokens. Cookie session only.                                                                                                                  |
| `/tokens/:id`         | DELETE      | Revoke one of your own tokens. Cookie session only.                                                                                                                  |
| `/verify`             | GET, POST   | Redeem an email-verification token — the emailed link (GET) or a form / JSON body.                                                                                   |
| `/reset`              | POST        | Request a password-reset link. One answer for every address.                                                                                                         |
| `/reset/confirm`      | POST        | `{ email, token, password }`: set the new password.                                                                                                                  |
| `/mfa`                | POST        | Finish a pending sign-in with a TOTP or backup code.                                                                                                                 |
| `/mfa/enroll`         | POST        | Start a TOTP enrollment: `{ secret, uri }`.                                                                                                                          |
| `/mfa/confirm`        | POST        | Confirm the enrollment; the backup codes come back once.                                                                                                             |
| `/mfa/disable`        | POST        | Remove the factor, given a fresh second factor.                                                                                                                      |

A row claims only its own verb, so `GET {basePath}/reset` and `GET {basePath}/mfa` fall
through to your app — that is where a reset link and `pages.mfa` can land. The account rows
exist only when the adapter can run them — `/verify` and `/reset*` need the
verification-token group (`/reset*` also `setCredential`), `/mfa*` the whole MFA group —
and are otherwise a plain 404, like `/tokens`.

`examples/auth` is a runnable app with adapter-backed credentials sign-in (scrypt-hashed
passwords in `node:sqlite`, no `authorize`), the rate-limited login, revocable sessions and
"sign out everywhere", email verification, password reset, a magic sign-in link and TOTP
two-factor with backup codes — and it works with JavaScript disabled, which CI asserts.
Every emailed flow runs end to end with no mail server: its development
`sendVerificationRequest` keeps each message for a dev-only `/dev/outbox` page (a 404 in
production, where that mailer refuses to send). See
[examples/auth](https://github.com/Brainwires/denext/tree/main/examples/auth).

## Providers

Fifteen presets ship in `denext/server`. Every OAuth preset takes
`{ clientId, clientSecret, scopes? }`; `scopes` replaces the defaults rather than adding
to them.

| Provider        | Factory            | Extra options                          | Notes                                                                                                      |
| --------------- | ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Google          | `google()`         | —                                      | OIDC. Endpoints pinned (they live on a sibling host), so no discovery.                                     |
| GitHub          | `github()`         | —                                      | OAuth. Reads `/user` + `/user/emails`; only a _verified_ address reaches the session.                      |
| Microsoft Entra | `microsoftEntra()` | `tenant` (required)                    | OIDC v2.0. Single-tenant only — see the note below.                                                        |
| Apple           | `apple()`          | —                                      | OIDC, `openid` scope only — see the note below.                                                            |
| Discord         | `discord()`        | —                                      | OAuth. An unverified address is dropped like `email_verified: false`.                                      |
| GitLab          | `gitlab()`         | `baseUrl` (default `gitlab.com`)       | OIDC. Self-managed must be `https:` at the host root.                                                      |
| Slack           | `slack()`          | —                                      | OIDC ("Sign in with Slack").                                                                               |
| Auth0           | `auth0()`          | `domain` (required)                    | OIDC. The issuer keeps Auth0's trailing slash; `iss` is compared exactly.                                  |
| Okta            | `okta()`           | `domain`, `authorizationServer`        | OIDC, custom authorization server (default `"default"`).                                                   |
| Keycloak        | `keycloak()`       | `baseUrl`, `realm` (both required)     | OIDC, the Keycloak 17+ `/realms/<realm>` layout.                                                           |
| Facebook        | `facebook()`       | —                                      | OAuth, Graph v19.0. Graph never asserts verification, so `emailVerified` is `undefined`.                   |
| Generic OIDC    | `oidc()`           | `issuer` (required), endpoints         | Discovery or explicit endpoints — see below.                                                               |
| Credentials     | `credentials()`    | `authorize` (optional with an adapter) | Email/password or anything custom. Rate-limited by default.                                                |
| Magic link      | `magicLink()`      | `id`, `name`, `allowSignUp`            | Passwordless: mails a single-use sign-in link — see [below](#passwordless-magic-links-and-one-time-codes). |
| Email code      | `emailOtp()`       | `id`, `name`, `allowSignUp`            | Passwordless: mails a one-time numeric code.                                                               |

A `domain` / `baseUrl` is validated before it is interpolated: `https:` only, host only,
no credentials, path, query or fragment. A `tenant` / `realm` /
`authorizationServer` must match `[A-Za-z0-9._-]` (1–128 chars), so nothing can escape
the URL template.

### The generic OIDC provider

```ts
import { oidc } from "denext/server";

// Discovery: issuer only — endpoints come from the well-known document.
oidc({ issuer: "https://idp.example.com", clientId, clientSecret });

// Static: all three endpoints pinned by hand.
oidc({
  issuer: "https://idp.example.com",
  authorizationUrl: "https://idp.example.com/authorize",
  tokenUrl: "https://idp.example.com/token",
  jwksUrl: "https://idp.example.com/jwks",
  clientId,
  clientSecret,
});
```

Passing _some_ of `authorizationUrl` / `tokenUrl` / `jwksUrl` throws: it would silently
mix a hand-written endpoint with a discovered one. `id` defaults to `"oidc"` — set it
when you configure more than one.

> [!NOTE]
> Two presets have limits worth knowing before you wire them up. **Apple** requests
> `openid` only: Apple returns `name` / `email` just once and only over
> `response_mode=form_post`, a POST callback the auth router does not accept, so asking
> for either scope throws rather than shipping a login that breaks. An Apple session
> therefore carries the `sub` and no email, and `clientSecret` must be the ES256
> client-secret **JWT** you mint from your Apple key. **Microsoft Entra** requires a
> specific `tenant` (a GUID or a verified domain): the multi-tenant aliases `common`,
> `organizations` and `consumers` are refused, because their discovery document declares
> the template issuer `https://login.microsoftonline.com/{tenantid}/v2.0` while the
> `id_token` carries the tenant-specific one, and denext compares `iss` by exact match.

## OIDC discovery and key caching

Seven presets carry both their documented static endpoints **and** `discovery: { issuer }`
— `microsoftEntra()`, `apple()`, `gitlab()`, `slack()`, `auth0()`, `okta()` and
`keycloak()` — so a provider that rotates an endpoint is picked up without a denext
release, and `oidc()` discovers whenever you give it an issuer and no endpoints.
`google()` is the OIDC preset that does **not** discover: its endpoints live on a sibling
host, so they stay pinned (its `issuer` is still checked against the `id_token`'s `iss`).
`github()`, `discord()` and `facebook()` are plain OAuth with no discovery document at
all. Discovery is a network document that decides where denext sends a client
secret and takes signing keys from, so it is treated as hostile until proven otherwise:

- the request is pinned to the **issuer's own host** (on top of the SSRF-safe
  `safeFetch`, which already refuses loopback and private addresses);
- the document's `issuer` must equal the configured one **byte for byte**;
- every endpoint must be `https:` and live on the issuer's host, or on a host the app
  listed in the provider's `allowedHosts`;
- a discovered document wins over statically pinned endpoints, but a provider that pins
  them keeps working when discovery fails — and nothing throws a raw network error into
  the sign-in path: every refusal is a stable code the routes turn into `?error=config`;
- a successful document is cached per issuer for its `Cache-Control: max-age` (one hour
  by default, clamped to between one minute and 24 hours); a **failure is never cached**,
  and a document is vetted before it is cached, never after;
- concurrent misses for the same issuer share **one** in-flight request, so fifty cold
  logins at once are one fetch rather than fifty.

Signing keys are cached on exactly the same terms, per JWKS URL. A key set used to be
refetched on every single login; now a miss refetches **once** and then throttles to at
most one attempt per minute per URL — the `kid` that triggers a refetch comes out of an
attacker-supplied `id_token` header, so an unbounded "refetch on unknown kid" would be a
free amplifier pointed at the provider. Concurrent misses for one JWKS URL share a single
in-flight fetch, the same way discovery does. Nothing about verification is weakened: an
unsigned or `alg: none` token is still refused no matter how many keys the cache holds.

### `strictAudience`

An `id_token` whose `aud` names audiences besides this client is refused unless it also
carries an `azp` naming this client, and any `azp` present must name this client
(RFC 7519 §4.1.3, OIDC Core §3.1.3.7 step 4). This is **on by default** for every
provider. Set `strictAudience: false` on a provider only when it legitimately mints
multi-audience tokens without an `azp` — it is the documented escape hatch, not a
workaround for a confusing error.

## Sessions

```ts
denextAuth({
  // …
  session: {
    strategy: "cookie", // or "database"
    maxAge: 60 * 60 * 24 * 7, // 7 days (the default)
    updateAge: 60 * 60, // slide the expiry once a session is an hour old; 0 = never
  },
});
```

`"cookie"` (the default) keeps the whole payload in the signed cookie: stateless,
multi-replica-safe, and only expiry ends it. `"database"` stores the payload server-side
and puts only a random id in the cookie, so sessions are revocable. It needs somewhere
to put them — either `sessionStore` or an `adapter` that exposes `sessions` — and
**throws at config time** when neither is present, because an app that asked for
revocable sessions and silently didn't get them is a security surprise, not a default.
An explicit `sessionStore` always wins over an adapter's — configuring both, pointing at
different stores, warns through the logger. `session.maxAge` overrides the legacy
top-level `maxAge`, which still works.

### Sliding expiry

With `session.updateAge` set, a session that has aged past that threshold is re-issued
with a full `maxAge` from now, so an active user is never logged out mid-session while an
idle one still expires on time. A store-backed session keeps the **same** id (fixation is
already prevented by minting a fresh id at login), and a half-authenticated session is
never extended.

There is **no absolute ceiling**: a session that keeps being used keeps being extended, by
design. End one with revocation (or a shorter `maxAge`), not by waiting for a cap that
does not exist.

A store-backed refresh goes through `SessionStore.update` — **write only if the record is
still there** — never `create`, which is an upsert: a session revoked between this
request's read and its refresh would otherwise come back with a full fresh lifetime. So
sliding expiry **requires a store that implements `update`**. One that does not simply
never slides its sessions forward (they still expire on their original schedule) and says
so once through the logger.

Only a path that still owns its response can set a cookie. So the refresh happens on
`GET {basePath}/session`, inside `requireAuth()` and `requireSession()`, and in the
explicit `updateAuthSession()` — and **never** inside a bare `auth()`, where a
`Set-Cookie` written after a streamed response has flushed would be dropped silently. A
`Set-Cookie` written inside a typed-API sub-request (a batched call, an in-process client
call) is carried back onto the parent response rather than lost with the child.

```ts
import { updateAuthSession } from "denext/server";

// In a Server Action or a route handler — the refreshed cookie rides this response.
const session = await updateAuthSession(); // AuthSession | null
```

On the client, `refetchInterval` on `SessionProvider` polls `GET {basePath}/session`,
which is what keeps an active user's expiry sliding forward.

### Revocation

```ts
import { denextAuth, revokeAllSessions, revokeSession, sqliteSessionStore } from "denext/server";

denextAuth({
  // …
  sessionStore: sqliteSessionStore({ path: ".denext/sessions.db" }), // or inMemorySessionStore()
});

// After a password change — "sign out everywhere":
await revokeAllSessions(session.user.id);
// "Sign out this device" (session.sessionId is set when store-backed):
await revokeSession(session.sessionId!);
```

Both throw when sessions are stateless, rather than pretending to revoke something. Both
fire the `sessionRevoked` event. Anything holding a resource is released on server drain
through the plugin teardown seam — a closable session store **and** a closable `adapter`,
so a `sqliteAuthAdapter` no longer keeps its file handle for the life of the process.

> [!NOTE]
> A store is per node: `sqliteSessionStore` is a local file and `inMemorySessionStore` a
> per-process map, so a session created on one replica is invisible to the others.
> Running several replicas? Point them all at one shared store — implement `SessionStore`
> (`create` / `get` / `delete` / `deleteByUser`, plus `update` for sliding expiry and an
> optional `close`) over Redis or Postgres. Stateless sessions need nothing shared.

### The session payload

Sessions issued now carry `v: 2`, `issuedAt` (epoch seconds — re-stamped by every slide,
so with sliding expiry on it is the last re-issue, not the sign-in) and `amr` (RFC 8176
authentication-method references) alongside `user`, `provider` and `expiresAt`, plus
`mfaPending` while a second factor is still owed. `amr` records how the user got in: `pwd`
(a password), `ext` (an OAuth / OIDC provider), `email` (a magic link) or `otp` (an emailed
code), and after a step-up `totp` or `bcp` (a backup code) as well. The cookie name, signing secret and MAC domain are unchanged,
so a **cookie issued by an older denext keeps verifying**: a missing `issuedAt` is
inferred from `expiresAt - maxAge`, a missing `amr` reads as `[]`, and a missing
`mfaPending` means the session is complete. Nobody is logged out by upgrading.

## Database adapter

Without an adapter, denext auth is the stateless OAuth/Credentials layer it has always
been, and `session.user.id` is whatever the provider's `profile` mapper returned. With
one, a sign-in resolves (or creates) a stored user, and **`session.user.id` becomes the
adapter's id** — that is the opt-in change an adapter makes.

```ts
import { denextAuth, sqliteAuthAdapter } from "denext/server";

denextAuth({
  // …
  adapter: sqliteAuthAdapter({ path: "auth.db" }),
});
```

`inMemoryAuthAdapter()` is the test double and the zero-setup dev option: bounded maps
(`maxUsers`, default 10 000, oldest evicted), nothing survives a restart, nothing is
shared between replicas. `sqliteAuthAdapter({ path })` is the durable one, on Deno's
built-in `node:sqlite` — real SQLite, zero npm. It defaults to `auth.db` in the working
directory (user data, deliberately not under `.denext/`, which the build owns), and
`":memory:"` gives a private database that dies with the process.

### The contract

Every method may be sync or async — the exported alias for that is `MaybePromise<T>`
(renamed from `Await<T>` in 2.5) — timestamps are **epoch seconds** (never `Date`), and a
miss is `undefined` (never `null`). The users and accounts groups are required; everything
else is optional and gates the feature that needs it.

| Group               | Methods                                                                                   | Gates                                               |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Users (required)    | `createUser`, `getUser`, `getUserByEmail`, `getUserByAccount`, `updateUser`               | Adapter-backed sign-in at all                       |
| Accounts (required) | `linkAccount` — plus optional `unlinkAccount`, `listAccounts`                             | Account linking                                     |
| Verification tokens | `createVerificationToken`, `useVerificationToken`                                         | Email verification, reset, magic links, email codes |
| Credentials         | `getCredential`, `setCredential`                                                          | `credentials()` without `authorize`, password reset |
| API tokens          | `createApiToken`, `getApiTokenByHash`, `touchApiToken`, `revokeApiToken`, `listApiTokens` | Bearer tokens and `/auth/tokens`                    |
| MFA                 | `getMfa`, `setMfa`, `consumeBackupCode`, `claimTotpStep`                                  | TOTP two-factor and backup codes                    |
| Sessions, lifecycle | `sessions?: SessionStore`, `close?()`                                                     | `session.strategy: "database"`, drain               |

Three methods are **consume-once** and must be atomic against concurrent callers — a
compare-and-delete or conditional update inside one transaction, not a read followed by a
write. Two racing requests must see exactly one success:

- `useVerificationToken` — delete-and-return. An expired token is consumed too but
  resolves `undefined` (fail closed), never left to be retried.
- `consumeBackupCode` — walk the stored hashes, `await` the caller's constant-time
  comparison, and remove the first match inside the same critical section.
- `claimTotpStep` — succeed only when the step is strictly greater than the stored one,
  and store it in the same operation.

A non-atomic implementation turns each of them into a replay window. The full contract,
with every record type, is
[`src/server/auth/adapter.ts`](https://github.com/Brainwires/denext/blob/main/src/server/auth/adapter.ts);
the in-memory implementation is the executable reference, and a shared contract suite
runs against both shipped adapters.

### The SQLite schema

Six `auth_`-prefixed tables: `auth_users` (with a unique index on the lower-cased email,
`WHERE NOT NULL`, so there is one account per address and any number of address-less
users), `auth_accounts` (primary key `(provider, provider_account_id)`),
`auth_verification_tokens` (primary key `(identifier, purpose)`, so re-sending a link
invalidates the previous one — a mailbox can never hold two working reset links),
`auth_credentials`, `auth_api_tokens` (unique on the token hash) and `auth_mfa`.

Schema policy: `CREATE TABLE IF NOT EXISTS` on every open, then every declared column a
table is missing is added with `ALTER TABLE … ADD COLUMN`, decided by
`PRAGMA table_info`. There is no migration framework, no column is ever dropped or
retyped, and a denext upgrade never rewrites your rows — schema changes are additive by
construction.

A unique index cannot be created over a table that already violates it — an `auth_users`
populated before 2.5 may hold two rows whose emails differ only in case. That failure is
**reported once**, with the query that finds the offending rows, and the adapter runs
without that index; uniqueness is still enforced by the adapter's own check on write.
(Letting it throw meant every open re-ran and re-threw the schema init, so one legacy row
pair turned the whole app into a permanent 500.)

The adapter also exposes `sessions`, a `sqliteSessionStore` driven over the **same**
handle, so one file holds everything. The `sessions` DDL is byte-identical to the
standalone store's, which makes the migration a zero-step one: an app already running
`sessionStore: sqliteSessionStore({ path })` can point `sqliteAuthAdapter({ path })` at
that same file with no migration and **no logout**. It still takes
`session: { strategy: "database" }` to actually use it.

> [!WARNING]
> `sqliteAuthAdapter` is single-node, like the session store: a local file suits one
> instance. Every replica must see the same database, so for multi-replica either mount
> one shared volume or implement `AuthAdapter` over your shared database. TOTP secrets
> are stored in plaintext by construction (a TOTP verifier needs the secret) — protect
> the file itself.

## Account linking rules

Linking runs between the provider round-trip and `callbacks.signIn`, and it is the whole
reason `allowDangerousEmailAccountLinking` exists.

| Situation                                                                                        | Outcome                                              |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| The `(provider, providerAccountId)` is already linked                                            | That user signs in                                   |
| Not linked; the provider asserts a **verified** email and a local user has that address verified | Link the account (fires `linkAccount`)               |
| Not linked; either side's email is **unverified**                                                | **Refused** — `?error=account_not_linked`            |
| Not linked; no local user with that address (or no address at all)                               | Create the user (fires `createUser` + `linkAccount`) |

The refusal is the security-relevant row. Matching on an unverified address means an
attacker who registers a local account with the victim's email — or a provider that hands
out an address it never checked — takes over the victim's account at their next login.
`allowDangerousEmailAccountLinking: true` on a provider opts back in, and is named for
exactly what it is.

A refused link is a redirect to the sign-in page with `?error=account_not_linked`, never
a 500 and never an echo of anything the provider said. For a Credentials POST the same
refusal is the generic `401` a wrong password gets; the reason reaches the app through
the `signInFailed` event and the logger instead.

Two more rules: the built-in mappers **drop** an email the provider marks unverified, so
an app that links by email can never be handed an attacker-chosen address; and when a
login teaches the adapter something new, the stored record still wins for any field it
already has — a user who renamed themselves locally is not renamed back by every login.
With no adapter configured, all of this is a pass-through: the profile the mapper
produced is the session user.

Two sign-ins skip linking, because each proves ownership of the stored record itself: the
[built-in credentials check](#password-sign-in-without-an-authorize) (the password was
verified against that row) and the
[email providers](#passwordless-magic-links-and-one-time-codes) (the mailbox on the user
record was just proven). Neither writes an account row.

**Where the provider's tokens go.** With an adapter configured, the account row stores
whatever the provider returned — access, refresh and id tokens — at rest; that is what an
adapter is for, and `listAccounts` reads them back. They are deliberately **absent from
the `linkAccount` event payload**, which carries identity only: an event handler is an
audit sink, and a credential in an audit line is a leak. (This narrowed the payload — a
2.4 handler that read tokens off the event must read the stored account instead.)

## Password sign-in without an `authorize`

With an adapter that stores password hashes, `credentials()` needs no `authorize` — the
adapter is the password store:

```ts
import { credentials, denextAuth, sqliteAuthAdapter } from "denext/server";

denextAuth({
  // …
  adapter: sqliteAuthAdapter({ path: "auth.db" }),
  providers: [credentials()], // no authorize: verified against the adapter
});
```

The submitted `email` is trimmed, lower-cased and looked up with `getUserByEmail`, and the
`password` is checked against the hash `getCredential` returns, with the configured
[`hasher`](#password-hashing). Every refusal — a missing field, an unknown address, a user
with no password on file, a wrong password — costs exactly one `hasher.verify` (an absent
hash burns the same scrypt work) and is the same generic `401`, counted by the credentials
limiter like any other failure.

The verified record **is** the session user. The check owes no account linking — that
rule guards a provider _asserting_ an address, not a password proven against the very row —
so it writes no `"credentials"` account row, fires no `createUser` or `linkAccount`, and an
unverified email never blocks a correct password. `session.user.id` and `roles` are the
adapter's, `callbacks.signIn` still runs, `amr` is `["pwd"]`, and an enrolled user still
stops at the [second factor](#two-factor-authentication-totp).

Registration stays the app's to write: create the user, then store what the configured
hasher produces (`hashPassword` for the default).

```ts
// A Server Action
const user = await adapter.createUser({ email, name });
await adapter.setCredential!(user.id, await hashPassword(password));
```

A `credentials()` provider with no `authorize` and nothing to verify against — no adapter,
or one without `getUserByEmail` + `getCredential` — makes `denextAuth()` **throw at
construction**, instead of every login quietly answering `401`.

## Email verification and password reset

Both flows mail a single-use link, so they need two things: an adapter with the
verification-token group (`createVerificationToken` + `useVerificationToken`; a reset also
needs `setCredential`), and `sendVerificationRequest` — **denext ships no mailer**. Every
emailed token, from these flows and from the
[passwordless providers](#passwordless-magic-links-and-one-time-codes), goes through that
one function.

```ts
denextAuth({
  // …
  adapter: sqliteAuthAdapter({ path: "auth.db" }),
  sendVerificationRequest: async ({ identifier, url, token, purpose, expiresAt }) => {
    await mailer.send({ to: identifier, purpose, url, code: token, expiresAt });
  },
  pages: { signIn: "/login", verifyRequest: "/check-email" },
  email: { resetPath: "/reset" }, // the reset link opens YOUR page
});
```

`purpose` is `"email"`, `"reset"`, `"magic"` or `"otp"`; `url` is the absolute,
ready-to-click link, and for a one-time code `token` is the code. Inside a request the
mailer runs **after the response** (`after()`), so its latency can't reveal that an
address has an account; a throw is logged — without the token or the link — and never
surfaces, and `verificationRequested` fires only for a delivery that succeeded.

The `email` block tunes every emailed token. Lifetimes are in seconds (a non-finite or
non-positive one falls back to its default), and a link path must be a same-origin path —
one leading `/`, no whitespace or backslash — or `denextAuth()` throws:

| Key            | Default                 | What it sets                                                          |
| -------------- | ----------------------- | --------------------------------------------------------------------- |
| `verifyMaxAge` | `86400` (24 hours)      | How long an email-verification link lives                             |
| `resetMaxAge`  | `3600` (1 hour)         | How long a password-reset link lives                                  |
| `magicMaxAge`  | `600` (10 minutes)      | How long a magic sign-in link lives                                   |
| `otpMaxAge`    | `300` (5 minutes)       | How long an emailed one-time code lives                               |
| `otpDigits`    | `6` (clamped to `6–10`) | How many digits a one-time code has                                   |
| `verifyPath`   | `{basePath}/verify`     | The page a verification link opens — by default the built-in endpoint |
| `resetPath`    | `{basePath}/reset`      | The page a reset link opens — one your app renders                    |

**Verifying an address.** `requestEmailVerification(authConfig, userOrEmail)` mails a link
to `verifyPath?token=…&email=…`; it sends nothing for an address with no account, one
already verified, or a value that isn't exactly one address. Opening it hits
`GET {basePath}/verify`, which sets the user's `emailVerified` (epoch seconds, through
`updateUser`), fires `emailVerified`, and redirects to `pages.verifyRequest` with
`?verified=1` — or, for a wrong, spent or expired token, to `pages.error` with
`?error=invalid_token`. `POST {basePath}/verify` takes the same two fields from a form or
a JSON body, and `verifyEmail(authConfig, { email, token })` is the function underneath (it answers `{ ok: true, user }` or `{ ok: false, error: "invalid_token" }`).
Verifying signs nobody in and leaves the account's password alone — someone else may have
registered the address, so word the mail so that ignoring it is safe.

**Resetting a password.** A form posting `email` to `POST {basePath}/reset` — or
`requestPasswordReset(authConfig, email)` in a Server Action — mails a link to
`resetPath?token=…&email=…`. The auth handler claims only a POST on that path, so the GET
falls through to your page (`app/auth/reset/page.tsx` under the default path), which posts
the new password to `POST {basePath}/reset/confirm`:

```tsx
// app/reset/page.tsx — `email: { resetPath: "/reset" }`
import type { PageProps } from "denext/server";

export default function Reset({ searchParams }: PageProps) {
  return (
    <form method="post" action="/auth/reset/confirm">
      <input type="hidden" name="email" value={String(searchParams.email ?? "")} />
      <input type="hidden" name="token" value={String(searchParams.token ?? "")} />
      <input name="password" type="password" minLength={8} required />
      <button type="submit">Set the new password</button>
    </form>
  );
}
```

The confirm — or `resetPassword(authConfig, { email, token, password })` — hashes the new
password with the configured `hasher`, stores it with `setCredential`, **revokes every
server-side session** of the user (`sessionRevoked`), fires `passwordReset`, and lands on
`pages.signIn` with `?reset=1`. The password must be 8–1024 characters and is checked
**before** the token is touched: a refused one (`invalid_password`) is sent back to
`resetPath` with its link intact, while a bad token (`invalid_token`) goes to `pages.error`.

Every one of these endpoints takes JSON or a plain form: a JSON client gets a JSON body
(`200`, or `400 { error }`), a form a `303`, so both flows work with JavaScript disabled.
The functions take the same config object you passed to `denextAuth()`, like
`requireBearer`. What both flows guarantee:

- **No existence oracle.** A reset request answers the same for every address —
  `{ ok: true }`, or a `303` to `pages.verifyRequest` with `?sent=1` — and an unknown
  address still does comparable work (the token hashing and one adapter round-trip) but
  gets no mail. The functions resolve `{ throttled: false }` alike and throw only for a
  misconfiguration (no mailer, an adapter without the group); `POST /reset` with no mailer
  still answers `200` and reports through `logger.error`.
- **Throttled before the lookup.** Every send spends the per-address budget — 3 per 15
  minutes, plus an IP-wide bucket at ten times that (`rateLimit.verification`) — before
  the address is looked up, so a `429` is as blind to existence as a `200`. The link click
  (`GET {basePath}/verify`) carries the per-IP session-read budget.
- **Tokens are single-use and useless at rest.** 256 bits of CSPRNG entropy, stored only
  as a SHA-256, scoped by `(address, purpose)` — a reset token can never verify an address
  — and redeemed through the adapter's atomic `useVerificationToken`, so a wrong token
  can't burn the real one and a replay fails.
- **One recipient.** The address is trimmed, lower-cased and must be exactly one address;
  a list or a display-name form is refused, never split into several sends.
- **Links are built on `canonicalOrigin`**, never on the `Host` header in production, where
  a forged one would mail a victim a live token pointing at another site. Outside
  production the request's own origin is the fallback.

## Passwordless: magic links and one-time codes

```ts
import { denextAuth, emailOtp, magicLink, sqliteAuthAdapter } from "denext/server";

denextAuth({
  // …
  adapter: sqliteAuthAdapter({ path: "auth.db" }),
  sendVerificationRequest: sendMail, // the same mailer as above
  providers: [magicLink(), emailOtp({ allowSignUp: false })],
});
```

`magicLink()` mails a single-use sign-in link; `emailOtp()` mails a numeric code the user
types. Both are `type: "email"` providers on `{basePath}/callback/:provider` — ids
`"email"` and `"email-otp"` by default, with a display `name` (`"Email"`, `"Email code"`)
that `GET {basePath}/providers` echoes — and both take `{ id?, name?, allowSignUp? }`.
Configuring one without `sendVerificationRequest`, or with an adapter missing
`createVerificationToken`, `useVerificationToken`, `getUserByEmail`, `createUser` or
`updateUser`, makes `denextAuth()` throw.

| Request                                        | What it does                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /callback/email` — `{ email }`           | Mails a link to `/callback/email?token=…&email=…` (10 minutes by default)        |
| `GET /callback/email?token=…&email=…`          | The click: consumes the token, signs the user in, redirects                      |
| `POST /callback/email-otp` — `{ email }`       | Mails a code (6 digits, 5 minutes by default) as `token`; `url` never carries it |
| `POST /callback/email-otp` — `{ email, code }` | Redeems the code (spaces and hyphens ignored) and signs the user in              |

A body carrying a `token` (a magic-link provider — how a JS client redeems) or a `code` (an
email-code provider) redeems; anything else sends. A `callbackUrl` sent along rides in the
magic link. A code provider has no GET — a code is never put in a URL — so a code mail's
`url` opens `pages.verifyRequest` with `?email=`, the page the code is typed into. From the
client:

```ts
await signIn("email", { credentials: { email } }); // { ok: true }, whether or not mail went out
await signIn("email-otp", { credentials: { email, code } }); // { ok: true, user } or { ok: true, mfa: "required" }
```

**Sending answers the same for everyone.** A real send, an unknown address under
`allowSignUp: false`, an invalid value and a list of addresses all get `{ ok: true }` (a
form: a `303` to `pages.verifyRequest`, else `pages.signIn`, with `?sent=1`), because the
address is normalised to exactly **one** address and anything else sends nothing — the
next-auth CVE-2022-35924 class, where a list turned one sign-in into mail to several
inboxes. Only the per-address send budget (3 per 15 minutes, shared with verification and
reset mail) changes the answer, to a `429` that is equally blind to existence.

**Redeeming.** A wrong, spent or expired link or code is one generic
`401 { error: "invalid code" }` — for a form or the link click, a `303` to `pages.error`
(else `pages.signIn`) with `?error=Verification` — and fires `signInFailed` with
`"invalid_credentials"`. Failed codes count against the second-factor budget, 5 per 5
minutes per address plus the IP-wide bucket, and a correct code resets the address count.
A failed magic link counts only in the IP-wide bucket: nobody guesses 256 bits, and a
per-address count would let a stranger lock the owner out of their own link. Codes are
drawn uniformly from the CSPRNG and stored as an HMAC-SHA-256 under the auth `secret` — an
unkeyed hash of a six-digit code is reversed by trying every value, so a leaked table is
useless without the secret — while link tokens are stored as a SHA-256.

**Who signs in.** An existing user signs in as that user. An unknown address, when the
provider allows sign-up (the default), becomes a new, already-verified user — `createUser`
fires and `signIn` carries `isNewUser: true` — with no account row: as in Auth.js, the
address on the user record is the identity. `callbacks.signIn` can still veto the sign-in
(`403`, or `?error=AccessDenied`), and an enrolled user still owes a
[second factor](#two-factor-authentication-totp). The session's `amr` is `["email"]` for a
link and `["otp"]` for a code.

**Pre-account hijacking.** An existing account whose `emailVerified` is unset was set up by
someone who never proved the mailbox — possibly an attacker who registered the victim's
address with a password and is waiting for the victim to sign in by email. So before a
first email sign-in marks that address verified, everything set up without the proof is
retired: the password (replaced with the hash of a random secret — the adapter contract has
no delete), any TOTP factor and its backup codes, every bearer API token and every
server-side session (`sessionRevoked`); then `emailVerified` fires. If any step fails, the
address stays unverified and the redeem gets the generic failure. An account that was
already verified keeps all of it. A stateless cookie session can't be revoked and lives
until it expires — another reason to run a `sessionStore` in production.

> [!WARNING]
> Opening a magic link spends it (Auth.js does the same), so a mail gateway that pre-fetches
> links to scan them can burn one before the user clicks. Where link scanners are common,
> prefer `emailOtp()`.

## Two-factor authentication (TOTP)

A user who enrolls an authenticator app is asked for a code at every sign-in, whatever the
first factor — a password, an OAuth / OIDC provider, a magic link or an emailed code. It
needs an adapter implementing the whole MFA group (`getMfa`, `setMfa`, `consumeBackupCode`
and `claimTotpStep` — both shipped adapters do); without it nobody is ever asked, and the
`/mfa*` endpoints are a plain 404.

```ts
denextAuth({
  // …
  adapter: sqliteAuthAdapter({ path: "auth.db" }),
  pages: { signIn: "/login", mfa: "/mfa" }, // where a sign-in that owes a code goes
  mfa: { required: "enrolled" }, // the default; "always" asks everyone
});
```

| Key           | Default                                   | What it sets                                                                         |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `required`    | `"enrolled"`                              | Who owes a second factor: users with a confirmed one — or, with `"always"`, everyone |
| `issuer`      | `canonicalOrigin`'s host, else `"denext"` | The label an authenticator app shows next to the account                             |
| `window`      | `1` (clamped to `0–2`)                    | How many 30-second steps of clock drift are accepted either side of now              |
| `backupCodes` | `10` (clamped to `0–20`)                  | How many single-use backup codes confirming an enrollment mints                      |
| `freshness`   | `900` (15 minutes)                        | How recent a step-up must be for `/mfa/disable` to accept it without a code          |

**Enrollment** runs from a signed-in session in two steps — through the endpoints (which
answer JSON only: a secret never rides a redirect) or the same functions in a Server
Action:

1. `POST {basePath}/mfa/enroll` / `enrollTotp(authConfig, user)` mints a 160-bit secret,
   stores it **unconfirmed**, and returns `{ secret, uri }` — the base32 secret for manual
   entry and the `otpauth://totp/…` URI (SHA-1, 6 digits, 30 seconds; the account label is
   the user's email, else their id) to render as a QR code. Enrolling again replaces an
   unconfirmed enrollment; a confirmed factor is a `409` (`null` from the function) until it
   is disabled.
2. `POST {basePath}/mfa/confirm` with `{ code }` / `confirmTotp(authConfig, user, code)`
   checks a first code from the app, marks the factor confirmed and returns
   `{ ok: true, backupCodes }` — `mfa.backupCodes` single-use codes formatted `xxxxx-xxxxx`,
   in plaintext **exactly once**, stored only as `hasher` hashes. Show them then.

```ts
"use server";
import { auth, confirmTotp, enrollTotp } from "denext/server";
import { authConfig } from "../lib/auth-config.ts";

export async function startEnrollment() {
  const session = await auth();
  return session ? await enrollTotp(authConfig, session.user) : null; // { secret, uri } | null
}

export async function confirmEnrollment(code: string) {
  const session = await auth();
  return session ? await confirmTotp(authConfig, session.user, code) : { ok: false };
}
```

Unlike the endpoints, the functions spend no attempt budget, so a Server Action that checks
codes must throttle itself (`examples/auth` carries its own limiter for exactly this).

**The step-up.** When a first factor succeeds for a user who owes a code, the session is
minted **pending**: it lasts 15 minutes (never more than `maxAge`), is never slid forward,
and `auth()` returns `null` for it — so `requireAuth` redirects to `pages.mfa` (else the
sign-in page) with a `callbackUrl`, `requireSession` answers `401`, Live `authorize` and
Server Actions refuse, and `/tokens` mints nothing. `GET {basePath}/session` answers
`{ user: null, mfa: "required" }`, which `useSession()` reports as `"mfa-required"`. The
sign-in itself answers `{ ok: true, mfa: "required" }` to a JSON client or redirects to
`pages.mfa`, and `signIn` fires only once the step-up completes. Your `pages.mfa` page
reads the pending session with `pendingMfaSession()` and posts the code:

```tsx
// app/mfa/page.tsx — `pages: { mfa: "/mfa" }`
import { redirect } from "denext";
import { type PageProps, pendingMfaSession } from "denext/server";

export default async function Mfa({ searchParams }: PageProps) {
  if (!(await pendingMfaSession())) redirect("/login");
  return (
    <form method="post" action="/auth/mfa">
      <input type="hidden" name="callbackUrl" value={String(searchParams.callbackUrl ?? "/")} />
      <input name="code" autoComplete="one-time-code" required />
      <button type="submit">Verify</button>
    </form>
  );
}
```

Keep that page out of your `requireAuth` matcher: a pending session never passes
`requireAuth`.

`POST {basePath}/mfa` takes a TOTP code or a backup code (the hyphen is optional). A right
one mints a **fresh**, complete session — the pending one is discarded (its store record
deleted), never upgraded in place, so there is nothing to fixate — with `amr` extended by
`totp` or `bcp`, fires `signIn`, and answers `{ ok: true, user }` or a `303` to the
`callbackUrl`. A wrong one is a `401`, or for a form a `303` back to `pages.mfa` with
`?error=CredentialsSignin`, and fires `signInFailed` with `"invalid_mfa_code"`. The
endpoint serves only a pending session: none is a `401`, a complete one a `403`. Under
`mfa.required: "always"` a user with no factor enrolls from the pending session —
`/mfa/enroll`, then `/mfa/confirm`, whose answer also carries the new session's `user`,
because confirming completes the step-up.

**Every code works once.** A TOTP code is accepted within ±`mfa.window` steps, and its step
is then claimed through the adapter's atomic `claimTotpStep`, so it can't be presented
twice — not even to confirm an enrollment and then step up with it. A backup code is spent
through the atomic `consumeBackupCode`. Every code check on `/mfa`, `/mfa/confirm` and
`/mfa/disable` spends one unit of the per-user budget — 5 per 5 minutes (`rateLimit.mfa`),
plus an IP-wide bucket at ten times that — and **every** attempt counts, not only
failures, so a correct guess can't reset the counter.

**Disabling.** `POST {basePath}/mfa/disable` needs a complete session **and** a fresh
second factor: a `code` that verifies now, or — with no code — a session whose own step-up
(`amr` `totp` / `bcp`) is at most `mfa.freshness` seconds old. That shortcut never applies
with sliding expiry on: every slide re-stamps `issuedAt`, so with `session.updateAge > 0`
the caller must always send a code. Anything else is a `403`. Disabling writes an empty,
unconfirmed record in the user's place (the adapter's MFA group has no delete), which reads
as "not enrolled" everywhere. `disableTotp(authConfig, userId)` does the same with no
freshness check — gate it yourself.

For a settings page, `mfaStatus(authConfig, userId)` answers
`{ enrolled, confirmed, backupCodesRemaining }`, and
`verifySecondFactor(authConfig, userId, code)` checks a code (claiming or spending it) and
answers `"totp"`, `"bcp"` or `null`. The RFC 6238 primitives underneath are exported too:
`generateTotpSecret()`, `totpAuthUri({ secret, account, issuer })`,
`verifyTotp(secret, code, { window })` — which returns the matched `step` and does **not**
stop a replay, so claim it — plus `generateBackupCodes(hasher, count)` and
`backupCodeMatcher(hasher, code)`.

## Roles and authorization

Roles live on the session user as `AuthUser.roles?: string[]`. Populate them in
`callbacks.signIn` / `callbacks.session`, or from an adapter user record. Every check is
**any-of**, and a check against a session with no roles always refuses.

The empty case fails **closed**: `hasRole(session, [])` and `requireAuth(request,
{ role: [] })` refuse, because an empty list says "no role can satisfy this", not "no
requirement". Only an **absent** `role` means unrestricted.

```ts
// middleware.ts
export async function middleware(request: Request) {
  return await requireAuth(request, { role: ["admin", "editor"] });
}
```

`requireAuth(request, { role })` runs four checks in order: no session → the sign-in
page; a session still owing a second factor → `pages.mfa` (falling back to the sign-in
page); `role` not held → the sign-in page with `?error=forbidden`; then
`callbacks.authorized`. All four redirect with a `callbackUrl` back to the target.

`requireSession({ role })` is the API-route equivalent and answers status codes instead —
`401 unauthorized` with no session, `403 forbidden` when the role is not held, so "who
are you" stays distinguishable from "may you".

For anything richer than a role list, `callbacks.authorized` sees the request:

```ts
denextAuth({
  // …
  callbacks: {
    authorized: ({ session, request }) => {
      if (new URL(request.url).pathname.startsWith("/admin")) {
        return session.user.roles?.includes("admin") ?? false;
      }
      return true; // or return your own Response — it is passed through verbatim
    },
  },
});
```

`true` allows, `false` refuses exactly as a missing session does, and a returned
`Response` (a 403 page, a JSON envelope) is returned verbatim. An `authorized` callback
that **throws is treated as a refusal** — an authorization hook that crashes must fail
closed, never open.

## Events and logging

`events` are side-effect hooks on the lifecycle. Each handler may be async and is
awaited, so an audit row is written before the response is built.

| Event                   | Payload                                  | Fires when                                                            |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `signIn`                | `{ user, provider, isNewUser? }`         | A session was issued                                                  |
| `signOut`               | `{ session }` (`null` if there was none) | `/signout` cleared the session                                        |
| `signInFailed`          | `{ provider?, reason, ip? }`             | An attempt was refused                                                |
| `sessionRevoked`        | `{ sessionId?, userId? }`                | `revokeSession` / `revokeAllSessions` ran                             |
| `createUser`            | `{ user }`                               | An adapter user record was created                                    |
| `linkAccount`           | `{ user, account }`                      | A provider account was linked to an existing user                     |
| `verificationRequested` | `{ identifier, purpose, expiresAt }`     | A verification, reset, magic-link or code mail went to the mailer     |
| `emailVerified`         | `{ user }`                               | An address was proven — a verification link, or a first email sign-in |
| `passwordReset`         | `{ user }`                               | A reset token set a new password (the sessions are already revoked)   |

`reason` is a stable machine-readable string an app can route on:
`"invalid_credentials"` (a wrong password, or a wrong, spent or expired email link or
code), `"invalid_mfa_code"` (a wrong TOTP or backup code at the step-up),
`"rate_limited"`, `"access_denied"`, `"account_not_linked"`, `"adapter_error"` (the
persistence step threw — see below), or an OAuth failure code such as `"oauth_failed"`,
`"config"` or `"invalid_state"`.

`verificationRequested` never carries the token or the link, and fires only for a delivery
that succeeded. A sign-in that stops at a second factor fires `signIn` only when the
step-up completes.

Two payload fields the event has always declared are now actually populated. `ip` carries
the client bucket the limiter counted the attempt against — present on the rate-limited
routes (the credentials POST, the sign-in start, the email link and code redeem, and the
second-factor steps), IPv4 as seen and an IPv6 client as
its **/64 prefix**, which is what the limiter itself counts — so "one address, many
failures" is visible to an alerting pipeline. And `signIn` carries `isNewUser: true` when
that sign-in created the adapter's user record (always `false` without an adapter, which
creates nothing).

An adapter that throws while persisting a credentials sign-in — a UNIQUE race between two
concurrent first logins, a database that went away — is contained: the caller gets the
**same generic `401`** a wrong password gets (answering anything else would disclose that
the address exists), the exception reaches `logger.error`, and `signInFailed` fires with
`reason: "adapter_error"`.

**A handler that throws cannot change the HTTP result.** The throw — sync or async — is
caught and routed to `logger.error`; an event handler can never fail the sign-in it is
observing.

`logger` has three optional methods, `debug`, `warn` and `error`. On the **request path**
it defaults to silence: nothing a sign-in swallows is printed unless you supply a logger.
It is where those failures resurface — a provider round-trip that failed behind a generic
`?error=oauth_failed`, an adapter write that threw, a `touchApiToken` a read replica
refused, an unparseable request body.

Config-time and boot-time problems are **not** routed through it and still print: a
`canonicalOrigin` with no `trustForwardedHeaders` decision, requests arriving from a local
peer with `x-forwarded-for` while that flag is off, a `sqliteAuthAdapter` index that could
not be created, a `strictAudience` refusal. Those are operator warnings about the
deployment, not per-request noise, and each is printed once per process.

```ts
denextAuth({
  // …
  logger: { error: (message, error) => reportToSentry(message, error) },
  events: {
    signIn: ({ user, provider, isNewUser }) => audit("sign-in", { user, provider, isNewUser }),
    signInFailed: ({ provider, reason, ip }) => audit("sign-in-failed", { provider, reason, ip }),
  },
});
```

## Base path and cookies

```ts
denextAuth({
  // …
  basePath: "/account/auth", // default "/auth"
  cookies: {
    session: { name: "denext_auth", hostPrefix: true, sameSite: "Lax", path: "/" },
    transaction: { name: "denext_auth_tx" },
  },
});
```

`basePath` gets a leading slash added and a trailing one stripped, and must be one or
more non-empty URL-safe segments. `"/"` is refused — the handler would then claim every
request on the site — and so is any `.` or `..` segment: a dot is URL-safe, but
`"/auth/.."` is not a place, and the handler would claim (and the routes advertise) a
prefix that resolves somewhere else entirely. Client-side, pass the same prefix to `SessionProvider` /
`signIn` / `signOut` via their `basePath` prop or option.

Two cookies exist: the session cookie (default `__Host-denext_auth`) and the short-lived
OAuth transaction cookie that carries the PKCE verifier, `state` and `nonce` (default
`__Host-denext_auth_tx`). The name you configure is the one _before_ the prefix; a name
must be a valid cookie token: letters, digits, or any of the RFC 6265 punctuation
`!#$%&'*+-.^_` plus a backtick, a pipe and a tilde.

`hostPrefix` is **on by default** and leaving it on is strongly recommended: `__Host-`
forces `Secure` + `Path=/` + no `Domain`, which is what stops a sibling subdomain reading
or shadowing the cookie. `sameSite` defaults to `"Lax"` (the OAuth callback is a
top-level GET) and `path` to `"/"`, which `__Host-` forces anyway. `Secure` is pinned
even behind a proxy that omits `x-forwarded-proto`.

> [!WARNING]
> Changing a cookie name — or turning `hostPrefix` off — renames the cookie, which logs
> every existing session of that kind out **once**, on the deploy.

### Redirect targets (`pages`)

`pages` decides where the flow sends the browser when no `callbackUrl` says otherwise.

| Key             | Default  | Used for                                                                                                                                                                                                  |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn`        | `/`      | The sign-in page — also where a refused guard redirects, with `?error=`                                                                                                                                   |
| `afterSignIn`   | `/`      | Where a completed sign-in lands                                                                                                                                                                           |
| `afterSignOut`  | `/`      | Where a sign-out lands                                                                                                                                                                                    |
| `mfa`           | `signIn` | Where `requireAuth` sends a session that still owes a second factor                                                                                                                                       |
| `verifyRequest` | —        | The "check your email" page: `/reset` and an email-provider send land here with `?sent=1`, `/verify` with `?verified=1`, and a code mail's `url` opens it with `?email=`                                  |
| `error`         | —        | Where a failed emailed flow lands: a bad verification or reset token (`?error=invalid_token`), a failed magic-link or code redeem (`?error=Verification`), a vetoed email sign-in (`?error=AccessDenied`) |

The fallbacks differ by flow. The verification and reset endpoints fall back from
`verifyRequest` to `afterSignIn` (and from `error` to that notice page); the email
providers fall back from both to `signIn`. The OAuth callback and the guards never use
`error` — their `?error=` codes still go to `signIn`. A completed reset lands on `signIn`
with `?reset=1`, and a refused step-up code goes back to `mfa` with
`?error=CredentialsSignin`.

## Rate limiting

Brute-force protection is **on by default**, as five fixed-window limiters built from one
`rateLimit` config:

| Limiter       | Counts                                                                                                       | Key                                                       | Default       |
| ------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------- |
| Credentials   | _Failed_ `POST {basePath}/callback/:provider`                                                                | Client IP + submitted identifier, lower-cased             | 5 per 15 min  |
| Sign-in start | _Every_ `GET {basePath}/signin/:provider`                                                                    | Client IP                                                 | 20 per 15 min |
| Session read  | _Every_ `GET {basePath}/session`                                                                             | Client IP                                                 | 60 per minute |
| Email sends   | _Every_ mail request — `/reset`, an email-provider send, `requestEmailVerification` / `requestPasswordReset` | Submitted address, plus client IP at 10×                  | 3 per 15 min  |
| Second factor | _Every_ code check on `/mfa`, `/mfa/confirm`, `/mfa/disable`; _failed_ email-code and magic-link redeems     | User id (email codes: the address), plus client IP at 10× | 5 per 5 min   |

Past the limit the endpoint answers a generic `429` with `Retry-After` — like the generic
`401`, it never reveals whether the account exists — and a successful credentials sign-in
resets its key. The credentials limiter also keeps a looser IP-wide bucket (ten times the
configured `max`), so one IP cannot walk a list of identifiers. The sign-in-start limiter
counts every hit rather than only failures, because the cost being bounded is the work
done for an unauthenticated caller: minting a PKCE verifier, a `state`, a nonce and a
signed transaction cookie, plus provider-id probing.

The session-read limiter exists for the same reason: `GET {basePath}/session` is
unauthenticated work — a cookie verification plus a store read, and possibly a re-issue —
and 60 per minute is far above any sane `SessionProvider` poll.

The two newer budgets count per **subject**. The send budget is spent before the address is
looked up, so a throttled unknown address answers exactly like a throttled real one, and an
address has one budget across every kind of mail (verification, reset, magic link, code).
The second-factor budget counts every code check, not only failures, so a correct guess
can't reset it. Email redeems count only their failures: a wrong code against the address
(a correct one resets it), a wrong magic link only against the IP-wide bucket — a 256-bit
token can't be guessed, and a per-address count would let a stranger lock the owner out.

The identifier is taken from `email`, `username`, `login` or `identifier`. The client IP
is the socket peer; behind a proxy set `trustForwardedHeaders: true` so the proxy's
`x-forwarded-for` (last hop, never the first) is used instead — the header is never
trusted by default, since without a proxy anyone can set it. An IPv6 client is normalised
and bucketed by **/64**, so a client cannot walk its own prefix for a fresh budget.

Two behaviours worth knowing:

- **An undeclared proxy disables the per-IP budgets rather than sharing one.** When a
  request arrives from a private or loopback peer carrying `x-forwarded-for` while
  `trustForwardedHeaders` is off, every visitor looks like the proxy — so the sign-in-start
  and session-read budgets are skipped for it and every IP-wide bucket is dropped, with one
  console warning naming the fix, instead of turning the 21st sign-in site-wide into a
  fifteen-minute outage. The per-subject keys keep working: the credentials limiter's (it
  carries the submitted identifier), the send budget's address and the second-factor
  budget's user.
  Setting `canonicalOrigin` without deciding `trustForwardedHeaders` warns once at boot for
  the same reason.
- **The default store never evicts a key mid-lockout.** Past `maxKeys` it drops expired
  windows and quiet keys (in one pass, down to 90% of the cap), never one that is actually
  locked out — otherwise flooding fresh keys would clear a lockout. When every tracked key
  is locked out and the cap is reached, the new key is refused outright.

```ts
denextAuth({
  // …
  rateLimit: {
    max: 10, // credentials failures per key per window (default 5)
    windowMs: 10 * 60_000, // default 15 minutes
    keyGenerator: (request, credentials) => (credentials.email ?? "").trim().toLowerCase(),
    signin: { max: 40, windowMs: 15 * 60_000 }, // the sign-in-start limiter
    session: { max: 120, windowMs: 60_000 }, // the session-read limiter
    verification: { max: 3, windowMs: 15 * 60_000 }, // email sends per address
    mfa: { max: 5, windowMs: 5 * 60_000 }, // second-factor attempts per user
    store: myRedisRateLimitStore, // RateLimitStore — share counts across replicas
  },
  // or: rateLimit: false (disables ALL FIVE — you rate-limit at the edge)
});
```

`max` / `windowMs` / `keyGenerator` belong to the credentials limiter and never apply to
the other four, which are tuned under `signin`, `session`, `verification` and `mfa`.
`store` is shared by all five (their keys are namespaced apart). The default store is a bounded per-process map —
fine for a single instance, but each replica counts on its own, so pass a shared `store`
behind several.

## API tokens and `requireBearer`

`issueApiToken(config, { userId, name?, scopes?, expiresInSeconds? })` mints `tok_` plus
256 bits of CSPRNG entropy and returns the **plaintext exactly once**; what is stored is
the SHA-256 (hex) of the full presented string, so a database read yields nothing usable
and verification is an indexed exact-match lookup rather than an in-process comparison —
there is no timing oracle to equalise.
`requireBearer(authConfig, { scope, role })` is the `createApi()` middleware that
authenticates `Authorization: Bearer tok_…` and extends the handler's context with
`{ token, user, session }`, where `session` has the same shape `requireSession()`
provides — so a handler written against `ctx.session.user.id` works under either
credential. Every authentication failure (absent header, wrong scheme, unknown, revoked,
expired, or a token whose user was deleted) is the **identical** `401` with
`WWW-Authenticate: Bearer`, so the response can't be used to probe which tokens exist; a
valid token that lacks the required scope or role gets a `403` instead, keeping "who are
you" distinguishable from "may you". Scope and role are any-of, and a **scopeless token
satisfies no scope requirement** — scoping an endpoint never silently admits older,
scopeless tokens. The middleware is pre-tagged with
`documentsSecurity(…, [{ bearerAuth: [] }])`, so `@denext/openapi` marks every endpoint
that applies it as secured with nothing written on the definition. What it cannot do is
describe the scheme: declare the matching
`securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }` **once** in the
`openapi()` plugin options, or the document references a scheme it never defines (and
Swagger UI shows no Authorize button). Bearer auth **never
sets a cookie** and never slides a session forward: a token carries its own credential on
every call and can't be escalated into a browser session.

```ts
// lib/auth.ts
import { createApi, requireBearer } from "denext/server";
import { authConfig } from "./auth-config.ts";

export const authed = createApi().use(requireBearer(authConfig, { scope: "pets:write" }));

// app/api/pets/route.ts
export const POST = authed.define({ body: NewPet }, ({ body, ctx }) => add(ctx.user.id, body));
```

The management endpoints are `POST {basePath}/tokens` (mint — returns the plaintext once,
`201`, and a `409` once you already hold 50 live tokens, so a compromised session cannot
mint credentials without bound), `GET {basePath}/tokens` (list, redacted: no hashes, and
the plaintext no longer exists anywhere) and `DELETE {basePath}/tokens/:id` (revoke). All three are **cookie
session only** — they never read the `Authorization` header, so a leaked token can't mint
another one, widen its own scopes or revoke a sibling — and they require a **complete**
session, so a first factor alone can't produce a credential that outlives the
second-factor requirement. The mutations are same-origin-gated like every other auth
POST. Revoking a token you don't own answers the same `404` an unknown id gets.

All of this needs an adapter implementing the API-token group. Without one the functions
throw with an actionable message at the call that needs them, and `{basePath}/tokens`
simply doesn't exist (a plain 404) — `requireBearer` throws at **module load**, not on
the first request, so an API whose auth could never succeed fails where it is written.
`listApiTokens(config, userId)` and `revokeApiToken(config, id)` are the programmatic
half; records carry `tokenHash`, so redact before sending a list anywhere.

## Client

```tsx
"use client";
import { SessionProvider, signIn, signOut, useSession } from "denext"; // or "denext/client"
```

`SessionProvider` takes `children`, an optional `session` (seed it from the server to
avoid a loading flash — pass the user or `null`), `basePath` (default `"/auth"`),
`refetchInterval` in milliseconds (default `0`, never polls) and `refetchOnWindowFocus`
(default `true`, so a stale tab catches up). Each refetch is a
`GET {basePath}/session`, which is also the server's sliding-expiry path — polling is
what keeps an active user signed in when `session.updateAge` is set.

`useSession()` returns `{ user, status, mfa?, update() }`. `status` is `"loading"` until
resolved, then `"authenticated"` / `"unauthenticated"`, or `"mfa-required"` while the
user still owes a second factor (`user` stays `null` there, and `mfa` is `"required"` —
so the UI can tell "finish your second factor" from "signed out"). `update()` refetches
now and updates every consumer; call it after anything that changes the session
server-side.

```tsx
const { user, status, update } = useSession();
await update(); // e.g. after a profile edit
```

`signIn(provider, options)` navigates to the provider by default. Pass
`redirect: false` to get the URL back instead — for a popup, a custom transition or a
test. Pass `credentials` to POST a Credentials form to the callback endpoint instead
(which never navigates, so `redirect` is ignored there):

```ts
const url = await signIn("google", { redirect: false, callbackUrl: "/dashboard" });
await signIn("credentials", { credentials: { email, password } }); // throws on a bad login
await signIn("email", { credentials: { email } }); // mails a magic link
await signOut({ callbackUrl: "/" });
```

A credentials or email sign-in that still owes a second factor resolves
`{ ok: true, mfa: "required" }` instead of `{ ok: true, user }` — send the user on to your
`pages.mfa` page.

A `callbackUrl` handed to `signIn` or `signOut` is coerced to a **same-origin path**
before anything navigates: these helpers assign it to `location.href` (or hand it to the
server to reflect back), and a `callbackUrl` is routinely read straight out of the current
query. An absolute URL on the page's own origin keeps its path, query and hash; a foreign
absolute, a protocol-relative `//host/…` and a `javascript:` value all fall back to the
default. The server coerces again — this is the half that guards the purely client-side
navigation that never reaches it.

A network failure, a non-JSON body or an error status from the session endpoint all read
as "signed out" rather than throwing into the tree, so the UI degrades to the logged-out
view instead of unmounting behind an error boundary.

## Password hashing

`hashPassword` / `verifyPassword` (from `denext/server`) are salted **scrypt** over the
built-in `node:crypto`. Store `await hashPassword(password)` — a self-describing
`scrypt$N=…,r=…,p=…$salt$hash` string, so the cost can be raised later without
invalidating existing hashes — and verify in constant time. `verifyPassword` returns
`false` rather than throwing on an empty or malformed value, so an unknown account and a
wrong password take the same path.

That equal-work rejection burns real scrypt time, and it has to burn **this deployment's**
cost. So `verifyPassword(plain, stored, options?)` takes a third argument: pass the same
`HashPasswordOptions` you hash with. Omit it on a deployment that raised `cost` and an
unknown account rejects measurably faster than a known one — the user-enumeration oracle
the dummy work exists to close, reopened.

```ts
const OPTS = { cost: 2 ** 16 };
const ok = await verifyPassword(password ?? "", row?.password_hash ?? "", OPTS);
```

The `Hasher` seam is where that lives: `{ hash, verify }`, defaulting to `scryptHasher()`,
which passes its own options to both halves so the two costs can never drift apart.

```ts
import { scryptHasher } from "denext/server";

denextAuth({ hasher: scryptHasher({ cost: 2 ** 16 }) /* … */ });
```

> [!NOTE]
> The framework's own flows drive the seam: the
> [built-in credentials check](#password-sign-in-without-an-authorize) verifies with
> `hasher.verify`, `resetPassword` stores `hasher.hash(newPassword)` through
> `setCredential`, and MFA backup codes are hashed and matched through it. So whatever your
> registration stores must be what the configured hasher verifies — `hashPassword` with the
> same options, under the default. An `authorize` callback of your own still does its own
> check; pass it the same options too. A custom `Hasher` must also **equalise its own
> unknown-account work**: the built-in check calls `verify` with an empty stored value for an
> unknown address, and burning equal work there is the one thing `scryptHasher` does for you
> and a `verify()` that returns early on an empty `stored` does not.

An implementation must compare in constant time and must **not** throw on a malformed
stored value — return `false`, so a corrupted row can never surface as a 500 or a stack
trace.

## The signed-cookie session underneath

`denextAuth` is built on `getSession`, which is public and usable on its own when you
want a session without providers:

```ts
import { getSession } from "denext/server";

const session = await getSession<{ userId: number }>({
  secret: Deno.env.get("SESSION_SECRET")!, // string | string[] (rotation)
});

session.data; // { userId } | null (null if absent/forged/expired)
await session.set({ userId }); // sign in
session.clear(); // sign out
```

Signing in from a Server Action:

```ts
// app/actions.ts
"use server";
import { redirect } from "denext";
import { getSession } from "denext/server";

export async function login(formData: FormData) {
  const user = await verify(formData.get("email"), formData.get("password"));
  if (!user) redirect("/login?error=1");
  await (await getSession({ secret: SECRET })).set({ userId: user.id });
  redirect("/");
}
```

The `<form action={login}>` works with JavaScript disabled — denext renders a
same-origin, CSRF-checked endpoint into the form and redirects back after the action
runs.

Gating routes by hand in `middleware.ts`:

```ts
import { getSession, next, redirectResponse } from "denext/server";

export default async function middleware(_req, ctx) {
  if (ctx.url.pathname.startsWith("/app")) {
    const s = await getSession({ secret: SECRET });
    if (!s.data) return redirectResponse("/login", 307);
  }
  return next();
}
```

> [!NOTE]
> Cookies default to `HttpOnly` + `SameSite=Lax` + `Secure` (over HTTPS). Pass
> `{ httpOnly: false }` to opt out for a client-readable cookie.

## Cross-tab token refresh with `withWebLock`

If your client holds a short-lived access token and refreshes it against a
**one-time-use** refresh cookie, multiple open tabs can race the refresh — one tab
rotates the cookie and the others get logged out. `withWebLock` (a thin wrapper over the
standard Web Locks API, exported from `denext`) single-flights that refresh across every
tab of the origin.

```ts
import { withWebLock } from "denext";

function refresh(): Promise<string> {
  // Only one tab runs this at a time; the others wait here.
  return withWebLock("auth:refresh", async () => {
    if (tokenIsFresh()) return getToken(); // a tab ahead of us already refreshed
    const res = await fetch("/api/refresh", { method: "POST" });
    if (!res.ok) throw new Error("session expired");
    return storeToken(await res.json());
  });
}
```

The lock is same-origin and auto-releases when the callback settles (or the tab closes),
so it can't deadlock. It also degrades gracefully: during SSR, or in a browser without
the API, the callback simply runs uncoordinated.
`withWebLock(name, fn, { mode: "shared", ifAvailable, signal })` covers the other
options. The same primitive fits any "only one tab should do this" job — a one-time
client migration, or electing a single leader tab for a shared connection.

## Security notes

- **CSRF.** Every state-changing auth POST — the Credentials and email callbacks,
  `/signout`, `/verify`, `/reset`, `/reset/confirm`, the `/mfa` steps and the `/tokens`
  mutations — is gated on a same-origin `Origin` / `Referer`. With
  `canonicalOrigin` set it is matched exactly and scheme-strictly; otherwise the request's
  own `Host` is the fallback.
- **Cookies.** Signed, `__Host-`-prefixed, `HttpOnly`, `SameSite=Lax`, and `Secure`
  pinned even behind a proxy that omits `x-forwarded-proto`. The payload never stores
  provider tokens or secrets. A session secret under 32 characters is refused in
  production.
- **Provider calls are SSRF-safe.** Token, userinfo, JWKS and discovery requests go
  through `safeFetch` (loopback and private addresses refused) _and_ are pinned to the
  issuer's host. `dangerouslyAllowInsecureProviders` exists for local development only, and
  warns loudly when set; even then the host allowlist still applies, and redirects are
  followed **by hand with every hop re-checked** — otherwise a token endpoint answering
  `307` could carry the `client_secret` in the POST body to any host it named.
- **OAuth/OIDC.** Authorization Code with PKCE (S256), a CSRF `state` and a `nonce`;
  `id_token`s verified against the provider's JWKS across the RS/PS/ES families
  (`RS/PS/ES 256/384/512`; `none` and unknown algorithms rejected) plus `iss`, `aud`
  (with `strictAudience`), `exp` — required, so a token that omits it is rejected rather
  than treated as non-expiring — `nbf`, `iat` and `nonce`. The `redirect_uri` is pinned to
  `canonicalOrigin`, so a spoofed `Host` header can't steal the code.
- **Open redirects.** Every `callbackUrl` is attacker-supplied, so an absolute URL is
  admitted only when its origin matches `canonicalOrigin` (and then only its path is
  kept); anything else falls back to the configured default.
- **Enumeration resistance.** A wrong password, an unknown account, a denied
  `signIn` callback and a refused account link are all the same generic `401`; a
  rate-limited attempt is the same generic `429`; an unknown bearer token, a revoked one
  and an expired one are the same `401`; someone else's token id and an unknown one are
  the same `404`; a reset request, a verification request and an email-provider send
  answer the same for a known address, an unknown one and a list of them (which sends
  nothing), and a wrong, spent or expired link or code is one `401`. The real reason
  reaches the app through `signInFailed` and the logger, never the client.
- **MFA fails closed.** A session that has passed the first factor but not the second
  reads as `null` from `auth()`, so `requireAuth`, `requireSession`, Live `authorize` and
  Server Actions all refuse it without having to know MFA exists, `/tokens` mints
  nothing, and sliding expiry never extends it. It lasts 15 minutes; the step-up replaces
  it with a fresh session rather than upgrading it (no fixation); and the `/mfa*` endpoints
  read only the cookie, so a bearer token can neither step up nor enroll.
- **Pre-account hijacking.** A first magic-link or code sign-in into an account whose
  address was never verified retires everything set up without that proof — the password,
  any TOTP factor and backup codes, bearer tokens and server-side sessions — before marking
  it verified.

The [security posture guide](/docs/security) maps every Next.js, React and next-auth /
Auth.js CVE class against denext's own implementation, with a live parity test suite.

## Limitations

What the first-party auth layer still does not do — the full ledger is
[Known limitations](/docs/limitations):

- **No mailer, no passkeys, no next-auth compatibility shim.** Every emailed token goes
  through your `sendVerificationRequest`; WebAuthn and a `next-auth` shim are on the
  roadmap.
- **Single-node SQLite, additive schema only, and sliding expiry only on paths that own a
  `Response`** — see [Database adapter](#database-adapter) and [Sessions](#sessions).
- **TOTP secrets are stored in plaintext in the adapter** — a verifier needs the secret, so
  protect the database; backup codes are hashed. `verifyTotp` is SHA-1 only, the algorithm
  every authenticator app supports.
- **No QR renderer.** `enrollTotp` returns the `otpauth://` URI; render it with a library
  of your choice or show the secret for manual entry (`totpQrSvg` is planned for 2.6).
- **No `response_mode=form_post` callback**, so Apple is `openid`-only.
- **A GET spends a magic link**, so a mail gateway that pre-fetches links can burn one —
  prefer `emailOtp()` where link scanners are common.
- **Rotating `secret` invalidates the one-time codes in flight**: they are keyed under the
  current (first) secret, and live for minutes.
- **Stateless cookie sessions survive a password reset** — and a pre-account-hijacking
  eviction — until they expire. Run a `sessionStore` (or `session.strategy: "database"`) so
  either one signs out every device. A pending second-factor session in a cookie can't be
  ended early either; it lasts 15 minutes.
- **`mfa.required: "always"` is trust-on-first-use**: a user with no factor enrolls one
  during the step-up, so whoever holds the first factor at that moment chooses the second.
- **No public helper spends the MFA attempt budget from a Server Action.** The endpoints
  spend it; a Server Action calling `verifySecondFactor` or `confirmTotp` must throttle
  itself.
- **Email addresses must be ASCII**: an SMTPUTF8 local part or a non-punycode IDN domain is
  refused by the emailed flows.
