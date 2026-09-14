---
title: Auth
slug: auth
lead: First-party OAuth 2.0 / OIDC and Credentials auth — zero-npm, secure by default — with a database adapter, roles, bearer API tokens, and the low-level signed-cookie sessions it is built on.
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

| Endpoint              | Method      | What it does                                                                       |
| --------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `/session`            | GET         | `{ user, expires }` (or nulls). `no-store`. The sliding-expiry path.               |
| `/providers`          | GET         | The configured providers' `id` + `type` — never client ids, secrets or endpoints.  |
| `/signin/:provider`   | GET         | Starts the OAuth flow (PKCE + `state` + `nonce`). Rate-limited per client IP.      |
| `/callback/:provider` | GET or POST | GET is the OAuth callback; POST is the Credentials one. Any other verb is a `405`. |
| `/signout`            | POST        | Clears the cookie (and the store record). Same-origin only.                        |
| `/tokens`             | POST, GET   | Mint / list bearer API tokens. Cookie session only.                                |
| `/tokens/:id`         | DELETE      | Revoke one of your own tokens. Cookie session only.                                |

`examples/auth` is a runnable app with credentials sign-in, scrypt-hashed accounts in
`node:sqlite`, the rate-limited login, revocable sessions and "sign out everywhere" —
and it works with JavaScript disabled, which CI asserts. See
[examples/auth](https://github.com/Brainwires/denext/tree/main/examples/auth).

## Providers

Thirteen presets ship in `denext/server`. Every OAuth preset takes
`{ clientId, clientSecret, scopes? }`; `scopes` replaces the defaults rather than adding
to them.

| Provider        | Factory            | Extra options                      | Notes                                                                                    |
| --------------- | ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Google          | `google()`         | —                                  | OIDC. Endpoints pinned (they live on a sibling host), so no discovery.                   |
| GitHub          | `github()`         | —                                  | OAuth. Reads `/user` + `/user/emails`; only a _verified_ address reaches the session.    |
| Microsoft Entra | `microsoftEntra()` | `tenant` (required)                | OIDC v2.0. Single-tenant only — see the note below.                                      |
| Apple           | `apple()`          | —                                  | OIDC, `openid` scope only — see the note below.                                          |
| Discord         | `discord()`        | —                                  | OAuth. An unverified address is dropped like `email_verified: false`.                    |
| GitLab          | `gitlab()`         | `baseUrl` (default `gitlab.com`)   | OIDC. Self-managed must be `https:` at the host root.                                    |
| Slack           | `slack()`          | —                                  | OIDC ("Sign in with Slack").                                                             |
| Auth0           | `auth0()`          | `domain` (required)                | OIDC. The issuer keeps Auth0's trailing slash; `iss` is compared exactly.                |
| Okta            | `okta()`           | `domain`, `authorizationServer`    | OIDC, custom authorization server (default `"default"`).                                 |
| Keycloak        | `keycloak()`       | `baseUrl`, `realm` (both required) | OIDC, the Keycloak 17+ `/realms/<realm>` layout.                                         |
| Facebook        | `facebook()`       | —                                  | OAuth, Graph v19.0. Graph never asserts verification, so `emailVerified` is `undefined`. |
| Generic OIDC    | `oidc()`           | `issuer` (required), endpoints     | Discovery or explicit endpoints — see below.                                             |
| Credentials     | `credentials()`    | `authorize` (required)             | Email/password or anything custom. Rate-limited by default.                              |

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

Every OIDC preset carries both its documented static endpoints **and**
`discovery: { issuer }`, so a provider that rotates an endpoint is picked up without a
denext release. Discovery is a network document that decides where denext sends a client
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
  by default, clamped to between one minute and 24 hours); a **failure is never cached**.

Signing keys are cached on exactly the same terms, per JWKS URL. A key set used to be
refetched on every single login; now a miss refetches **once** and then throttles to at
most one attempt per minute per URL — the `kid` that triggers a refetch comes out of an
attacker-supplied `id_token` header, so an unbounded "refetch on unknown kid" would be a
free amplifier pointed at the provider. Nothing about verification is weakened: an
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

Only a path that still owns its response can set a cookie. So the refresh happens on
`GET {basePath}/session`, inside `requireAuth()` and `requireSession()`, and in the
explicit `updateAuthSession()` — and **never** inside a bare `auth()`, where a
`Set-Cookie` written after a streamed response has flushed would be dropped silently.

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
fire the `sessionRevoked` event. A closable store is released on server drain through the
plugin teardown seam.

> [!NOTE]
> A store is per node: `sqliteSessionStore` is a local file and `inMemorySessionStore` a
> per-process map, so a session created on one replica is invisible to the others.
> Running several replicas? Point them all at one shared store — implement `SessionStore`
> (`create` / `get` / `delete` / `deleteByUser`) over Redis or Postgres. Stateless
> sessions need nothing shared.

