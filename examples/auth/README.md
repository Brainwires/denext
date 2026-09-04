# examples/auth — a runnable `denextAuth` app

The production shape of denext's first-party auth in one small app:

- **Credentials provider with real password hashing** — accounts live in Deno's
  built-in `node:sqlite`; passwords are stored with `hashPassword` (salted
  scrypt, self-describing so the cost can be raised later) and checked with
  `verifyPassword` (constant-time, never throws). See `lib/auth-config.ts` and
  `lib/db.ts`.
- **Brute-force protection** — the login endpoint is rate-limited (`rateLimit`
  in the config: 5 failures per client IP + email per 15 minutes → a generic
  `429`, the same "never reveal whether the account exists" posture as the
  `401`).
- **Revocable sessions** — `sessionStore: sqliteSessionStore()` makes the cookie
  carry only a random id; the payload lives in `sessions.db`. The dashboard's
  **Sign out everywhere** and **Change password** call `revokeAllSessions`,
  after which every existing cookie for that user stops authenticating
  immediately — `middleware.ts` (`requireAuth`) bounces it to `/login`.
- **The whole surface** — `auth()` in Server Components, `requireAuth`
  middleware gating `/dashboard`, and the client `SessionProvider` /
  `useSession` / `signIn` / `signOut` in `app/user-menu.tsx` and
  `app/login/login-form.tsx`.
- An **OIDC provider** is sketched (commented) in `lib/auth-config.ts` — fill in
  the issuer + client credentials to add "Sign in with …".

Everything except the client-side login feedback works with JavaScript disabled;
`tests/auth-example.test.ts` drives the app that way in CI.

## Run it

```sh
deno task dev      # http://localhost:3000
# or, production:
AUTH_SECRET=$(openssl rand -base64 32) CANONICAL_ORIGIN=https://app.example.com \
  deno task build && deno task start
```

Demo account: `demo@denext.dev` / `password` (seeded on first run). Environment:

| Variable           | Purpose                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`      | HMAC secret for the session cookie (≥ 32 chars; **required in production** — unset or weak throws) |
| `CANONICAL_ORIGIN` | The app's public origin (required in production for OAuth/OIDC providers)                          |
| `AUTH_DB`          | Users database path (`:memory:` for an ephemeral one; also switches sessions to memory)            |

## Try the production features

1. Sign in, open `/dashboard`, then in a second browser (or a private window)
   sign in again — two sessions for the same user.
2. Click **Sign out everywhere** in one — reload the other: it is signed out
   too.
3. Enter a wrong password six times — the sixth answer is
   `429 too many attempts`, even with the right password, until the window ends.
4. Remove `sessionStore` from `lib/auth-config.ts` — the app still works with
   the default stateless signed cookie (only "sign out everywhere" is gone).

## Multi-replica note

The sqlite session store (and the in-memory rate-limit store) are per node. When
running several replicas, point them at one shared store — implement
`SessionStore` / `RateLimitStore` over your shared database (Redis, Postgres)
and pass them to `denextAuth`. Stateless sessions (the default) need nothing
shared.
