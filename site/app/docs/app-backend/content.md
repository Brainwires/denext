---
title: App backend
slug: app-backend
lead: Calling your denext server from a Capacitor app — CORS for the app's origin, native sessions (a code exchange, then a bearer access token and a rotating refresh token), the typed API client pointed at a remote server, account deletion, and native Sign in with Apple / Google.
---

## Overview

A [Capacitor app](/docs/mobile) ships its UI as a static export inside the app. Everything
server-side lives on a denext server the app calls over the network, which changes three
things compared with a web page served by that same server:

- **The app is another origin.** The WebView is `capacitor://localhost` on iOS and
  `https://localhost` on Android, so every call to `https://api.example.com` is cross-origin
  and needs [CORS](#cors-for-app-origins).
- **The session cookie does not travel.** `denextAuth`'s session is a `__Host-`,
  `SameSite=Lax` cookie bound to the server's origin; a WebView on another origin neither
  sends nor keeps it. The app uses a [native session](#native-sessions) instead: a bearer
  access token plus a rotating refresh token kept in `secureStore`.
- **Server Actions are unavailable from the export.** An action is a POST to the page's own
  origin. Expose the same logic as a route handler — `defineApi` gives it a validated, typed
  contract — and call it with [`createApiClient({ base, auth })`](#the-client).

Everything below comes from `denext/server` (the server) and `denext` (the client).

## CORS for app origins

List the origins that may call the server in `denext.config.ts`:

```ts
// denext.config.ts
export default {
  cors: {
    origins: ["capacitor://localhost", "https://localhost", "myapp://app"],
    // methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],     (default)
    // headers: ["authorization", "content-type", "x-denext-wire"],    (default)
    // exposeHeaders: [],
    // credentials: false,
    // maxAge: 600,
  },
};
```

The policy covers every route handler (`route.ts`, `defineApi`) and the native `denextAuth`
endpoints. The rules:

- **Exact origins.** An origin matches only when it is byte-identical to a configured one
  (scheme, host and port; the configured value is normalized once to the lower-case form a
  browser sends). `capacitor://localhost.evil`, `https://localhost:444`,
  `Capacitor://localhost` and `null` are all refused. There are no wildcards, prefixes or
  suffixes, and `"null"` can't be configured at all.
- **Never `*` with credentials.** `origins: ["*"]` answers `Access-Control-Allow-Origin: *`
  and is refused at boot next to `credentials: true` (and next to any other origin).
- **`Vary: Origin`** is on every answer the policy touches, allowed or not.
- **Preflights are answered before middleware.** An `OPTIONS` with `Origin` and
  `Access-Control-Request-Method` for an API route is answered `204` under the route's
  policy, so an auth guard in `middleware.ts` never refuses a preflight (which carries no
  credentials). An allowed origin, method and header set gets the approval headers; anything
  else gets none, and the browser does not send the request. Without a policy, `OPTIONS`
  reaches the route's own `OPTIONS` export as before.
- **Validated at boot.** A malformed origin, `"null"`, `"*"` with credentials or an
  out-of-range `maxAge` fails `denext dev` / `denext start` (and `createApp`) with the reason.

A route narrows or lifts the app policy by exporting its own. An object **replaces** the app
policy for that route (it is not merged); `false` turns CORS off for it:

```ts
// app/api/admin/route.ts — never callable from another origin
export const cors = false;

// app/api/public/route.ts — a different audience
export const cors = { origins: ["https://partner.example.com"] };
```

The native auth endpoints (`/auth/native/*`, `/auth/account/delete`) answer their own
preflights under the app `cors` policy; they run after `middleware.ts`, so a middleware
guard must let `OPTIONS` under `/auth` through (guards usually exempt `/auth` already).

CORS applies to route handlers and the native auth endpoints. It does not apply to pages,
Server Actions, the `/_denext/api-batch` endpoint (same-origin by design) or Live
Server Components.

## Native sessions

Native session mode is part of `denextAuth`. It needs an adapter with the native session
group — `sqliteAuthAdapter()` and `inMemoryAuthAdapter()` have it — and the app's callback
URIs:

```ts
// denext.config.ts
import { denextAuth, google, sqliteAuthAdapter } from "denext/server";

export default {
  cors: { origins: ["capacitor://localhost", "https://localhost"] },
  plugins: [
    denextAuth({
      secret: Deno.env.get("AUTH_SECRET")!,
      canonicalOrigin: "https://api.example.com",
      providers: [google({ clientId: "…", clientSecret: "…" })],
      adapter: sqliteAuthAdapter({ path: "auth.db" }),
      session: { strategy: "database" },
      native: {
        redirectUris: ["com.example.app://auth/callback"],
        // accessTokenTtl: 900,          seconds (60..3600)
        // refreshTokenTtl: 2_592_000,   seconds, slides on each refresh (1 hour..1 year)
        // refreshTokenMaxAge: 7_776_000, absolute cap from sign-in (default: none)
        // refreshReuseInterval: 0,      concurrent-refresh grace, seconds (0..60)
        // codeTtl: 60,                  seconds (10..600)
      },
    }),
  ],
};
```

Two refresh policies are off by default and worth deciding on:

| Option                 | Default | What it does                                                                                                                                                                                                                                                                       |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refreshTokenMaxAge`   | none    | An absolute lifetime, in seconds from the original sign-in (1 hour..10 years). Each refresh still slides the expiry by `refreshTokenTtl`, but never past this cap; past it the refresh is `invalid_grant` like an expired one, the family is revoked, and the user signs in again. |
| `refreshReuseInterval` | `0`     | A grace window, in seconds (0..60), for two refreshes racing with one refresh token. Within it, the immediately previous refresh token answers the same pair its rotation issued instead of revoking the family. See [Security](#security) for the tradeoff.                       |

Without `refreshTokenMaxAge`, an app opened at least once every `refreshTokenTtl` stays
signed in indefinitely. Set it when a session should end on a schedule however active it is
(90 days is common). It counts from the family's creation, which is the sign-in.

`refreshReuseInterval` is for an app with more than one refresher: a background task or a
second process holding the same stored refresh token. `nativeSession()` is single-flight
within one JavaScript context, so a single-process app doesn't need it.

The flow, in the order it happens:

1. The app builds a PKCE pair and opens
   `GET /auth/native/authorize?redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…`
   in a system browser sheet (`openAuthSession` from `denext/mobile`). Add `&provider=google`
   to go straight to that provider; without it the sheet opens `pages.signIn`. The server
   refuses a `redirect_uri` that is not in `native.redirectUris` with a plain `400` (it never
   redirects to an unregistered URI) and remembers the challenge and `state` in a signed,
   `__Host-` cookie for ten minutes.
2. The user signs in in the sheet with any provider — OAuth, password, magic link, a second
   factor if they have one. The sign-in lands on `GET /auth/native/complete`. An OAuth provider
   that still has a session in that browser may sign the user straight back in without showing
   a page (the same account as last time). To make it ask, set the provider's
   `authorizationParams` — `{ prompt: "login" }`, or `{ prompt: "select_account" }` on Google
   and other OIDC providers; it applies to every sign-in with that provider.
3. `/native/complete` mints a **one-time code** for that session and redirects to
   `com.example.app://auth/callback?code=…&state=…`. It does so only when the user signed
   in after step 1 began; a session already sitting in the browser answers
   `?error=login_required`.
4. The app checks `state` and posts the code with its verifier:

   ```http
   POST /auth/native/token
   { "grant_type": "authorization_code", "code": "nac_…", "code_verifier": "…",
     "redirect_uri": "com.example.app://auth/callback" }
   ```

   and receives

   ```json
   {
     "access_token": "nat_…",
     "token_type": "Bearer",
     "expires_in": 900,
     "refresh_token": "nrt_…",
     "refresh_expires_in": 2592000,
     "user": { "id": "…" }
   }
   ```

5. Every API call carries `Authorization: Bearer nat_…`. `auth()`, `requireAuth()` and
   `requireSession()` read it as the session (`session.nativeSessionId` names its family). It
   never slides and never sets a cookie.
6. Before the access token expires the app rotates the refresh token:
   `POST /auth/native/token { "grant_type": "refresh_token", "refresh_token": "nrt_…" }`
   answers a new pair. The old refresh token is spent. A refresh does not run
   `callbacks.session` again: the session (`user`, roles and whatever else the callback added)
   is the one minted at the code exchange, for the family's whole life. After a change the
   callback would reflect — a role granted or taken away — end the user's native sessions with
   `revokeAllSessions(userId)` so the app signs in again with the new claims.
7. Sign-out is `POST /auth/native/revoke` with the refresh token in the body (or the access
   token as the bearer). It always answers `200`.

A desktop app works the same way with a loopback redirect URI: `http://127.0.0.1/callback`
registered once matches any port (RFC 8252), for the ephemeral listener
`openAuthSession` starts under Deno Desktop.

Every failed code or refresh is the same `400 { "error": "invalid_grant" }`. The real reason
goes to the logger and the `sessionRevoked` event, never to the client.

## The client

`nativeSession()` is the client half. It runs the PKCE flow, keeps the refresh token in the
storage you give it (`secureStore`: the iOS Keychain or the Android Keystore) and the access
token in memory, and it is an `auth` provider for `createApiClient`:

```ts
// lib/api.ts (in the app)
import { createApiClient, nativeSession } from "denext";
import { openAuthSession, secureStore } from "denext/mobile";
import type {} from "../.denext/api.ts";

const API = "https://api.example.com";

export const session = nativeSession({
  base: API,
  redirectUri: "com.example.app://auth/callback",
  storage: secureStore,
});

export const api = createApiClient({ base: API, auth: session });

export async function signIn() {
  await session.signIn((url) =>
    openAuthSession(url, { callbackScheme: "com.example.app" }).then((r) => r.url)
  );
}
```

```ts
const me = await api("/api/me", "GET"); // typed; carries the bearer
await session.signOut();
```

`createApiClient({ base, auth })` sends `Authorization: Bearer <getToken()>` on every call.
On a `401` it calls `auth.refresh()` once and retries once; concurrent `401`s share one
refresh, and a call that failed with a token the provider has since replaced retries with
the new one without refreshing again. A refresh that resolves `null` (the session is gone)
surfaces the original `401`. `nativeSession().refresh()` is single-flight as well — two
rotations of the same refresh token would read as a replay and sign the user out on the
server. An authenticated client does not batch (the batch endpoint is same-origin only).

Any object with `getToken()` and an optional `refresh()` works as `auth`, so the same client
talks to a server that issues its own tokens. `createApiClient()` and
`createApiClient("https://…")` keep working unchanged.

## Native Sign in with Apple and Google

A native sign-in sheet (Sign in with Apple, Google's Credential Manager) returns an
`id_token`. Configure the client ids it may be issued to, and exchange it at
`POST /auth/native/apple` or `/auth/native/google`:

```ts
native: {
  redirectUris: ["com.example.app://auth/callback"],
  apple: {
    clientIds: ["com.example.app"],            // the bundle id (and a Services ID for the web)
    clientSecret: () => appleClientSecretJwt(), // for revocation, see below
  },
  google: {
    clientIds: [IOS_CLIENT_ID, WEB_CLIENT_ID],  // Android's Credential Manager uses the web id
  },
},
```

```ts
const nonce = await session.nonce(); // single-use, issued by the server
// Your native plugin call; Apple's sheet takes the nonce's SHA-256 hex (your helper).
const result = await yourAppleSignIn({ nonce: await sha256Hex(nonce) });
await session.signInWithIdToken("apple", {
  idToken: result.idToken,
  nonce, // the raw nonce
  authorizationCode: result.authorizationCode,
  name: result.givenName, // Apple sends the name only once
});
```

The server checks the token as strictly as the web OIDC flow does: the signature against the
provider's JWKS (cached per URL; an unknown `kid` triggers one throttled refetch, so a key
rotation is picked up), `iss`, `exp` / `nbf` / `iat` with a minute of skew, and the audience
against the configured set — `aud` must be one of the client ids, a multi-valued `aud` needs
an `azp`, and any `azp` must be one of them too. The `nonce` must be one the server issued
(`POST /auth/native/nonce`, ten minutes, single use) and the token's `nonce` claim must equal
it raw or as its SHA-256 hex, so a captured `id_token` can't be replayed. Set
`requireNonce: false` only for a sheet that can't carry a nonce.

The account is then created or linked by the usual [linking rules](/docs/auth#account-linking-rules):
an existing local account with the same address links only when both sides are verified. The
email comes from the verified token only; the client's first-login payload contributes a
display name at most. A user with a second factor gets `403 { "error": "mfa_required" }` —
send them through the browser flow, which runs the step-up.

With Apple, pass the `authorizationCode` too. When `clientSecret` is configured (or an
`apple()` web provider has one), the server exchanges the code at Apple's token endpoint and
keeps Apple's refresh token on the account, so deletion can revoke it.

## Account deletion

Apple's App Review guideline 5.1.1(v) requires an app that creates accounts to let users
delete them in the app. `POST /auth/account/delete` does it for the signed-in user:

- The caller is the cookie session (a same-origin POST, like every auth POST) or a native
  bearer (`session.deleteAccount()`).
- It needs a **recent sign-in**: `authTime` within `mfa.freshness` (at least five minutes),
  the rule that enrolling a second factor uses. Otherwise it answers
  `403 { "error": "reauth_required" }`; sign in again and retry.
- It revokes the user's Sign in with Apple tokens at `https://appleid.apple.com/auth/revoke`
  (the stored refresh token, else the access token), ends their native session families and
  server-side sessions, then calls the adapter's `deleteUser`, which removes the user, linked
  accounts, the password hash, bearer API tokens, the TOTP factor, native sessions and the
  verification tokens sent to their address (one transaction in SQLite).
- Then `onAccountDeleted({ user, appleRevoked })` runs: delete the app's own rows for the
  user there. `appleRevoked` is `true` when every Apple token was revoked, `false` when one
  could not be (no secret, or Apple refused — deletion still happens, and the logger says
  so), and `undefined` when there was nothing to revoke. A throw is logged; the account is
  already gone.

A custom adapter opts in by implementing `deleteUser(id)`; without it the endpoint does not
exist.

## Security

The checks, in one place:

- **Codes.** Stored as a SHA-256 hash, bound to the registered redirect URI and the PKCE
  `S256` challenge, alive for `codeTtl` (60 seconds), and consumed atomically on the first
  redemption — a wrong verifier spends the code too. A replayed, expired or mis-bound code
  is `invalid_grant`. The verifier is compared in constant time.
- **No silent hand-off.** `/native/complete` requires a sign-in made after
  `/native/authorize` began, so a browser that is already signed in can't hand its session
  to whatever app opened the flow.
- **Access tokens.** HMAC-SHA256 under their own MAC domain (they never verify as a cookie
  or a refresh token), verified against every configured secret, and re-checked against
  their session family on every request: a revoked family's tokens stop at once, not at
  expiry.
- **Refresh rotation with reuse detection.** Each refresh advances the family's generation
  with an atomic compare-and-swap. An older generation with a valid MAC is a replay: the
  whole family is revoked, which signs out the thief and the app alike. A token whose MAC
  doesn't verify is refused without touching the family, so knowing a family id is not
  enough to sign someone out. Two concurrent refreshes with one token produce exactly one
  new pair (the loser is treated as a replay) — the client is single-flight for that reason.
- **The reuse interval weakens replay detection, slightly.** With `refreshReuseInterval: N`,
  the immediately previous refresh token is accepted for `N` seconds after its rotation and
  answers the same pair that rotation issued (byte-identical; the family advances once).
  The cost is that a stolen token replayed within those `N` seconds of the app's own refresh,
  or used by a thief who refreshes first while the app follows within `N` seconds, is no
  longer caught at that moment: both parties now hold the same pair. Detection returns at the
  next rotation, because whichever party then presents a spent token outside the window
  revokes the family. An older generation is a replay even inside the window, and the window
  never revives a revoked, expired or capped family or a deleted user. Keep it as short as
  your race needs (a few seconds), or leave it at `0`.
- **Nothing is stored to answer the reuse interval.** The pair is re-derived, not kept: the
  refresh token is an HMAC of the family, the generation and a server-only salt, and the
  access token's issue time is the stored rotation time and its id an HMAC of the same
  input. The only new state is one timestamp on the family (`rotatedAt`).
- **The absolute cap ends access tokens too.** The family's expiry never slides past
  `refreshTokenMaxAge`, and every access token is re-checked against it.
- **Origin gate.** The native POSTs carry their credential in the body or the
  `Authorization` header, never a cookie, so a request with no `Origin` (a native HTTP
  client) passes; a present `Origin` must be this app or one `cors` allows, and `null` is
  refused. Account deletion by cookie is same-origin only.
- **Revocation reaches native sessions.** Sign-out, `revokeAllSessions(userId)`, a password
  reset, a pre-account-hijacking eviction and account deletion all end them.
- **Nothing sensitive is logged.** No code, token, verifier or Apple secret reaches the
  logger or an event.
- **Custom schemes can be claimed by another app.** PKCE is what stops an app that
  registered the same scheme from redeeming an intercepted code, but that app could start a
  flow of its own. Prefer a claimed `https://` redirect URI (a universal link / app link),
  which only your app can receive.

## Limitations

- **Sessions on other devices using stateless cookies outlive account deletion** until they
  expire; run a `sessionStore` (`session.strategy: "database"`).
- **A user with a second factor can't use a native id_token sign-in**; the browser flow
  handles the step-up.
- **Apple revocation needs the client secret JWT** (`native.apple.clientSecret`, or an
  `apple()` provider's) — minting it from your `.p8` key is yours to do.
- **CORS does not cover pages, Server Actions, the API batch endpoint or Live.**
