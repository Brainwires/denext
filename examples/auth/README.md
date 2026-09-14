# examples/auth — a runnable `denextAuth` app

The production shape of denext's first-party auth in one small app, zero npm: Deno's
built-in `node:sqlite` holds everything, and every screen works with JavaScript
disabled (`tests/auth-example.test.ts` drives the app that way in CI).

## What it demonstrates

- **The database adapter** — `adapter: sqliteAuthAdapter({ path })` owns users,
  linked provider accounts, password hashes, bearer API tokens and (as
  `adapter.sessions`) the session records. The app keeps **no parallel user
  table**: registration calls `createUser` + `linkAccount` + `setCredential`
  (`lib/users.ts`), and `session.user.id` is therefore the adapter's id.
- **Credentials with real password hashing** — passwords are stored with
  `hashPassword` (salted scrypt, self-describing so the cost can be raised later)
  and checked with `verifyPassword` (constant-time, never throws). An unknown
  address and a wrong password take the same path, so the endpoint is no
  user-enumeration oracle.
- **Brute-force protection** — the login endpoint is rate-limited (`rateLimit`:
  5 failures per client IP + email per 15 minutes → a generic `429`, the same
  "never reveal whether the account exists" posture as the `401`).
- **Database-backed, revocable sessions with a sliding expiry** —
  `session: { strategy: "database", updateAge: 3600 }`. The cookie carries only a
  random id; **Sign out everywhere** and **Change password** call
  `revokeAllSessions`, after which every existing cookie for that user stops
  authenticating immediately. An active session's expiry slides forward at most
  hourly, on the paths that own their response (`GET /auth/session`,
  `requireAuth`, `requireSession`, `updateAuthSession()`).
- **Roles** — the adapter user carries `roles`, the session carries them along,
  and `middleware.ts` gates `/admin` with `requireAuth(request, { role: "admin" })`.
  A signed-in account without the role is redirected to `/login?error=forbidden`.
  The **first** account to register gets `["admin", "user"]`; everyone else gets
  `["user"]`.
- **OIDC discovery** — set `OIDC_ISSUER` / `OIDC_CLIENT_ID` /
  `OIDC_CLIENT_SECRET` and a `corp` provider appears on the login page
  (`lib/auth-config.ts`). The issuer alone is enough: denext reads the endpoints
  from `<issuer>/.well-known/openid-configuration`, pins the request to the
  issuer's host, refuses a document naming a different issuer, and caches the
  JWKS.
- **Events + logger** — `lib/audit.ts` logs `signIn`, `signInFailed` (with a
  stable reason code) and `sessionRevoked`, plus whatever the framework would
  otherwise swallow. Ids and reason codes only: no emails, tokens or cookies.
- **Bearer API tokens** — `/account/tokens` mints a `tok_…` credential for a
  script (shown **once**, stored only as a SHA-256 hash) and revokes one;
  `app/api/me/route.ts` is protected with
  `createApi().use(requireBearer(authConfig))`.
- **The whole client surface** — `auth()` in Server Components, `requireAuth`
  middleware, and `SessionProvider` / `useSession` / `signIn` / `signOut` in
  `app/user-menu.tsx` and `app/login/login-form.tsx`.

## Run it

```sh
deno task dev      # http://localhost:3000
# or, production:
AUTH_SECRET=$(openssl rand -base64 32) CANONICAL_ORIGIN=https://app.example.com \
  deno task build && deno task start
```

Demo account: `demo@denext.dev` / `password` — seeded on first run and, as the
first account, the **admin**. Environment:

| Variable             | Purpose                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`        | HMAC secret for the session cookie (≥ 32 chars; **required in production** — unset or weak throws)  |
| `CANONICAL_ORIGIN`   | The app's public origin (required in production for OAuth/OIDC providers)                           |
| `AUTH_DB`            | Path to the sqlite file (default `auth.db`) — users, accounts, credentials, API tokens and sessions |
| `OIDC_ISSUER`        | Optional: the corporate OIDC issuer; the endpoints come from its discovery document                 |
| `OIDC_CLIENT_ID`     | Optional: the OIDC client id (all three `OIDC_*` must be set for the provider to appear)            |
| `OIDC_CLIENT_SECRET` | Optional: the OIDC client secret                                                                    |
| `AUTH_DEBUG`         | Optional: also print the framework's `logger.debug` flow tracing                                    |

## Try it

1. Sign in as `demo@denext.dev` / `password` and open **/admin** — the user list,
   gated by the `admin` role. Register a second account, sign in as it, and
   `/admin` bounces you to `/login?error=forbidden`.
2. Sign in in a second browser (or a private window) — two sessions for one user.
   Click **Sign out everywhere** in one and reload the other: it is signed out too.
3. Enter a wrong password six times — the sixth answer is `429 too many attempts`,
   even with the right password, until the window ends. Watch `[auth] sign-in
   refused {"provider":"credentials","reason":"rate_limited"}` on the console.
4. Mint an API token at **/account/tokens** and call the protected endpoint with
   it:

   ```sh
   curl -H "Authorization: Bearer tok_…" http://localhost:3000/api/me
   # {"id":"…","email":"demo@denext.dev","roles":["admin","user"],"token":{…}}
   ```

   Revoke it on the same page and the call answers `401` immediately. The
   `/auth/tokens` JSON endpoints (POST/GET, and DELETE `/auth/tokens/:id`) do the
   same job for a JavaScript client; both refuse a bearer token — only a cookie
   session may mint or revoke one.
5. Point `OIDC_*` at an identity provider and a **Sign in with corp** link appears
   on the login page. A first corporate login creates the user and links the
   account — unless the address already belongs to a password account whose email
   nobody verified, which denext refuses (`account_not_linked`) rather than hand
   the account over.

## Upgrading an older config

If you ran an earlier version of this example with
`sessionStore: sqliteSessionStore({ path: "sessions.db" })`, point the adapter at
that same file (`sqliteAuthAdapter({ path: "sessions.db" })`) and add
`session: { strategy: "database" }`. The `sessions` DDL is byte-identical, so the
adapter adopts the existing table with no migration step and nobody is logged out.
Schema changes are additive by construction: `CREATE TABLE IF NOT EXISTS` plus
`ALTER TABLE … ADD COLUMN`, never a drop or a retype.

## Multi-replica note

The sqlite adapter (sessions included) and the in-memory rate-limit store are
**single-node**: a local file suits one instance. Running several replicas means
either mounting one shared volume or implementing `AuthAdapter` / `SessionStore` /
`RateLimitStore` over your shared database (Postgres, Redis) and passing them to
`denextAuth`. Stateless sessions (`session.strategy: "cookie"`, the default) need
nothing shared — you lose only revocation.