### The session payload

Sessions issued now carry `v: 2`, `issuedAt` (epoch seconds) and `amr` (RFC 8176
authentication-method references) alongside `user`, `provider` and `expiresAt`, plus a
reserved `mfaPending` flag. The cookie name, signing secret and MAC domain are unchanged,
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

Every method may be sync or async, timestamps are **epoch seconds** (never `Date`), and
a miss is `undefined` (never `null`). The users and accounts groups are required;
everything else is optional and gates the feature that needs it.

| Group               | Methods                                                                                   | Gates                                         |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| Users (required)    | `createUser`, `getUser`, `getUserByEmail`, `getUserByAccount`, `updateUser`               | Adapter-backed sign-in at all                 |
| Accounts (required) | `linkAccount` — plus optional `unlinkAccount`, `listAccounts`                             | Account linking                               |
| Verification tokens | `createVerificationToken`, `useVerificationToken`                                         | Email verification, reset, magic links (rc.2) |
| Credentials         | `getCredential`, `setCredential`                                                          | First-party password storage                  |
| API tokens          | `createApiToken`, `getApiTokenByHash`, `touchApiToken`, `revokeApiToken`, `listApiTokens` | Bearer tokens and `/auth/tokens`              |
| MFA                 | `getMfa`, `setMfa`, `consumeBackupCode`, `claimTotpStep`                                  | TOTP 2FA (rc.2)                               |
| Sessions, lifecycle | `sessions?: SessionStore`, `close?()`                                                     | `session.strategy: "database"`, drain         |

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

## Roles and authorization

Roles live on the session user as `AuthUser.roles?: string[]`. Populate them in
`callbacks.signIn` / `callbacks.session`, or from an adapter user record. Every check is
**any-of**, and a check against a session with no roles always refuses.

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

| Event            | Payload                                  | Fires when                                        |
| ---------------- | ---------------------------------------- | ------------------------------------------------- |
| `signIn`         | `{ user, provider, isNewUser? }`         | A session was issued                              |
| `signOut`        | `{ session }` (`null` if there was none) | `/signout` cleared the session                    |
| `signInFailed`   | `{ provider?, reason, ip? }`             | An attempt was refused                            |
| `sessionRevoked` | `{ sessionId?, userId? }`                | `revokeSession` / `revokeAllSessions` ran         |
| `createUser`     | `{ user }`                               | An adapter user record was created                |
| `linkAccount`    | `{ user, account }`                      | A provider account was linked to an existing user |

`reason` is a stable machine-readable string an app can route on:
`"invalid_credentials"`, `"rate_limited"`, `"access_denied"`, `"account_not_linked"`, or
an OAuth failure code such as `"oauth_failed"`, `"config"` or `"invalid_state"`.

**A handler that throws cannot change the HTTP result.** The throw — sync or async — is
caught and routed to `logger.error`; an event handler can never fail the sign-in it is
observing.

`logger` has three optional methods, `debug`, `warn` and `error`, and defaults to
**silence** — auth never writes to the console on its own. It is where the failures the
flow deliberately swallows resurface: a provider round-trip that failed behind a generic
`?error=oauth_failed`, an adapter write that threw, a `touchApiToken` a read replica
refused, an unparseable request body.

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
request on the site. Client-side, pass the same prefix to `SessionProvider` /
`signIn` / `signOut` via their `basePath` prop or option.

Two cookies exist: the session cookie (default `__Host-denext_auth`) and the short-lived
OAuth transaction cookie that carries the PKCE verifier, `state` and `nonce` (default
`__Host-denext_auth_tx`). The name you configure is the one _before_ the prefix; a name
must be a valid cookie token (letters, digits, or ``!#$%&'*+-.^_`|~``).

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

| Key             | Default  | Used for                                                                |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `signIn`        | `/`      | The sign-in page — also where a refused guard redirects, with `?error=` |
| `afterSignIn`   | `/`      | Where a completed sign-in lands                                         |
| `afterSignOut`  | `/`      | Where a sign-out lands                                                  |
| `mfa`           | `signIn` | Where `requireAuth` sends a session that still owes a second factor     |
| `verifyRequest` | —        | Declared, not yet consumed — the "check your email" page (rc.2)         |
| `error`         | —        | Declared, not yet consumed — a dedicated `?error=` page (rc.2)          |

## Rate limiting

Brute-force protection is **on by default**, as two fixed-window limiters built from one
`rateLimit` config:

| Limiter       | Counts                                        | Key                                           | Default       |
| ------------- | --------------------------------------------- | --------------------------------------------- | ------------- |
| Credentials   | _Failed_ `POST {basePath}/callback/:provider` | Client IP + submitted identifier, lower-cased | 5 per 15 min  |
| Sign-in start | _Every_ `GET {basePath}/signin/:provider`     | Client IP                                     | 20 per 15 min |

Past the limit the endpoint answers a generic `429` with `Retry-After` — like the generic
`401`, it never reveals whether the account exists — and a successful credentials sign-in
resets its key. The credentials limiter also keeps a looser IP-wide bucket (ten times the
configured `max`), so one IP cannot walk a list of identifiers. The sign-in-start limiter
counts every hit rather than only failures, because the cost being bounded is the work
done for an unauthenticated caller: minting a PKCE verifier, a `state`, a nonce and a
signed transaction cookie, plus provider-id probing.

The identifier is taken from `email`, `username`, `login` or `identifier`. The client IP
is the socket peer; behind a proxy set `trustForwardedHeaders: true` so the proxy's
`x-forwarded-for` (last hop) is used instead — the header is never trusted by default,
since without a proxy anyone can set it.

```ts
denextAuth({
  // …
  rateLimit: {
    max: 10, // credentials failures per key per window (default 5)
    windowMs: 10 * 60_000, // default 15 minutes
    keyGenerator: (request, credentials) => (credentials.email ?? "").trim().toLowerCase(),
    signin: { max: 40, windowMs: 15 * 60_000 }, // the sign-in-start limiter
    store: myRedisRateLimitStore, // RateLimitStore — share counts across replicas
  },
  // or: rateLimit: false (disables BOTH limiters — you rate-limit at the edge)
});
```

`max` / `windowMs` / `keyGenerator` belong to the credentials limiter and never apply to
the sign-in-start one, which is tuned under `signin`. `store` is shared by both (their
keys are namespaced apart). The default store is a bounded per-process map — fine for a
single instance, but each replica counts on its own, so pass a shared `store` behind
several.

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
that applies it as secured with nothing written on the definition. Bearer auth **never
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
`201`), `GET {basePath}/tokens` (list, redacted: no hashes, and the plaintext no longer
exists anywhere) and `DELETE {basePath}/tokens/:id` (revoke). All three are **cookie
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
await signOut({ callbackUrl: "/" });
```

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

Everything denext hashes that a user knows — a Credentials password, an MFA backup code —
goes through the `Hasher` seam, so an app can swap the algorithm (Argon2id from a WASM
package, a KMS-backed peppered hash, a legacy bcrypt column during a migration) without
touching the auth flow. The default is `scryptHasher()`:

```ts
import { scryptHasher } from "denext/server";

denextAuth({ hasher: scryptHasher({ cost: 2 ** 16 }) /* … */ });
```

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

- **CSRF.** Every state-changing auth POST — the Credentials callback, `/signout`, and
  the `/tokens` mutations — is gated on a same-origin `Origin` / `Referer`. With
  `canonicalOrigin` set it is matched exactly and scheme-strictly; otherwise the request's
  own `Host` is the fallback.
- **Cookies.** Signed, `__Host-`-prefixed, `HttpOnly`, `SameSite=Lax`, and `Secure`
  pinned even behind a proxy that omits `x-forwarded-proto`. The payload never stores
  provider tokens or secrets. A session secret under 32 characters is refused in
  production.
- **Provider calls are SSRF-safe.** Token, userinfo, JWKS and discovery requests go
  through `safeFetch` (loopback and private addresses refused) _and_ are pinned to the
  issuer's host. `dangerouslyAllowInsecureProviders` exists for local development only,
  and warns loudly when set.
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
  the same `404`. The real reason reaches the app through `signInFailed` and the logger,
  never the client.
- **MFA fails closed.** A session that has passed the first factor but not the second
  reads as `null` from `auth()`, so `requireAuth`, `requireSession`, Live `authorize` and
  Server Actions all refuse it without having to know MFA exists, `/tokens` mints
  nothing, and sliding expiry never extends it.

The [security posture guide](/docs/security) maps every Next.js, React and next-auth /
Auth.js CVE class against denext's own implementation, with a live parity test suite.

## Coming in rc.2

Three flows are designed, reserved for, and **not yet shipped**: password reset plus
email verification, magic links and email one-time codes, and TOTP two-factor
authentication with a pending-MFA step-up. The seams they need are already in place —
`sendVerificationRequest` (denext ships **no mailer**), the adapter's verification-token
and MFA groups, `pages.verifyRequest` / `pages.mfa` / `pages.error`, and the session
payload's reserved `mfaPending` and `amr` fields — so adopting them later will not
migrate a cookie or log anyone out. Until then, the only thing `mfaPending` does is fail
closed everywhere, as described above.

## Limitations

The honest ledger — what the first-party auth layer deliberately does not do (no mailer,
no passkeys, no next-auth compatibility shim, single-node SQLite, additive schema only,
sliding expiry on Response-owning paths only, TOTP secrets in plaintext) — lives in
[Known limitations](/docs/limitations).
