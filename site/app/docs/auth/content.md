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

The server half is the `denext/auth` entry point (`import { auth, denextAuth, github } from
"denext/auth"`); `denext/server` re-exports every one of those names, so either import works.
The client half comes from `denext` or `denext/client`.

On top of sign-in, the plugin runs the account flows an app would otherwise hand-roll:
[password sign-in with no `authorize`](#password-sign-in-without-an-authorize),
[email verification and password reset](#email-verification-and-password-reset),
[passwordless magic links and one-time codes](#passwordless-magic-links-and-one-time-codes)
and [TOTP two-factor authentication](#two-factor-authentication-totp). All four need an
`adapter`; the emailed ones also need a `sendVerificationRequest` — denext's
[`smtpMailer()`](#sending-mail-over-smtp), or your own.

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

`secret` must be at least 32 characters (shorter warns in development and **throws in production**)
and accepts an array to rotate — every secret verifies, the first one signs. The same list seals
TOTP secrets at rest ([Secrets at rest](#secrets-at-rest)), so list the new secret first, never
replace the old one, and remove the old one once `denext auth reseal` reports zero remaining (see
[Secrets at rest](#secrets-at-rest)). `canonicalOrigin` warns in development and throws in
production: without it the OAuth `redirect_uri` and the same-origin checks derive from the
attacker-controllable `Host` header. An OAuth provider whose `clientId` / `clientSecret` is empty —
or the literal string `"undefined"`, which a missing `Deno.env.get("…")!` produces — is refused at
config time rather than failing every login later.

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

| Endpoint                   | Method      | What it does                                                                                                                                                                  |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/session`                 | GET         | `{ user, expires }` (or nulls). `no-store`. The sliding-expiry path. Rate-limited.                                                                                            |
| `/providers`               | GET         | The configured providers' `id` + `type` (and an email or phone provider's `name`) — never client ids, secrets or endpoints.                                                   |
| `/signin/:provider`        | GET         | Starts the OAuth flow (`state`, plus PKCE and an OIDC `nonce` unless the provider's `checks` leave them out). Rate-limited per client IP.                                     |
| `/callback/:provider`      | GET or POST | By provider type: GET is the OAuth callback and the magic-link click; POST is the Credentials sign-in and the email or phone send / redeem. A verb the type lacks is a `405`. |
| `/anonymous`               | POST        | With `anonymous: true`: create an anonymous user and sign it in. See [Anonymous sign-in](#anonymous-sign-in).                                                                 |
| `/signout`                 | POST        | Clears the cookie (and the store record). Same-origin only.                                                                                                                   |
| `/tokens`                  | POST, GET   | Mint / list bearer API tokens. Cookie session only; minting needs a recent sign-in.                                                                                           |
| `/tokens/:id`              | DELETE      | Revoke one of your own tokens. Cookie session only.                                                                                                                           |
| `/verify`                  | GET, POST   | Redeem an email-verification token — the emailed link (GET) or a form / JSON body.                                                                                            |
| `/reset`                   | POST        | Request a password-reset link. One answer for every address.                                                                                                                  |
| `/reset/confirm`           | POST        | `{ email, token, password }`: set the new password.                                                                                                                           |
| `/mfa`                     | POST        | Finish a pending sign-in with a TOTP, SMS or backup code.                                                                                                                     |
| `/mfa/challenge`           | POST        | `{ factorId }`: text a code to a verified phone factor for the pending sign-in; answers `{ challengeId, expiresAt }`.                                                         |
| `/mfa/enroll`              | POST        | Start a TOTP enrollment: `{ secret, uri }`. A complete session must have signed in recently, else `403 reauth_required`.                                                      |
| `/mfa/confirm`             | POST        | Confirm the enrollment; the backup codes come back once.                                                                                                                      |
| `/mfa/disable`             | POST        | Remove the user's TOTP factors (and the backup codes, unless another verified factor remains), given a fresh second factor.                                                   |
| `/passkey/*`               | POST        | Passkeys: `register/options` + `register` from a recent session, `authenticate/options` + `authenticate` to sign in or step up. See [Passkeys](#passkeys-webauthn).           |
| `/passkeys`                | GET         | The signed-in user's passkeys (no key material).                                                                                                                              |
| `/passkeys/:id`            | DELETE      | Remove one of your passkeys. Needs a recent sign-in.                                                                                                                          |
| `/native/authorize`        | GET         | Native session mode: start a sign-in for an app (PKCE `S256` challenge, registered `redirect_uri`). See [App backend](/docs/app-backend).                                     |
| `/native/complete`         | GET         | Where that sign-in lands: a one-time code to the app's redirect URI, only for a sign-in made after `/native/authorize` began.                                                 |
| `/native/token`            | POST        | Code + verifier → bearer access token + rotating refresh token; or rotate a refresh token. A replayed refresh token revokes its session family.                               |
| `/native/revoke`           | POST        | Sign a native session out (refresh token in the body, or the access token as a bearer). Always `200`.                                                                         |
| `/native/nonce`            | POST        | A single-use nonce for a native Apple / Google sign-in.                                                                                                                       |
| `/native/:provider`        | POST        | `apple` / `google`: verify a native sign-in sheet's `id_token` and answer the native session tokens.                                                                          |
| `/native/mfa`              | POST        | `{ mfa_token, code[, factor_id, challenge_id] }`: finish a native `id_token` sign-in that owes a second factor.                                                               |
| `/native/mfa-challenge`    | POST        | `{ mfa_token, factor_id }`: text a code to a verified phone factor for that pending native sign-in.                                                                           |
| `/native/mfa-enroll`       | POST        | `{ mfa_token }` (a sign-in answered with `mfa_enroll: true`): start a first TOTP factor — `{ factor_id, secret, uri, mfa_token }`.                                            |
| `/native/mfa-confirm`      | POST        | `{ mfa_token, code }`: confirm that factor and finish the sign-in — the native tokens plus `backup_codes`.                                                                    |
| `/saml/:provider/metadata` | GET         | A [`saml()`](#saml-providers) provider's SP metadata, to give its identity provider.                                                                                          |
| `/account/delete`          | POST        | Delete the signed-in user (cookie, same-origin; or a native bearer). Needs a recent sign-in, else `403 reauth_required`. Revokes Sign in with Apple tokens.                   |

A row claims only its own verb, so `GET {basePath}/reset` and `GET {basePath}/mfa` fall through to
your app — that is where a reset link and `pages.mfa` can land. The account rows exist only when the
adapter can run them — `/verify` and `/reset*` need the verification-token group (`/reset*` also
`setCredential`), `/mfa*` the MFA factor and backup-code groups, `/passkey*` a `passkeys` config —
and are otherwise a plain 404, like `/tokens`. The `/native/*` rows exist only with a `native`
config (and an adapter with the native session group), and `/account/delete` only with an adapter
that implements `deleteUser`.

`examples/auth` is a runnable app with adapter-backed credentials sign-in (scrypt-hashed
passwords in `node:sqlite`, no `authorize`), the rate-limited login, revocable sessions and
"sign out everywhere", email verification, password reset, a magic sign-in link and TOTP
two-factor with backup codes — and it works with JavaScript disabled, which CI asserts.
Every emailed flow runs end to end with no mail server: its development
`sendVerificationRequest` keeps each message for a dev-only `/dev/outbox` page (a 404 in
production, where that mailer refuses to send). See
[examples/auth](https://github.com/Brainwires/denext/tree/main/examples/auth).

## Providers

Seventeen presets ship in `denext/server`. Every OAuth preset takes
`{ clientId, clientSecret, scopes? }`; `scopes` replaces the defaults rather than adding
to them.

| Provider        | Factory            | Extra options                          | Notes                                                                                                      |
| --------------- | ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Google          | `google()`         | —                                      | OIDC. Endpoints pinned (they live on a sibling host), so no discovery.                                     |
| GitHub          | `github()`         | —                                      | OAuth. Reads `/user` + `/user/emails`; only a _verified_ address reaches the session.                      |
| Microsoft Entra | `microsoftEntra()` | `tenant` (required), `allowedTenants`  | OIDC v2.0. A tenant, or `common` / `organizations` / `consumers` — see the note below.                     |
| Apple           | `apple()`          | —                                      | OIDC over `response_mode=form_post`, with name and email — see the section below.                          |
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
| Phone code      | `phoneOtp()`       | `id`, `name`, `allowSignUp`            | Passwordless: texts a one-time code through `sendSms` — see [Phone sign-in](#phone-sign-in).               |
| SAML 2.0        | `saml()`           | `id`, `metadataXml`, `domains`         | An enterprise IdP's SSO — see [SAML providers](#saml-providers).                                           |

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

### PKCE, `state` and `nonce` (`checks`)

Every flow sends a random `state` and checks it on the callback. A provider also gets a PKCE
(`S256`) challenge, and an OIDC one a `nonce` its `id_token` must carry, unless its `checks` say
otherwise, as Auth.js's provider `checks` do: with `checks` set, PKCE runs only when the list has
`"pkce"` and the `nonce` only when it has `"nonce"`. A provider that refuses a `code_verifier` it
didn't ask for takes `checks: ["state"]` (`{ ...github({ clientId, clientSecret }), checks:
["state"] }`); `state` runs whatever the list says, `"none"` included, and an unknown value is a
config error.

### Native `OAuthProvider` fields

A provider the presets don't cover is an `OAuthProvider` object literal (or `oidc({ … })` for an
OpenID Connect issuer). Besides the endpoints, `scopes`, the client credentials and `profile`, it
takes:

- `checks?: readonly OAuthCheck[]` — `"pkce"`, `"state"`, `"nonce"` or `"none"`, as above.
  Unset is PKCE (`S256`) plus a `nonce` for an `"oidc"` provider; an unknown value is a config
  error.
- `tokenRequestParams?: Record<string, string>` — extra form fields on the token request (a
  `client_key`, say). They never replace one the flow sets itself: `grant_type`, `code`,
  `redirect_uri`, `code_verifier` and the client credentials win.
- `userinfoRequest?: (input) => Promise<Record<string, unknown>>` — reads the profile with a
  request of the provider's own shape (a `POST`, API-key headers, an id from the token response
  in the URL) instead of a `GET` of `userinfoUrl` with a Bearer token. `input` is
  `{ tokens, fetch(url, { method, headers, body? }), url? }`: the token response, the provider
  fetch (pinned to the provider's hosts) and the resolved `userinfoUrl`.
- `idTokenAlg?: "HS256"` — for an `"oidc"` provider whose specification signs the `id_token`
  with HMAC-SHA256 under the client secret. It is verified with the secret and no other algorithm
  is accepted from it; on any other provider type it is a config error. Unset, the `id_token` is
  verified against the issuer's JWKS.

```ts
import type { OAuthProvider } from "denext/server";

const example: OAuthProvider = {
  id: "example",
  type: "oauth",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  userinfoUrl: "https://api.example.com/me",
  scopes: ["profile"],
  clientId,
  clientSecret,
  checks: ["state"],
  tokenRequestParams: { client_key: clientId },
  userinfoRequest: async ({ tokens, fetch, url }) => {
    const res = await fetch(url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: tokens.access_token }),
    });
    return await res.json();
  },
  profile: ({ userinfo }) => ({ id: String(userinfo?.id), name: String(userinfo?.name ?? "") }),
};
```

### `response_mode=form_post`

Some providers return the authorization response as a form the browser POSTs back instead of
a redirect with a query (OAuth 2.0 Form Post Response Mode). Sign in with Apple requires it
for the `name` and `email` scopes. `apple()` uses it by default; any OAuth / OIDC provider
opts in with `responseMode: "form_post"` (`oidc({ …, responseMode: "form_post" })`):

- `GET {basePath}/signin/:provider` adds `response_mode=form_post` to the authorization
  request, and its transaction cookie (state, PKCE verifier, nonce) is
  `SameSite=None; Secure` — still `__Host-`, `HttpOnly`, signed and 10 minutes long — because
  the provider's POST is cross-site and a `Lax` cookie would not ride it.
- `POST {basePath}/callback/:provider` reads `code`, `state` and `error` from the
  `application/x-www-form-urlencoded` body (16 KiB at most) and runs exactly the GET
  callback's checks: the transaction is single-use, must name this provider and carry the
  posted `state`, the code is redeemed with its PKCE verifier, and an `id_token` must carry
  its `nonce`. It has no same-origin gate — the POST is cross-site by design — so those checks
  are what authenticate it. Anything but a urlencoded form is `?error=invalid_request`.
- A GET carrying a code for such a provider is refused (`?error=invalid_request`), so the
  flow can't be downgraded to a code in a URL. A POST to a query-mode provider is a `405`.
- `response_mode` in `authorizationParams` is a config error — use `responseMode`, so the
  callback and the cookie follow it.

`apple()` requests `openid name email`. The email comes from the verified `id_token` (often
a private relay address, with Apple's `email_verified`); the name comes from the `user` field
Apple posts on a user's **first** authorization only — it is not signed, so it is used for the
display name and nothing else, and a profile mapper sees it as `callbackParams.user`. Keep it:
with an adapter the first sign-in stores it on the user. `clientSecret` must be the ES256
client-secret **JWT** you mint from your Apple key.

A session cookie set with `SameSite=Strict` is not sent on the redirect that follows the
cross-site POST, so the user lands signed out until the next navigation; keep the session
cookie at its default `Lax`.

### Microsoft Entra: one tenant or many

`tenant` is a single directory (a GUID or a verified domain) or one of Microsoft's multi-tenant
aliases:

| `tenant`        | Who signs in                                     | How the `id_token`'s issuer is checked                                        |
| --------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| a tenant        | that directory's users                           | exactly `https://login.microsoftonline.com/<tenant>/v2.0` (discovery on)      |
| `organizations` | any work or school tenant; personal accounts no  | against the token's own `tid`: `https://login.microsoftonline.com/{tid}/v2.0` |
| `common`        | any work or school tenant, and personal accounts | against the token's own `tid`, as above                                       |
| `consumers`     | personal Microsoft accounts only                 | exactly the personal-account tenant's issuer (`9188040d-…`)                   |

For `common` and `organizations` the discovery document declares a template issuer
(`https://login.microsoftonline.com/{tenantid}/v2.0`), so denext fills it from the token's own
`tid` claim — which must be a GUID — and compares `iss` to the result exactly, after checking the
signature against the common key set. A token can only claim the issuer of the tenant it says it
is from, and a token whose `iss` names one tenant and whose `tid` names another is refused.

> [!WARNING]
> `common` and `organizations` admit a user of **any** Entra tenant, including one an attacker
> creates for the purpose (and Entra's `email` claim is whatever that tenant's admin set). List
> the tenants you serve:
>
> ```ts
> microsoftEntra({
>   clientId,
>   clientSecret,
>   tenant: "organizations",
>   allowedTenants: ["72f988bf-86f1-41af-91ab-2d7cd011db47"], // tenant ids (GUIDs)
> });
> ```
>
> A token from a tenant outside the list is refused before anything else.

**Which account, and which address.** Any tenant's admin can put any `email` on a user, so for
`common`, `organizations` and `consumers` denext never trusts the address on its own (the
"nOAuth" class):

- The account is keyed on the token's **`tid` + `oid`** (the user's object id in the tenant
  whose issuer was checked) — not on `sub` alone, and never on the email. A token without both
  is refused.
- The email counts only when Microsoft says the domain's owner verified it: the optional claim
  **`xms_edov`** is `true`. Then it is the account's verified address, and it links to an
  existing verified account like any verified provider email (see
  [Account linking rules](#account-linking-rules)).
- Otherwise the email is **dropped**: the account is created with no address, so it can't
  occupy one, block the real owner's sign-up or magic link, or link to an account later. The
  personal-account tenant (`9188040d-6c67-4c5b-b112-36a304b66dad`, `consumers` and `common`)
  follows the same rule.

To receive `xms_edov`, add it to the app registration: **Token configuration → Add optional
claim → ID → `xms_edov`** (and `email`), or `"optionalClaims": { "idToken": [{ "name":
"xms_edov" }, { "name": "email" }] }` in the manifest. Without it, multi-tenant sign-ins carry no
email at all. A single `tenant` (your own directory) keeps the standard mapping on `sub`, and
marks the email verified when `xms_edov` is `true`.

### SAML providers

`saml()` signs users in through an enterprise identity provider (Okta, Entra ID, Google
Workspace, ADFS, Keycloak, …) on denextAuth's own endpoints — no `/auth/v1` needed:

```ts
import { denextAuth, saml, sqliteAuthAdapter } from "denext/server";

denextAuth({
  secret: Deno.env.get("AUTH_SECRET")!,
  canonicalOrigin: "https://example.com",
  adapter: sqliteAuthAdapter({ path: "auth.db" }), // required: the account is stored
  providers: [
    saml({
      id: "acme",
      name: "Acme SSO",
      metadataXml: await Deno.readTextFile("./acme-idp-metadata.xml"),
      domains: ["acme.com"], // the addresses this IdP speaks for
      attributeMapping: { name: "displayName" },
      // sp: { signingKey, signingCertificate, encryptionKey, encryptionCertificate, entityId },
    }),
  ],
});
```

| Endpoint                               | What it does                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `GET {basePath}/signin/acme`           | Sends the browser to the IdP with an AuthnRequest (signed with `sp.signingKey`). |
| `POST {basePath}/callback/acme`        | The Assertion Consumer Service: the IdP posts its Response here.                 |
| `GET {basePath}/saml/acme/metadata`    | This SP's metadata (also the default entity id) — give it to the IdP.            |
| `GET \| POST {basePath}/saml/acme/slo` | Single Logout (with `sp.signingKey`): the IdP's LogoutRequest or LogoutResponse. |

`signIn("acme")` from `denext/client` starts it like any provider. Only SP-initiated logins are
accepted: the AuthnRequest's ID and a fresh RelayState ride the signed, single-use transaction
cookie (`SameSite=None`, since the IdP's POST is cross-site), and the Response must answer that
request exactly.

**The same SAML code as `/auth/v1`.** The Response is verified by the implementation behind
[SAML single sign-on](#saml-single-sign-on) — a strict XML parser, XML-DSig over exclusive c14n
against the metadata's certificates only, signature-wrapping and comment-injection defenses, the
audience (this SP's entity id), the recipient and destination (this ACS), the validity window,
`InResponseTo`, the shared assertion replay cache, and encrypted assertions — and the user by
its SSO rules:

- An address is bound to the account (as verified) only on one of the provider's `domains`; any
  other address is never bound. Without `domains`, no email is bound.
- The provider's NameID signs in the same user every time. A first sign-in never takes over an
  existing account with the same address (`?error=account_not_linked`) unless
  `linkExistingAccounts: true` and the address is on the provider's domains; an SSO user of
  another identity provider is never linked.
- A new user is created unless `allowSignUp: false`, as an **SSO user** (`sso:acme`): its
  identity provider is its only way in. Password, code, link, passkey and OAuth sign-ins never
  find it, and only a session its IdP started (`amr` includes `sso/saml`) lives — see the SAML
  trust model under [Threat notes](#threat-notes).
- A user with a second factor gets the pending step-up, like any other sign-in.

**Single Logout** is on when the provider has `sp.signingKey` (+ `sp.signingCertificate`); the SP
metadata then lists `{basePath}/saml/acme/slo` (HTTP-Redirect and HTTP-POST) as its
SingleLogoutService. The session a `saml()` sign-in starts carries the assertion's NameID and
SessionIndex (`session.saml`), and:

- **SP-initiated.** `signOut()` (`POST {basePath}/signout`) ends the session at once, as always,
  then sends the browser on to the IdP's SingleLogoutService with a LogoutRequest signed over the
  HTTP-Redirect binding (RSA-SHA256) — a `303`, or `{ ok: true, url }` for a JSON caller. Its ID
  and a fresh RelayState ride the signed, single-use transaction cookie, and the IdP's
  LogoutResponse must answer exactly that request; it lands on the sign-out target
  (`callbackUrl`, else `pages.afterSignOut`), with `?error=saml_logout_failed` when the IdP
  reports a partial logout or the response can't be verified. An IdP without a SingleLogoutService
  just signs out locally.
- **IdP-initiated.** A LogoutRequest at `{basePath}/saml/acme/slo` (a query signature, or an
  enveloped XML signature over HTTP-POST) must be signed by the provider's IdP, name this SP's SLO
  URL as its Destination, be fresh, and be new (its ID is claimed in the shared replay cache). It
  ends the sessions its NameID started: with a `sessionStore` (and an adapter with the SSO session
  group, as the shipped ones have) exactly those its SessionIndexes name, each recorded at sign-in;
  with stateless cookie sessions, which have no id to end one by, every session of that user signed
  in before now (`sessionsValidAfter`). The caller's own cookie is cleared when it is one of them,
  and the answer is a LogoutResponse signed over HTTP-Redirect to the IdP (`200` when it has no
  SingleLogoutService).

The messages are checked by the same code as `/auth/v1`'s [Single Logout](#saml-single-sign-on).

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
    maxLifetime: 60 * 60 * 24 * 30, // never past 30 days from sign-in (default: 30 days, or maxAge if longer)
  },
});
```

`"cookie"` (the default) keeps the whole payload in the signed cookie: stateless and
multi-replica-safe; expiry ends it, and with an `adapter` so does the user's
[`sessionsValidAfter`](#revocation). `"database"` stores the payload server-side
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

### Absolute lifetime

Sliding stops at `session.maxLifetime`, a hard ceiling counted from the sign-in (`authTime`)
that no refresh can extend. A slide near it extends the session only up to it, and a session
past it reads as signed out — `auth()` answers `null` — whatever its `expiresAt` says, on the
cookie and the database strategy alike. Every expiry denext mints is capped there too, and a
`callbacks.session` that lifts `expiresAt` is capped back down. A second-factor step-up is a
new authentication, so it starts a new ceiling.

The default is **30 days, or `maxAge` when that is longer**, so a session that never slides
is unaffected and an app with a 90-day `maxAge` keeps it. `maxLifetime` must be a whole
number of seconds no shorter than `maxAge`; anything else makes `denextAuth()` throw. A
session issued before 2.5.0-rc.3 carries no `authTime`, so it has no ceiling to measure: it
still reads, is never slid again, and ends at its current expiry. Native app sessions have
their own cap, `native.refreshTokenMaxAge` (below).

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

`revokeAllSessions(userId)` ends stateless cookie sessions too, through the user record: it
sets the user's `sessionsValidAfter` to now, and every read of a cookie session (stateless or
store-backed) refuses one that signed in (`authTime`, else its issue time) before it. The same
stamp is set by a password reset, the pre-account-hijacking eviction, account deletion, and
`/auth/v1`'s ban, password change (by the user or an admin) and user deletion; a sign-in
after it is unaffected, and the stamp never moves back. The comparison is to the second, so
a session signed in during the very second of the stamp survives it. It needs an `adapter`
(the time is stored on the user, in every adapter: memory, SQLite, Postgres);
`revokeAllSessions` throws with neither an adapter nor a `sessionStore`, and `revokeSession`
(one session by id) needs the store. Both fire the `sessionRevoked` event.

A user who can no longer sign in needs no revocation to be signed out: with an `adapter`, every read
of a cookie session — `auth()`, `requireAuth()`, `requireSession()`, the `/auth/*` endpoints —
re-reads its user through the adapter (once per request, however many times `auth()` is called), and
a deleted or banned user, or an SSO user whose session its identity provider did not start (a
[`saml()`](#saml-providers) sign-in is the one that does), reads as signed out from their very next
request, stateless cookies included. Anything holding a resource is released on server drain through
the plugin teardown seam — a closable session store **and** a closable `adapter`, so a
`sqliteAuthAdapter` no longer keeps its file handle for the life of the process.

> [!NOTE]
> A store is per node: `sqliteSessionStore` is a local file and `inMemorySessionStore` a
> per-process map, so a session created on one replica is invisible to the others.
> Running several replicas? Point them all at one shared store — `postgresSessionStore({ sql })`
> (see [Postgres](#postgres)), or implement `SessionStore` (`create` / `get` / `delete` /
> `deleteByUser`, plus `update` for sliding expiry and an optional `close`) over Redis or
> anything else. Stateless sessions need nothing shared.

### The session payload

Sessions issued now carry `v: 2`, `issuedAt` (epoch seconds — re-stamped by every slide, so with
sliding expiry on it is the last re-issue, not the sign-in), `authTime` (epoch seconds of the last
sign-in or second-factor step-up, which a slide never moves) and `amr` (RFC 8176
authentication-method references) alongside `user`, `provider` and `expiresAt`, plus `mfaPending`
while a second factor is still owed. `amr` records how the user got in: `pwd` (a password), `ext`
(an OAuth / OIDC provider), `email` (a magic link) or `otp` (an emailed code), and after a step-up
`totp` or `bcp` (a backup code) as well. The cookie name, signing secret and MAC domain are
unchanged, so a **cookie issued by an older denext keeps verifying**: a missing `issuedAt` is
inferred from `expiresAt - maxAge`, a missing `amr` reads as `[]`, and a missing `mfaPending` means
the session is complete. Nobody is logged out by upgrading.

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
`postgresAuthAdapter({ url })` (or `{ sql }`) is the one every replica can share — see
[Postgres](#postgres) below.

### The contract

Every method may be sync or async — the exported alias for that is `MaybePromise<T>`
(renamed from `Await<T>` in 2.5) — timestamps are **epoch seconds** (never `Date`), and a
miss is `undefined` (never `null`). The users and accounts groups are required; everything
else is optional and gates the feature that needs it.

| Group               | Methods                                                                                                                                                      | Gates                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Users (required)    | `createUser`, `getUser`, `getUserByEmail`, `getUserByAccount`, `updateUser`                                                                                  | Adapter-backed sign-in at all                            |
| Accounts (required) | `linkAccount` — plus optional `unlinkAccount`, `listAccounts`                                                                                                | Account linking                                          |
| Verification tokens | `createVerificationToken`, `useVerificationToken`                                                                                                            | Email verification, reset, magic links, email codes      |
| Credentials         | `getCredential`, `setCredential`, optional `deleteCredential`                                                                                                | `credentials()` without `authorize`, password reset      |
| API tokens          | `createApiToken`, `getApiTokenByHash`, `touchApiToken`, `revokeApiToken`, `listApiTokens`                                                                    | Bearer tokens and `/auth/tokens`                         |
| MFA factors         | `createMfaFactor`, `listMfaFactors`, `updateMfaFactor`, `claimMfaFactorStep`, `deleteMfaFactor`                                                              | TOTP, phone and WebAuthn second factors                  |
| Backup codes        | `getMfa`, `setMfa`, `consumeBackupCode`, optional `deleteMfa`, `replaceMfaSecret`                                                                            | Backup codes; moving a pre-4.0 TOTP secret               |
| Passkeys            | `createPasskey`, `getPasskey`, `listPasskeys`, `updatePasskey`, `deletePasskey`, `createPasskeyChallenge`, `usePasskeyChallenge`                             | WebAuthn sign-in and step-up                             |
| Native sessions     | `createNativeGrant`, `useNativeGrant`, `createNativeSession`, `getNativeSession`, `rotateNativeSession`, `revokeNativeSession`, `revokeNativeSessionsByUser` | [Native session mode](#native-apps-and-account-deletion) |
| SSO                 | `createSsoProvider`, `getSsoProvider`, `listSsoProviders`, `createSsoSession`, `claimSamlMessageId`, …                                                       | [SAML](#saml-providers) (`saml()` and `/auth/v1`)        |
| Users, extra        | optional `getUserByPhone`, `listUsers`, `deleteUser`                                                                                                         | Phone sign-in, `denext auth reseal`, account deletion    |
| Sessions, lifecycle | `sessions?: SessionStore`, `close?()`                                                                                                                        | `session.strategy: "database"`, drain                    |

Three methods are **consume-once** and must be atomic against concurrent callers — a
compare-and-delete or conditional update inside one transaction, not a read followed by a
write. Two racing requests must see exactly one success:

- `useVerificationToken` — delete-and-return. An expired token is consumed too but
  resolves `undefined` (fail closed), never left to be retried.
- `consumeBackupCode` — walk the stored hashes, `await` the caller's constant-time
  comparison, and remove the first match inside the same critical section.
- `claimMfaFactorStep` — succeed only when the step is strictly greater than the factor's
  stored one, and store it in the same operation.
- `usePasskeyChallenge` — delete-and-return, like `useVerificationToken`; `createPasskey`
  stores nothing (and answers `false`) when the credential ID is already registered; and
  `updatePasskey` writes only while the stored counter is still the one the assertion was
  checked against.

A non-atomic implementation turns each of them into a replay window. The full contract,
with every record type, is
[`src/server/auth/adapter.ts`](https://github.com/Brainwires/denext/blob/main/src/server/auth/adapter.ts);
the in-memory implementation is the executable reference, and a shared contract suite
runs against every shipped adapter.

### The SQLite schema

`auth_`-prefixed tables: `auth_users` (with a unique index on the lower-cased email, `WHERE NOT
NULL`, so there is one account per address and any number of address-less users), `auth_accounts`
(primary key `(provider, provider_account_id)`), `auth_verification_tokens` (primary key
`(identifier, purpose)`, so re-sending a link invalidates the previous one — a mailbox can never
hold two working reset links), `auth_credentials`, `auth_api_tokens` (unique on the token hash),
`auth_mfa` (backup codes) and `auth_mfa_factors`, the native session tables (`auth_native_grants`,
`auth_native_sessions`), `auth_passkeys` (primary key the credential ID), `auth_passkey_challenges`
(only the challenge's SHA-256), and the SSO tables (`auth_sso_providers`, `auth_sso_domains`,
`auth_sso_sessions`, `auth_saml_message_ids`) — plus the `/auth/v1` OAuth-server, stored-provider
and Web3 nonce tables.

Schema policy: every open first applies the versioned migrations the release lists that the
file has not recorded in `auth_schema_migrations` — the renames and drops an additive change
can't make. They run once each, in version order, inside one `BEGIN IMMEDIATE` transaction:
SQLite's write lock, so a second process opening the same file waits (`busy_timeout`) and then
finds them recorded; the recorded versions are read again inside the lock, and a failure rolls
the whole batch back for the next open to retry. Each migration is written against the shape it
finds, so on a fresh file it changes nothing and is simply recorded. Then `CREATE TABLE IF NOT
EXISTS`, and every declared column a table is missing is added with `ALTER TABLE … ADD COLUMN`,
decided by `PRAGMA table_info`. No column is retyped, and only a listed migration renames or
drops one. A file that records a migration this release doesn't know (opened by a newer denext)
is reported once on stderr.

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
> one shared volume or use [`postgresAuthAdapter`](#postgres) (or your own `AuthAdapter`
> over your shared database). TOTP secrets
> are sealed before they reach any adapter (see
> [Secrets at rest](#secrets-at-rest)), so the file alone holds no usable second factor.

### Postgres

```ts
import { denextAuth, postgresAuthAdapter } from "denext/server";

denextAuth({
  // …
  adapter: postgresAuthAdapter({ url: Deno.env.get("DATABASE_URL") }),
});
```

The same contract as the SQLite adapter, method for method (the shared contract suite runs against
it on a real server), on a database every replica shares. `url` opens a client on `Deno.SQL`, the
Postgres client built into [denext's Deno toolchain](/docs/toolchain); on stock Deno pass
`sql: fromPostgresJs(postgres(url))` with the npm `postgres` package instead (see
[Databases › Postgres](/docs/database#postgres)) — a `url` there throws an error with
`code: "unsupported"`. A client you pass is never closed by the adapter; one it opened is closed on
drain.

The tables are the SQLite adapter's `auth_*` set plus `auth_sessions` (the adapter's
`sessions` store, also `postgresSessionStore({ sql })`) and `auth_rate_limits`
(`postgresRateLimitStore({ sql })` for `rateLimit.store`, so a lockout holds on every replica).
They are created by **migrations** on first use, through the same runner as an app's own
(`migratePostgres`), recorded in `auth_migrations` under an advisory lock, so replicas starting
together migrate once. Pass `migrate: false` when a deploy step applies them with a more
privileged role, and `schema: "auth"` to keep them out of `public`. Epoch seconds are `BIGINT`,
lists are JSON in `TEXT`, flags are `BOOLEAN`. The consume-once methods are single statements
(`DELETE … RETURNING`, a conditional `UPDATE … RETURNING`), so they hold across replicas, not
just within one process, and `deleteUser` removes everything in one transaction. With
[`@denext/backend`](/docs/backend#postgres), `adapter: backendAuthAdapter()` uses the client
`backend({ postgres })` opened.

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
needs `setCredential`), and `sendVerificationRequest`: [`smtpMailer()`](#sending-mail-over-smtp)
or a function of your own. Every emailed token, from these flows and from the
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

### Sending mail over SMTP

`smtpMailer()` from `denext/server` is a `sendVerificationRequest` that talks SMTP itself —
no npm package, `Deno.connect` / `Deno.connectTls` / `Deno.startTls` underneath:

```ts
import { denextAuth, smtpMailer } from "denext/server";

denextAuth({
  // …
  sendVerificationRequest: smtpMailer({
    host: "smtp.example.com", // port 587 + STARTTLS by default
    // port: 465,             // implicit TLS (or `secure: true`)
    user: Deno.env.get("SMTP_USER")!,
    pass: Deno.env.get("SMTP_PASS")!,
    from: "Example <noreply@example.com>",
  }),
});
```

| Option       | Default                         | What it does                                                                                 |
| ------------ | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `host`       | required                        | The server; its certificate must name it                                                     |
| `port`       | `465` with `secure`, else `587` | The port                                                                                     |
| `secure`     | `true` on port 465              | Implicit TLS from the first byte; otherwise STARTTLS, which must be offered and must succeed |
| `user`       | none                            | AUTH PLAIN (preferred) or LOGIN, whichever the server offers; give `pass` with it            |
| `from`       | required                        | `noreply@example.com` or `Name <noreply@example.com>`                                        |
| `insecure`   | `false`                         | Plaintext without STARTTLS, allowed only to a loopback host (a local mail catcher)           |
| `timeoutMs`  | `10000`                         | Each step's limit: the connect, the TLS handshake, every reply and every write               |
| `clientName` | `"localhost"`                   | The name sent with `EHLO` (letters, digits, `.` and `-` only)                                |
| `caCerts`    | system roots                    | Extra trusted CAs (PEM), for a server with a private CA                                      |
| `render`     | an English message per purpose  | `(params) => ({ subject, text, html? })` — shape the mail for each `purpose`                 |

TLS is not optional: a server that offers no STARTTLS, a STARTTLS that fails, a certificate
that doesn't verify, or bytes the server sent after its `220` to `STARTTLS` (a reply injected
into the plaintext phase) end the send before any credential or address goes out. Every
message opens its own connection and closes it, so no session — and no authenticated state —
is shared between two messages, or between tenants. Every header value is refused if it
holds a CR or LF, the recipient must be one plain `local@domain.tld` address (a list, an
angle bracket or an SMTP argument smuggled into it is refused), a non-ASCII subject or sender
name is RFC 2047-encoded, and the body is quoted-printable with dot-stuffing. `mailer.send({ to,
subject, text, html? })` sends any other message the same way. A refusal is an `SmtpError`
(with the server's reply `code`) or an `SmtpMessageError`; neither carries the password or the
message.

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

**Verifying an address.** `requestEmailVerification(authConfig, userOrEmail)` mails a link to
`verifyPath?token=…&email=…`; it sends nothing for an address with no account, one already verified,
or a value that isn't exactly one address. Opening it hits `GET {basePath}/verify`, which sets the
user's `emailVerified` (epoch seconds, through `updateUser`), fires `emailVerified`, and redirects
to `pages.verifyRequest` with `?verified=1` — or, for a wrong, spent or expired token, to
`pages.error` with `?error=invalid_token`. `POST {basePath}/verify` takes the same two fields from a
form or a JSON body, and `verifyEmail(authConfig, { email, token })` is the function underneath (it
answers `{ ok: true, user }` or `{ ok: false, error: "invalid_token" }`). Verifying signs nobody in
and leaves the account's password alone — someone else may have registered the address, so word the
mail so that ignoring it is safe.

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
password with the configured `hasher`, stores it with `setCredential`, **removes every
passkey** of the user, **revokes every server-side session** (`sessionRevoked`) and bearer API
token — a reset signs out every device and removes passkeys, so nothing a thief set up with a
stolen session survives the owner taking the account back — fires `passwordReset`, and lands on
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
  gets no mail. The functions resolve `{ ok: true }` alike (`{ ok: false, error: "throttled",
  retryAfter }` once the budget is spent) and throw only for a
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
that `GET {basePath}/providers` echoes — and both take `{ id?, name?, allowSignUp? }`
(`magicLink` also `confirm`, on by default — below).
Configuring one without `sendVerificationRequest`, or with an adapter missing
`createVerificationToken`, `useVerificationToken`, `getUserByEmail`, `createUser` or
`updateUser`, makes `denextAuth()` throw.

| Request                                        | What it does                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /callback/email` — `{ email }`           | Mails a link to `/callback/email?token=…&email=…` (10 minutes by default)                                      |
| `GET /callback/email?token=…&email=…`          | The click: renders the confirmation page — or, with `confirm: false`, consumes the token and signs the user in |
| `POST /callback/email-otp` — `{ email }`       | Mails a code (6 digits, 5 minutes by default) as `token`; `url` never carries it                               |
| `POST /callback/email-otp` — `{ email, code }` | Redeems the code (spaces and hyphens ignored) and signs the user in                                            |

A body carrying a `token` (a magic-link provider — how a JS client redeems) or a `code` (an
email-code provider) redeems; anything else sends. A `callbackUrl` sent along rides in the
magic link. A code provider has no GET — a code is never put in a URL — so a code mail's
`url` opens `pages.verifyRequest` with `?email=`, the page the code is typed into. From the
client:

```ts
await signIn("email", { credentials: { email } }); // { ok: true }, whether or not mail went out
await signIn("email-otp", { credentials: { email, code } }); // { ok: true, user } or { ok: true, mfa: "required" }
// a wrong code: { ok: false, error: "invalid_credentials", status: 401 }; a spent budget:
// { ok: false, error: "throttled", status: 429, retryAfter } — a refusal never rejects
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

**Pre-account hijacking.** An existing account whose `emailVerified` is unset was set up by someone
who never proved the mailbox — possibly an attacker who registered the victim's address with a
password and is waiting for the victim to sign in by email. So before a first email sign-in marks
that address verified, everything set up without the proof is retired: the password (deleted, or —
with an adapter that has no `deleteCredential` — replaced with the hash of a random secret), any
TOTP factor and its backup codes, every passkey, every bearer API token and every server-side
session (`sessionRevoked`); then `emailVerified` fires. (A password reset into such an account does
the same.) An adapter that holds passkeys it can't delete — or `passkeys` configured over an adapter
without `listPasskeys` — fails the step closed. Passkey registration is refused (`403
email_unverified`) while an account's address is unverified, so a passkey can't be planted ahead of
the owner in the first place. If any step fails, the address stays unverified and the redeem gets
the generic failure. An account that was already verified keeps all of it. Stateless cookie sessions
end too, through the user's `sessionsValidAfter` (see [Revocation](#revocation)).

**The confirmation page.** Opening a magic link does not spend it: the link's GET renders a
small page — "Continue as **ada@example.com**?" — whose button POSTs the token back to the
same URL, and only that POST spends it. A mail gateway that pre-fetches links to scan them
(any number of times) changes nothing, and a link someone else requested signs nobody in
without a press of a button that names the account. `confirm: false` restores Auth.js's
behaviour, where the GET spends the link and signs in; a scanner can then burn it first, and
an attacker's link signs the clicker into the attacker's account.

```ts
providers: [magicLink()], // confirm: true is the default
providers: [magicLink({ confirm: false })], // the GET signs in
```

The page is denext's own: no script, `default-src 'none'` with its one style allowed by hash,
`frame-ancestors 'none'` and `X-Frame-Options: DENY` (its button can't be clickjacked),
`form-action 'self'`, `no-store`, and `Referrer-Policy: same-origin` — the URL carries the
token, so it never leaks cross-origin, while the form's POST still carries this origin in
`Origin`, which the same-origin gate on the redeem requires. Every value from the link is
HTML-escaped. A link without a valid address or token goes to the error page instead.

## Phone sign-in

```ts
import { denextAuth, phoneOtp, sqliteAuthAdapter } from "denext/server";

denextAuth({
  // …
  adapter: sqliteAuthAdapter({ path: "auth.db" }),
  sendSms: ({ phone, message }) => sms.send(phone, message), // or hooks.sendSms
  providers: [phoneOtp()],
});
```

`phoneOtp()` texts a one-time code to an E.164 number. It is a `type: "phone"` provider on
`{basePath}/callback/:provider` — id `"phone"` and name `"Phone code"` by default, both
echoed by `GET {basePath}/providers` — and takes `{ id?, name?, allowSignUp? }`. Configuring it
without `sendSms` or `hooks.sendSms`, or with an adapter missing `createVerificationToken`,
`useVerificationToken`, `getUserByPhone`, `createUser` or `updateUser`, makes `denextAuth()`
throw.

| Request                                    | What it does                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `POST /callback/phone` — `{ phone }`       | Texts a code (`email.otpDigits`, 6; `email.otpMaxAge`, 5 minutes) through the SMS sender |
| `POST /callback/phone` — `{ phone, code }` | Redeems the code (spaces and hyphens ignored) and signs the user in (`amr: ["sms"]`)     |

There is no GET (a `405`): a code is never put in a URL. The number is normalised to E.164
(`+`, then 8–15 digits, once spaces, dashes, dots and parentheses are dropped); anything else
sends nothing. The SMS sender gets `{ phone, otp, message: "Your code is …", channel: "sms",
type: "sms", user? }` after the response, and a delivery failure is logged without the code.
From the client: `signIn("phone", { credentials: { phone } })`, then
`signIn("phone", { credentials: { phone, code } })`.

The flow mirrors the email code exactly. **Sending answers the same for everyone**: a known
number, an unknown one under `allowSignUp: false` (no text, comparable work) and an invalid
value all get `{ ok: true }` (a form: a `303` to `pages.verifyRequest` with `?sent=1`), and the
per-number + per-IP send budget (the verification limiter, spent before the number is looked
up) is the only thing that changes the answer, to a `429`. **Redeeming**: one generic
`401 { error: "invalid code" }` (a form: `?error=Verification`) for every failure, 5 failures per
5 minutes per number plus the IP-wide bucket, codes stored as an HMAC under the auth `secret` in
their own `"sms"` token space. **Who signs in**: the account with that number
(`getUserByPhone`), else a new user `{ phone, phoneVerified }` when sign-up is allowed
(`createUser`, `isNewUser`); `callbacks.signIn` can veto, and an enrolled user owes a second
factor. **Pre-account hijacking**: an existing account whose `phoneVerified` is unset first loses
its password, second factors, passkeys, bearer tokens (`apiTokenRevoked` with
`"phone_verified"`) and server-side sessions — the same eviction a first email proof runs — and
then `phoneVerified` fires.

## Anonymous sign-in

```ts
denextAuth({ /* … */ anonymous: true, adapter: sqliteAuthAdapter({ path: "auth.db" }) });
// the client
await fetch("/auth/anonymous", { method: "POST", headers: { accept: "application/json" } });
```

With `anonymous: true`, `POST {basePath}/anonymous` (same-origin, captcha when configured, the
per-IP sign-in-start budget) creates a user with no identifier (`isAnonymous: true`,
`createUser`) and signs it in: provider `"anonymous"`, `amr: ["anonymous"]`, and a session user
carrying `isAnonymous: true`, which `@denext/backend` turns into `is_anonymous: true` in the
claims a cookie session's queries run with. Without the flag the endpoint does not exist. The
same `anonymous` flag turns on `signInAnonymously()` on `/auth/v1`, and both keep the flag in
the adapter's `isAnonymous`, so either path sees the other's anonymous users.

**Conversion.** An anonymous user becomes permanent by proving an identifier from its session:
when a request carrying a complete (not second-factor-owed) anonymous session redeems an email
link or code, or a phone code, for an address or number **no account has**, the proof is
attached to the anonymous user — same id, the verified email or phone added, `isAnonymous`
cleared — and `userConverted` fires (with the `signIn` that follows, `isNewUser: false`).
`allowSignUp: false` does not block a conversion, since it creates no user, and a send from an
anonymous session goes out under it for the same reason. An identifier that **already has an
account** signs into that account instead; the anonymous user is left as it was — nothing is
merged — so move any data it owned yourself if you want to keep it. A pending session never
converts.

## Captcha

```ts
denextAuth({
  // …
  captcha: { provider: "turnstile", secret: Deno.env.get("TURNSTILE_SECRET")! }, // or "hcaptcha"
});
```

One `captcha` protects both paths. On denext's endpoints a solved challenge is required by the
credentials sign-in POST, an email provider's **send** (a magic link or code), a phone
**send**, `POST /anonymous` and `POST /reset` — never by a redeem, the link click, `/verify` or
`/reset/confirm`. The token is read from the body field `captchaToken`, `captcha_token`,
`cf-turnstile-response` or `h-captcha-response` (the widgets' own hidden fields, so a plain
HTML form works), or the `x-captcha-token` header, and checked with the provider (the client
IP, by the same `trustForwardedHeaders` rule as the rate limiters, goes along as `remoteip`). A
refusal is `400 { error: "captcha_failed" }`, or for a form a `303` to `pages.error` (else
`pages.signIn`) with `?error=CaptchaFailed`; a refused sign-in fires `signInFailed` with
`"captcha_failed"`. On `/auth/v1` the same check reads supabase-js's `captchaToken` and answers
GoTrue's `captcha_failed`.

The provider is only asked within a per-client-IP budget, spent first: 30 tokens per address
per minute by default (`rateLimit.captcha`, see [Rate limiting](#rate-limiting)). Past it the
request is a `429` with no provider call — `{ error: "too many attempts" }` with
`Retry-After` on denext's endpoints, GoTrue's `over_request_rate_limit` on `/auth/v1`. A
missing or oversized token is refused without spending.

The check runs **before** any adapter lookup and before the request spends a rate-limit budget,
so refused requests can't drain a user's send or sign-in budget. A provider error, a non-2xx
answer or no answer within 10 seconds counts as unsolved — the endpoints fail closed.

## Hooks

`hooks` takes Supabase's auth hooks as functions, and each applies to denext's endpoints and
`/auth/v1` alike (`backend({ supabase: { auth: { hooks } } })` may set its own for `/auth/v1`):

- **`sendSms`** delivers every SMS — phone sign-in codes, phone MFA challenges, `/auth/v1`'s phone
  flows — in place of `sendSms`.
- **`sendEmail`** delivers every auth email in place of `sendVerificationRequest`, with Supabase's
  Send Email Hook payload: `email_data.email_action_type` is `signup` (email verification),
  `recovery` (password reset), `magiclink` (a magic link) or `email` (an email code); `token` is
  the code or link token; `action_link` the ready-to-click link (for a code, the page it is typed
  into); `site_url` the `canonicalOrigin`; `user` the account in GoTrue's JSON shape (or
  `{ email }` when the address has none). On denext's endpoints `token_hash` and `redirect_to`
  are `""`: denext's links verify through `action_link`, not `/auth/v1/verify`.
- **`customAccessToken`** shapes the claims of every session: an `/auth/v1` access token when it is
  minted, and the `request.jwt.claims` a cookie or native session's queries run with through
  `@denext/backend` (`db()`, auto-REST, storage). It receives `{ user_id, claims,
  authentication_method }` and returns `{ claims }`; `sub`, `role`, `aud`, `session_id`, `iat`,
  `exp`, `aal`, `is_anonymous` and `email` are restored after it runs. For a denext session it runs
  once per session and its result is reused for 60 seconds (up to 1000 sessions), not on every query
  (the hook on `denextAuth()` is used, else the one under `backend({ supabase: { auth: { hooks } }
  })`) — so a claim it reads from the database can be up to a minute old. A hook that throws or
  returns no claims object **fails the request**; a query never runs with half-shaped claims.

## Two-factor authentication (TOTP)

A user who enrolls an authenticator app is asked for a code at every sign-in, whatever the
first factor — a password, an OAuth / OIDC provider, a magic link or an emailed code. It
needs an adapter implementing the MFA factor group and the backup codes (the in-memory, SQLite
and Postgres adapters do); without it nobody is ever asked, and the `/mfa*` endpoints are a
plain 404. A user may hold several factors — TOTP authenticators, phones and WebAuthn
authenticators — and the same factors serve [`/auth/v1`](#one-factor-store-for-both-sign-in-paths)
when `backend({ supabase })` is on.

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

1. `POST {basePath}/mfa/enroll` / `enrollTotp(authConfig, session)` mints a 160-bit secret, stores
   it **unconfirmed**, and returns `{ ok: true, secret, uri }` — the base32 secret for manual entry
   and the `otpauth://totp/…` URI (SHA-1, 6 digits, 30 seconds; the account label is the user's
   email, else their id) to render as a QR code — `totpQrSvg(uri)` does that with no library
   (below). Enrolling again replaces an unconfirmed enrollment. With a confirmed TOTP factor on
   file, enrolling another (a second authenticator) needs a session whose own second factor is fresh
   (`mfa.freshness`), else it is a `409` (`error: "already_enrolled"` from the function); a pending
   session never enrolls next to a verified factor of any kind. From a complete session the route
   also needs a recent sign-in (`authTime` within `mfa.freshness`, five minutes at least) and
   answers `403 { error: "reauth_required" }` otherwise, so a stolen session can't enroll a factor
   of its own. The function applies the same rule and answers `{ ok: false, error: "reauth_required"
   }`, so a Server Action gets it for free.
2. `POST {basePath}/mfa/confirm` with `{ code }` / `confirmTotp(authConfig, { user, code })`
   checks a first code from the app, marks the factor confirmed and returns
   `{ ok: true, backupCodes }` — `mfa.backupCodes` single-use codes formatted `xxxxx-xxxxx`,
   in plaintext **exactly once**, stored only as `hasher` hashes. Show them then. A failure is
   `{ ok: false, error: "invalid_code" }` (wrong or replayed) or `"not_pending"` (nothing to
   confirm).

```ts
"use server";
import { auth, confirmTotp, enrollTotp } from "denext/server";
import { authConfig } from "../lib/auth-config.ts";

export async function startEnrollment() {
  const session = await auth();
  // { ok: true, secret, uri } | { ok: false, error: "already_enrolled" | "reauth_required" }
  return session ? await enrollTotp(authConfig, session) : null;
}

export async function confirmEnrollment(code: string) {
  const session = await auth();
  // { ok: true, backupCodes } | { ok: false, error: "invalid_code" | "not_pending" }
  return session ? await confirmTotp(authConfig, { user: session.user, code }) : null;
}
```

Unlike the endpoints, the functions spend no attempt budget, so a Server Action that checks a
code spends one first with `spendMfaAttempt(authConfig, { userId })` — the same per-user budget
the `/mfa*` endpoints spend (`rateLimit.mfa`), answering `{ ok: true }` or
`{ ok: false, error: "rate_limited", retryAfter }`. `examples/auth` does exactly this.

**The QR code.** `totpQrSvg(uri, options?)` renders the URI as SVG markup with denext's own
ISO/IEC 18004 encoder — byte mode, Reed–Solomon error correction, the smallest version that
fits, the lowest-penalty mask — and no dependency. The markup is one `<path>` on a light
background with a 4-module quiet zone, no script and no external reference, so inlining it is
safe under the strict CSP:

```ts
// app/settings/two-factor/actions.ts
"use server";
import { auth, enrollTotp, totpQrSvg } from "denext/server";
import { authConfig } from "../../../lib/auth-config.ts";

export async function startEnrollment() {
  const session = await auth();
  const enrollment = session ? await enrollTotp(authConfig, session) : null;
  if (!enrollment?.ok) return null;
  // The client renders `qr` with <div dangerouslySetInnerHTML={{ __html: qr }} />, and shows
  // `secret` for an app that can't scan.
  return { secret: enrollment.secret, qr: totpQrSvg(enrollment.uri, { size: 200 }) };
}
```

| Option       | Default                          | What it sets                                                   |
| ------------ | -------------------------------- | -------------------------------------------------------------- |
| `ecc`        | `"M"`                            | Error correction: `"L"`, `"M"`, `"Q"` or `"H"` (7–30 % damage) |
| `margin`     | `4`                              | The light quiet zone, in modules (the standard asks for 4)     |
| `size`       | none (fills its box)             | `width` / `height` in CSS pixels                               |
| `color`      | `"#000"`                         | Dark modules — a hex colour or a CSS colour keyword            |
| `background` | `"#fff"`                         | Light modules and the quiet zone                               |
| `title`      | `"Authenticator app setup code"` | The `<title>` accessible name; `""` omits it                   |

It refuses anything but an `otpauth://` URI (`TypeError`) and a colour that isn't a hex value
or a keyword. The URI carries the secret: render it only on the enrollment page, never in a
cached response or a URL.

**The step-up.** When a first factor succeeds for a user who owes a code, the session is
minted **pending**: it lasts 15 minutes (never more than `maxAge`), is never slid forward,
and `auth()` returns `null` for it — so `requireAuth` redirects to `pages.mfa` (else the
sign-in page) with a `callbackUrl`, `requireSession` answers `401`, Live `authorize` and
Server Actions refuse, and `/tokens` mints nothing. `GET {basePath}/session` answers
`{ user: null, expires: null, mfa: "required" }`, which `useSession()` reports as
`"mfa-required"`. The
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

`POST {basePath}/mfa` takes a TOTP code (from any of the user's TOTP factors), a backup code (the
hyphen is optional), or — after `POST {basePath}/mfa/challenge` with `{ factorId }` texted a phone
factor a code through `sendSms` — `{ code, challengeId, factorId }`. A challenge is single-use,
right or wrong, and lives five minutes; sends draw on the verification-send budget, not the code
budget. A right one mints a **fresh**, complete session — the pending one is discarded (its store
record deleted), never upgraded in place, so there is nothing to fixate — with `amr` extended by
`totp`, `sms` or `bcp`, fires `signIn`, and answers `{ ok: true, user }` or a `303` to the
`callbackUrl`. A wrong one is a `401`, or for a form a `303` back to `pages.mfa` with
`?error=CredentialsSignin`, and fires `signInFailed` with `"invalid_mfa_code"`. The endpoint serves
only a pending session: none is a `401`, a complete one a `403`. Under `mfa.required: "always"` a
user with no factor enrolls from the pending session — `/mfa/enroll`, then `/mfa/confirm`, whose
answer also carries the new session's `user`, because confirming completes the step-up.

**Every code works once.** A TOTP code is accepted within ±`mfa.window` steps, and its step is then
claimed on its factor through the adapter's atomic `claimMfaFactorStep`, so it can't be presented
twice — not even to confirm an enrollment and then step up with it. A backup code is spent through
the atomic `consumeBackupCode`. Every code check on `/mfa`, `/mfa/confirm` and `/mfa/disable` spends
one unit of the per-user budget — 5 per 5 minutes (`rateLimit.mfa`), plus an IP-wide bucket at ten
times that — and **every** attempt counts, not only failures, so a correct guess can't reset the
counter.

**Disabling.** `POST {basePath}/mfa/disable` needs a complete session **and** a fresh
second factor: a `code` that verifies now, or — with no code — a session whose own step-up
(`amr` `totp` / `bcp`, or `mfa` from a passkey step-up) is at most `mfa.freshness` seconds
old, measured from `authTime`, so it holds with sliding expiry on too. A session issued before
2.5.0-rc.3 has no `authTime` and, while sliding is on, must send a code. Anything else is a
`403`. Disabling deletes **every TOTP factor** the user holds (`deleteMfaFactor`); the backup
codes go too (`deleteMfa`, else an empty record in their place) unless a verified phone or
WebAuthn factor remains, which keeps the user enrolled. `disableTotp(authConfig, userId)` does
the same with no freshness check — gate it yourself.

For a settings page, `mfaStatus(authConfig, userId)` answers `{ enrolled, pendingConfirmation,
backupCodesRemaining }` (`enrolled` means a confirmed factor, as in `mfa.required: "enrolled"`), and
`verifySecondFactor(authConfig, { userId, code })` checks a code (claiming or spending it) — with
`challengeId` and `factorId` an SMS challenge's code — and answers `{ ok: true, method: "totp" |
"sms" | "bcp", factorId? }` or `{ ok: false, error: "invalid_code" | "not_enrolled" }`. The RFC 6238
primitives underneath are exported too: `generateTotpSecret()`, `totpAuthUri({ secret, account,
issuer })`, `totpQrSvg(uri)`, `verifyTotp(secret, code, { window })` — which returns the matched
`step` and does **not** stop a replay, so claim it — plus `generateBackupCodes(hasher, count)` and
`backupCodeMatcher(hasher, code)`.

### Secrets at rest

A TOTP verifier needs the shared secret itself, so it can't be hashed like a backup code.
Instead denext seals it before it reaches the adapter — any adapter, your own included — and
opens it only to check a code:

- **AES-256-GCM** (NIST SP 800-38D) under a key derived from the auth `secret` with
  **HKDF-SHA-256** (RFC 5869) and a dedicated label, so it is independent of the key that
  signs session cookies. Each seal draws a fresh random 96-bit nonce, and the factor (user id
  and factor id) is bound in as additional data, so a sealed secret copied onto another
  factor's row does not open.
- The stored value carries its version, nonce and ciphertext together:
  `totp.v1.<nonce>.<ciphertext>`. Store it as an opaque string.
- **Rotation.** With `secret: [current, previous]`, a factor sealed under `previous` still
  opens, and is re-sealed under `current` when a TOTP code from that factor passes — through
  the adapter's `updateMfaFactor`. `denext auth reseal` re-seals the rest without waiting for a
  code (see [Re-sealing after a rotation](#re-sealing-after-a-rotation)); remove `previous` once
  it reports zero remaining. **Replacing** the secret instead of listing both bricks every factor
  sealed under the old one: it **fails closed** — no TOTP code verifies, the user still owes a
  second factor, a backup code still works, and the logger warns with the user id (never the
  secret).
- **Recovery.** A user with a backup code (or a passkey with user verification) signs in,
  disables the factor at `/mfa/disable` and enrolls again. A user with neither is locked out of
  TOTP until an administrator verifies them out of band and calls `disableTotp(authConfig,
  userId)`. `enrollTotp` keeps answering `already_enrolled` over such a factor on purpose: a
  pending session — a password alone — may enroll, and must never be able to replace a second
  factor.
- **Existing rows.** Before 4.0 the one TOTP secret lived in the user's MFA record. The first time a
  user's factors are read it moves, as stored, into a TOTP factor (verified when the record was
  confirmed; its spent step kept), and the record keeps only the backup codes — the move clears the
  record's secret with `replaceMfaSecret`'s compare-and-swap (or `setMfa`). It needs no key: a
  secret no configured `secret` opens moves too, and the user stays enrolled. Sealed for the user,
  or plaintext from before sealing, it keeps verifying and is re-sealed for the factor after the
  first code it accepts. A tampered row, an unknown version or anything that is neither sealed nor
  base32 is refused, never used as a plaintext secret.
- **A writable database is out of scope.** A plain base32 value always opens as a legacy row
  (no per-row marker says it was ever sealed), so whoever can write the MFA table can swap a
  sealed secret for a plaintext one they know. That access could equally rewrite a password
  hash or delete the factor; sealing protects a copied database, not a writable one.

### Re-sealing after a rotation

`denext auth reseal` (contributed by the `denextAuth()` plugin, so it runs against your config's
adapter and `secret`) opens every TOTP factor with the configured secrets and re-seals each one
that a retired secret — or a pre-sealing plaintext row, or a pre-4.0 record — still holds under
the current one, writing it back through `updateMfaFactor`:

```sh
denext auth reseal --dry-run   # counts only, writes nothing
denext auth reseal             # re-seal, then verify
denext auth reseal --json      # the report as JSON (for a script or a scheduler)
denext auth reseal --page-size 500   # users read per page (default 200, at most 1000)
```

```
auth reseal:
  users scanned:      1204
  TOTP factors:       311
  already current:    250
  re-sealed:          61
  remaining:          0
No factor needs a retired secret: secrets after the first can be removed.
```

- **Idempotent and resumable.** Each factor is written on its own; a factor already sealed under
  the current secret is left alone, so an interrupted run is finished by running it again.
- **Verified.** A real run ends with a read-only pass over every user, and that pass's count is
  `remaining`: when it is `0`, no factor needs a retired secret any more. A run that leaves any
  behind exits `1`.
- **Both sign-in paths.** `/auth/v1`'s TOTP factors (`supabase.auth.mfa.enroll`) live in the
  same store, sealed the same way, so they are covered too.
- **Counts only.** Nothing prints, logs or returns a secret. A factor no configured secret opens
  is reported as `unopenable` and never written — removing a retired secret can't change it, and
  `disableTotp(authConfig, userId)` is its user's recovery.
- **As a job.** The same function is `resealTotpFactors(config, { dryRun?, pageSize? })` from
  `denext/server`; it needs an adapter with `listUsers` (every first-party adapter has it):

```ts
// jobs/reseal.ts — `denext job reseal`
import { activeAuthConfig, defineJob, resealTotpFactors } from "denext/server";
export default defineJob({
  description: "re-seal TOTP factors under the current auth secret",
  handler: async () => console.log(await resealTotpFactors(activeAuthConfig())),
});
```

### One factor store for both sign-in paths

With `backend({ supabase })` the `/auth/v1` API (`supabase.auth.mfa.*`) reads and writes the
same factors as denext's cookie sign-in, so a factor enrolled either way is enforced both ways:

- **Who owes a factor.** Any verified factor — TOTP, phone or WebAuthn — makes a user enrolled:
  a cookie sign-in is pending until `/mfa` (or a passkey step-up), and an `/auth/v1` session is
  `aal1` with `nextLevel: "aal2"` until `/factors/:id/verify`. An `aal1` access token that owes
  a factor is a session `auth()` reads as `null` (it fails closed, like a pending cookie), so
  `requireSession` and Server Actions refuse it. Row-level security reads the token's own
  claims (`auth.jwt() ->> 'aal'`), as on Supabase: a policy that needs the second factor checks
  for `aal2`.
- **Adding a factor needs the one already held.** Once a user holds a verified factor, an
  `aal1` session can't enroll another, verify a new one or register a passkey through
  `/auth/v1` (`403 insufficient_aal`), and a pending cookie session can't enroll or confirm a
  TOTP factor — otherwise a password alone could add a factor of its own and step up with it.
- **TOTP** factors enrolled through `/mfa/enroll` or `POST /factors` are interchangeable; each
  claims its own steps, so a code is accepted once across both paths.
- **Phone** factors are enrolled through `/auth/v1` (`mfa: { phone: true }` and an SMS sender:
  `denextAuth({ sendSms })`, `hooks.sendSms`, or the `/auth/v1` option); the cookie step-up
  texts one with `/mfa/challenge`.
- **WebAuthn** factors (`factorType: "webauthn"`, with `denextAuth({ passkeys })` configured)
  are passkeys: the first challenge is a registration (`webauthn.type: "create"`), later ones
  assertions limited to that credential. The client's `rpId` / `rpOrigins` must name the
  configured relying party. Deleting the passkey deletes the factor. A passkey registered
  through `/passkey/register` or `supabase.auth.passkey` is a sign-in method, not a factor: it
  makes nobody enrolled, but under user verification it is two factors on its own (`aal2`).
- **Backup codes** are `/auth/v1`'s recovery codes (`/factors/recovery-codes*`, listed as one
  `recovery_code` factor): the same hashes, spent once by either path. Minting or regenerating
  them needs `aal2` once a factor is verified.
- **Passkeys** through `/auth/v1` (`/passkeys/registration/*`, `/passkeys/authentication/*`,
  `GET /passkeys`, `PATCH|DELETE /passkeys/:id`, `admin/users/:id/passkeys`) use the passkey
  store `/passkey*` does. Registration and removal need a sign-in within `mfa.freshness` and a
  confirmed address; a challenge is single-use and bound to the `challenge_id` it was issued
  with.

## Passkeys (WebAuthn)

A passkey signs a user in with the device's own unlock — Face ID, Touch ID, Windows Hello, a
security key — and nothing to type or phish. `passkeys` turns them on; the relying party is
`canonicalOrigin`'s host unless you name one:

```ts
denextAuth({
  // …
  canonicalOrigin: "https://app.example.com",
  adapter: sqliteAuthAdapter({ path: "auth.db" }),
  passkeys: true, // or { rpId: "example.com", rpName: "Example", userVerification: "required" }
});
```

| Key                | Default                  | What it sets                                                                                                  |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `rpId`             | `canonicalOrigin`'s host | The RP ID credentials are scoped to — the host, or a registrable suffix of it to span subdomains              |
| `rpName`           | the RP ID                | The name an authenticator may show                                                                            |
| `origins`          | `[canonicalOrigin]`      | Origins a ceremony may come from, matched exactly; each must be `https:` (or `http://localhost`) on the RP ID |
| `corsOrigins`      | none                     | Web origins (also in `origins`) allowed to call the passkey endpoints from another origin, with credentials   |
| `userVerification` | `"required"`             | `"preferred"` accepts a presence-only assertion — one factor instead of two                                   |
| `timeout`          | `300`                    | Seconds a ceremony's challenge lives (`30–900`)                                                               |

`origins` lists what `clientDataJSON.origin` may say; it does not open the endpoints to other
origins. Every `/passkey/*` row is same-origin gated (`403` otherwise) unless the caller is one of
`corsOrigins`. A native Android app (`android:apk-key-hash:…` is accepted in the signed client
data) has no web origin, so it can't call the routes cross-origin — such a client needs endpoints
of your own.

**A front end on another origin.** With the auth server at `https://auth.example.com` and the
pages at `https://www.example.com` (one RP ID, `example.com`):

```ts
passkeys: {
  rpId: "example.com",
  origins: ["https://auth.example.com", "https://www.example.com"],
  corsOrigins: ["https://www.example.com"], // each must also be in `origins`
},
```

The passkey endpoints then answer their preflights (before `middleware.ts`) and send credentialed
CORS headers (`Access-Control-Allow-Origin` echoing exactly that origin,
`Access-Control-Allow-Credentials: true`, `Vary: Origin`) to the listed origins only; any other
origin is still `403`. Each ceremony is bound to the origin that started it: the options request's
exact `Origin` is stored with the challenge, and the verifying request must come from that same
origin with client data naming it — so a ceremony started on `www` can't be finished same-origin,
from another listed origin, or with client data from another accepted origin, and a same-origin
ceremony can't be finished cross-origin. The per-tab `ceremonyId` is required as before. On that
front end, pass the server's origin to the client calls — `signInWithPasskey({ origin:
"https://auth.example.com" })`, `registerPasskey({ origin: … })` — which then send credentials
(`credentials: "include"`); the session cookie is the auth server's, so the two origins must be
same-site for the browser to send it.

It needs an adapter with the passkey group (both shipped adapters have it), and a relying
party that doesn't come from the request: with neither `rpId` nor `canonicalOrigin`,
`denextAuth()` throws.

**In the browser**, `denext/client` runs each ceremony:

```tsx
"use client";
import { registerPasskey, signInWithPasskey } from "denext/client";

// On the sign-in page — usernameless: the device offers this site's passkeys.
const result = await signInWithPasskey({ callbackUrl: "/dashboard" });
// { ok: true } (navigated), { ok: true, mfa: "required" }, or { ok: false, error: "cancelled" | … }

// In account settings, from a recent sign-in.
await registerPasskey({ name: "MacBook" }); // { ok: true, passkey } | { ok: false, error }
```

`passkeysSupported()` says whether the browser has WebAuthn at all. A refused call resolves
`{ ok: false, error }` — `"cancelled"`, `"invalid"`, `"unauthorized"`, `"reauth_required"`,
`"email_unverified"`, `"code_required"`, `"exists"` (the server already has the credential,
or the authenticator holds one it was told to exclude), `"rate_limited"`, `"network"` or
`"unsupported"` — and never throws.

**What the server checks** (WebAuthn Level 3): the client data's type, challenge, origin
and `crossOrigin` (a call from a cross-origin iframe is refused); the authenticator data's
RP ID hash, User Present, User Verified under `"required"`, and the backup flags; the
credential's algorithm — ES256, RS256 or Ed25519, nothing else; the attestation statement —
`none`, `packed` (self, or an `x5c` leaf whose signature and certificate profile are checked),
`tpm`, `android-key`, `apple` or `fido-u2f`, each by its WebAuthn Level 3 §8 procedure (below),
a certificate chained to the authenticator vendor's root only with
[`attestation.mds`](#attestation-the-fido-metadata-service); and each assertion's
signature, its backup-eligibility flag against the stored record, and the signature counter.
A counter that doesn't increase means a cloned authenticator: the sign-in is refused and
`signInFailed` fires. A counter that stays at `0` — a synced passkey keeps none — is fine.

Every challenge is 32 random bytes, stored only as its SHA-256 through the adapter's atomic
`usePasskeyChallenge`, and bound to a random `ceremonyId` that the options answer hands the tab that
asked (only its SHA-256 is stored) and the verifying POST must carry back (the client helpers do): a
replayed response, a swapped or missing id, or a response relayed to another browser without the id
is refused, and the challenge is spent either way. Each ceremony is its own, so several tabs of one
browser can run one at the same time. Registration needs a complete session that signed in within
`mfa.freshness` (five minutes at least), like `/mfa/enroll`, so a stolen session can't plant a
passkey of its own — and an account with an email address needs it verified (`403
email_unverified`), so nobody can leave a passkey on an account whose mailbox they never proved. A
password reset removes every passkey of the account.

**Factors.** Under `userVerification: "required"` a passkey proves possession and the user's
PIN or biometric, so it **completes a sign-in on its own** — a user with TOTP isn't asked for a
code — with `amr: ["hwk", "mfa"]`. Under `"preferred"` a presence-only assertion is one factor
(`amr: ["hwk"]`) and the usual step-up follows — **with a code**: one key is one factor, so a
session whose first factor was a passkey is never offered a passkey step-up
(`403 code_required`, and an assertion is refused). Any other pending session (a password, an
email link, OAuth) can also **step up with a passkey**: `signInWithPasskey()` while
`pendingMfaSession()` is set offers that user's passkeys and, on success, mints a fresh
complete session (`amr` gains `hwk` and `mfa`), the way `POST {basePath}/mfa` does with a
code. It spends the same per-user MFA budget.

For a settings page, `listPasskeys(authConfig, userId)` answers `{ id, name, createdAt,
lastUsedAt, backedUp, transports }[]` and `deletePasskey(authConfig, { userId, id })` removes
one — gate that yourself, as `DELETE {basePath}/passkeys/:id` does with the recent-sign-in rule.

**Attestation formats.** A registration's statement is verified whatever its format; one that
fails is refused (`400 { code: "attestation" }`):

| `fmt`         | What is checked (WebAuthn L3)                                                                                                                                                                                                                                                                                                                                       | Type             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `none`        | The statement is empty (§8.7)                                                                                                                                                                                                                                                                                                                                       | `none`           |
| `packed`      | Self: the credential key signs. `x5c`: the leaf signs, and its §8.2.1 profile (v3, subject C/O/OU/CN, not a CA, a matching AAGUID extension)                                                                                                                                                                                                                        | `self` / `basic` |
| `tpm`         | `ver` 2.0; `pubArea` is the credential key; `certInfo` is a TPM-generated certify statement whose `extraData` hashes this ceremony and whose name is `pubArea`'s; the AIK signs `certInfo`; the AIK certificate's §8.3.1 profile (v3, empty subject, TPM manufacturer / model / version in its SAN, `tcg-kp-AIKCertificate`, not a CA, a matching AAGUID extension) | `attca`          |
| `android-key` | The leaf signs and its key is the credential key; its key description's challenge is this ceremony's, no `allApplications`, `origin` generated, `purpose` sign (over the software- and TEE-enforced lists together)                                                                                                                                                 | `basic`          |
| `apple`       | The certificate's nonce extension holds this ceremony's hash, and its key is the credential key                                                                                                                                                                                                                                                                     | `anonca`         |
| `fido-u2f`    | One P-256 certificate signs the U2F registration data; the credential key is P-256                                                                                                                                                                                                                                                                                  | `basic`          |

A statement signature may use ES256 / ES384 / ES512, RS256 / RS384 / RS512 / RS1, PS256 / PS384 /
PS512 or EdDSA. Another format (`android-safetynet`, `compound`) is refused — or, under
`attestation.mds.allowUnattested`, registers as unattested.

### Attestation: the FIDO Metadata Service

By default every supported attestation registers: a certificate in it is checked for its
profile and statement but not chained to anything, so it proves no authenticator model. An app that must
know which authenticators its users hold — security keys of certified models, nothing reported
compromised — turns on the FIDO Metadata Service (MDS3) checks:

```ts
denextAuth({
  // …
  passkeys: {
    attestation: {
      mds: {
        allowUnattested: true, // let synced passkeys (which attest `none`) register too
      },
    },
  },
});
```

With `mds` set, registration options ask for `attestation: "direct"`, and each new passkey is
held to the metadata after the WebAuthn checks:

- **A certificate attestation** (`packed` with `x5c`, `tpm`, `android-key`, `apple`,
  `fido-u2f`) must come from an AAGUID the metadata lists, and its `x5c` chain must validate to that entry's `attestationRootCertificates`
  (signatures, validity, `cA`, `pathLenConstraint`, `keyUsage`, no unknown critical extension).
  An AAGUID with no entry is refused unless `allowUnknownAuthenticators: true` (its chain is
  then not checked).
- **`none` and self attestation** prove no model, so they are refused unless
  `allowUnattested: true`. Most phone and password-manager passkeys attest `none`; leave it off
  only when every user registers a certified security key. A format denext doesn't verify
  (`android-safetynet`, `compound`) counts as unattested: it registers under `allowUnattested`,
  and is refused otherwise. Apple's anonymous attestation and U2F keys carry an all-zero AAGUID,
  which no metadata entry has: they register only with `allowUnknownAuthenticators`.
- **A compromised model is refused** whatever the attestation: an entry whose latest status
  report is `USER_VERIFICATION_BYPASS`, `ATTESTATION_KEY_COMPROMISE`,
  `USER_KEY_REMOTE_COMPROMISE`, `USER_KEY_PHYSICAL_COMPROMISE` or `REVOKED`, or that was ever
  `REVOKED` or `ATTESTATION_KEY_COMPROMISE`. (An unattested AAGUID is the authenticator's own
  claim, so this can only refuse it.)

**The metadata BLOB** is fetched on the first registration that needs it — server-side, from
`https://mds.fidoalliance.org/` (or `url`), with a timeout (`timeoutMs`, default 15 s) and a size
cap (`maxBytes`, default 32 MiB); nothing is fetched while `mds` is unset. It is a signed JWT: its
`x5c` chain must validate to the FIDO root **pinned in denext** (GlobalSign Root CA - R3), never to
a certificate the response carries, its signing certificate must be issued for
`mds.fidoalliance.org`, and its signature must verify — so a mirror (`url`) or an offline copy
(`blob: string | () => string | Promise<string>`, for a server without outbound network) needs no
trust of its own. The verified BLOB is kept in memory until its `nextUpdate`; a BLOB with a lower
serial number than the one held, or already a day past its own `nextUpdate`, is refused, so a
replayed old BLOB can't bring back a revoked model. When a refresh fails, the held BLOB serves for
one more day, then registrations are refused (`400 { code: "attestation" }`; `registerPasskey()`
answers `invalid`) until a refresh succeeds — retried at most every five minutes. Sign-ins never
consult the metadata.

| Key                          | Default                                   | What it sets                                           |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `url`                        | `https://mds.fidoalliance.org/`           | Where the BLOB is fetched (`https:` only)              |
| `blob`                       | —                                         | The BLOB itself, or a loader; `url` is then unused     |
| `timeoutMs`                  | `15000`                                   | The fetch timeout                                      |
| `maxBytes`                   | 32 MiB                                    | The largest BLOB accepted                              |
| `allowUnattested`            | `false`                                   | Accept `none` / self attestation                       |
| `allowUnknownAuthenticators` | `false`                                   | Accept a certificate attestation the BLOB doesn't list |
| `revocation`                 | `"require"` (`"best-effort"` with `blob`) | What a CRL that can't be had means (below)             |

**Revocation.** Every certificate of the BLOB's signing path, and of an attestation's `x5c`
path to its metadata roots, that names CRL distribution points is checked against its issuer's
certificate revocation list (RFC 5280 §5); a certificate the CRL lists is refused (for the BLOB,
the refresh fails and the held BLOB serves out its grace day). The fetch is bounded: `http:` /
`https:` distribution points only (a CRL is signed, so plain HTTP can't forge one), at most four
per certificate, one fetch per URL at a time, a timeout of `timeoutMs` capped at 10 s, and a
4 MiB body cap. A CRL is used only when its signature verifies with the issuer's key, it names
the certificate's issuer, it is current (`thisUpdate` ≤ now ≤ `nextUpdate`; one without
`nextUpdate` is refused) and it has no critical extension the reader doesn't know (a delta,
indirect or reason-partitioned CRL is not used). A usable CRL is cached per URL until its
`nextUpdate` (64 at most); a failed fetch is not retried for five minutes. `revocation` decides
what happens when no usable CRL can be had for a certificate that names one:

- `"require"` — the path is refused (fail closed). The default when the BLOB is fetched.
- `"best-effort"` — the check is skipped and a warning logged once per URL; a usable CRL that
  lists the certificate still refuses it. The default when `blob` supplies the BLOB, since a
  server without outbound network can't reach a CRL either.
- `"off"` — no CRL is fetched.

A certificate without a distribution point has nothing to check; OCSP is not used. The pinned
root expires on 2029-03-18, and a denext release before then pins its successor.

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

| Event                   | Payload                                           | Fires when                                                            |
| ----------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `signIn`                | `{ user, provider, isNewUser? }`                  | A session was issued                                                  |
| `signOut`               | `{ session }` (`null` if there was none)          | `/signout` cleared the session                                        |
| `signInFailed`          | `{ provider?, reason, providerError?, ip? }`      | An attempt was refused                                                |
| `sessionRevoked`        | `{ sessionId?, userId? }`                         | `revokeSession` / `revokeAllSessions` ran                             |
| `createUser`            | `{ user }`                                        | An adapter user record was created                                    |
| `linkAccount`           | `{ user, account }`                               | A provider account was linked to an existing user                     |
| `verificationRequested` | `{ identifier, purpose, expiresAt }`              | A verification, reset, magic-link or code mail went to the mailer     |
| `emailVerified`         | `{ user }`                                        | An address was proven — a verification link, or a first email sign-in |
| `phoneVerified`         | `{ user }`                                        | A number was proven by a first phone sign-in into an existing account |
| `userConverted`         | `{ user, provider }`                              | An anonymous user proved an email or phone and became permanent       |
| `passwordReset`         | `{ user }`                                        | A reset token set a new password (the sessions are already revoked)   |
| `apiTokenIssued`        | `{ userId, tokenId, name?, scopes?, expiresAt? }` | A bearer API token was minted (`issueApiToken`, `POST /tokens`)       |
| `apiTokenRevoked`       | `{ tokenId, userId?, reason }`                    | A bearer API token was revoked — `reason` says how (below)            |

Every payload also carries `ip`: the client address of the request that caused the event, read
the way `clientIp()` reads it — the socket peer, or with `trustForwardedHeaders`
(on `denextAuth`, else the app's) the proxy's last `x-forwarded-for` hop, never a hop the client
wrote. An event raised outside a request (a job calling `revokeAllSessions`) has no `ip`.

`signInFailed.reason` is the closed `SignInFailedReason` union, so a `switch` over it can be
exhaustive: `"invalid_credentials"` (a wrong password, or a wrong, spent or expired email link or
code), `"invalid_mfa_code"` (a wrong TOTP or backup code, or passkey, at the step-up),
`"invalid_passkey"`, `"rate_limited"`, `"access_denied"`, `"account_not_linked"`, `"adapter_error"`
(the persistence step threw — see below), the OAuth failures `"invalid_state"`, `"invalid_request"`,
`"config"` and `"oauth_failed"`, the native `id_token` failures `"invalid_nonce"` and
`"invalid_token"`, `"captcha_failed"` (see [Captcha](#captcha)), and `"provider_error"` — the
provider itself answered `?error=`, its protocol-shaped code (`access_denied`, `login_required`, …)
in `providerError` and on the sign-in page's `?error=`.

`apiTokenIssued` and `apiTokenRevoked` never carry the token or its hash. `apiTokenRevoked`'s
`reason` is `"revoked"` (`revokeApiToken`, `DELETE /tokens/:id`), `"password_reset"` (a reset
revokes every token), `"email_verified"` (the first proof of an unverified account's mailbox retires
tokens set up without it — see pre-account hijacking), `"phone_verified"` (the same for a first
phone proof) or `"owner_refused"` (a use met a token no later use could accept: its owner is gone or
an SSO user, or banned until after it expires). `userId` is absent only for a bare
`revokeApiToken(config, id)`; pass `{ userId }` as its third argument to carry it.

A read that refuses a credential for good also removes it, and still answers the same refusal. A
server-side session whose user is gone, which the user ended, or which is an SSO user's session
its identity provider didn't start is deleted from the session store. Such a bearer token is
revoked. A ban that outlasts a credential (it expires before the ban ends) ends it the same way,
native and `/auth/v1` refresh families included. A shorter ban only refuses. The Postgres and
SQLite adapters delete API tokens 30 days after they were revoked or expired.

`verificationRequested` never carries the token or the link, and fires only for a delivery
that succeeded. A sign-in that stops at a second factor fires `signIn` only when the
step-up completes.

On `signInFailed` from a rate-limited route, `ip` is instead the client bucket the limiter
counted the attempt against — the rate-limited routes (the credentials POST, the sign-in start, the email link and code redeem, and the
second-factor steps), IPv4 as seen and an IPv6 client as
its **/64 prefix**, which is what the limiter itself counts — so "one address, many
failures" is visible to an alerting pipeline. `signIn` carries `isNewUser: true` when
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
`canonicalOrigin` with no `trustForwardedHeaders` decision (on `denextAuth` or the app),
requests arriving from a local
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

`basePath` gets a leading slash added and a trailing one stripped, and must be one or more non-empty
URL-safe segments. `"/"` is refused — the handler would then claim every request on the site — and
so is any `.` or `..` segment: a dot is URL-safe, but `"/auth/.."` is not a place, and the handler
would claim (and the routes advertise) a prefix that resolves somewhere else entirely. Client-side,
pass the same prefix to `SessionProvider` / `signIn` / `signOut` via their `basePath` prop or
option.

Two cookies exist: the session cookie (default `__Host-denext_auth`) and the short-lived
OAuth transaction cookie that carries the PKCE verifier, `state` and `nonce` (default
`__Host-denext_auth_tx`). The name you configure is the one _before_ the prefix; a name
must be a valid cookie token: letters, digits, or any of the RFC 6265 punctuation
`!#$%&'*+-.^_` plus a backtick, a pipe and a tilde.

`hostPrefix` is **on by default** and leaving it on is strongly recommended: `__Host-`
forces `Secure` + `Path=/` + no `Domain`, which is what stops a sibling subdomain reading
or shadowing the cookie. `sameSite` defaults to `"Lax"` (the OAuth callback is a
top-level GET) and `path` to `"/"`, which `__Host-` forces anyway. `Secure` is pinned
even behind a proxy that omits `x-forwarded-proto`, and on any `SameSite=None` cookie. A
`responseMode: "form_post"` provider's transaction cookie is always `SameSite=None`, whatever
`cookies.transaction.sameSite` says — its callback is a cross-site POST.

The prefix follows the transport. A browser refuses a `__Host-` cookie over plain http, even on
`localhost`, so a request over http (no `https:` `canonicalOrigin`, and neither the URL nor
`x-forwarded-proto` says https) gets plain names (`denext_auth`, `denext_auth_tx`) on a loopback
host (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) and, outside production, on any host —
which is what lets `denext dev` on `http://localhost` hold a session. Production over http on
another host keeps `__Host-`, which the browser refuses: a session never travels in clear text
there. Over https, and whenever `canonicalOrigin` is `https:`, the names are always `__Host-`.

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

Brute-force protection is **on by default**, as six fixed-window limiters built from one
`rateLimit` config:

| Limiter           | Counts                                                                                                                                                                      | Key                                                                        | Default        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------- |
| Credentials       | _Failed_ `POST {basePath}/callback/:provider`                                                                                                                               | Client IP + submitted identifier, lower-cased                              | 5 per 15 min   |
| Sign-in start     | _Every_ `GET {basePath}/signin/:provider`                                                                                                                                   | Client IP                                                                  | 100 per 15 min |
| Session read      | _Every_ `GET {basePath}/session`                                                                                                                                            | Client IP                                                                  | 300 per minute |
| Email / SMS sends | _Every_ mail or text request — `/reset`, an email- or phone-provider send, `/mfa/challenge`, `requestEmailVerification` / `requestPasswordReset`, and every `/auth/v1` send | Submitted address or number (a challenge: the user), plus client IP at 10× | 3 per 15 min   |
| Second factor     | _Every_ code check on `/mfa`, `/mfa/confirm`, `/mfa/disable`; _failed_ email-code and magic-link redeems                                                                    | User id (email codes: the address), plus client IP at 10×                  | 5 per 5 min    |
| Captcha           | _Every_ captcha token about to be sent to the provider (denext's endpoints and `/auth/v1`)                                                                                  | Client IP                                                                  | 30 per minute  |

**No request stream can drive unlimited calls to a third party.** Every outbound provider
call an unauthenticated request (or an ordinary signed-in user) can cause is behind a cheap
budget spent in the limiter store **before** the call, with no I/O to the provider: the
captcha verifier behind the per-IP captcha budget, and every email or SMS send — on denext's
own endpoints (`/reset`, the email and phone providers' sends, `/mfa/challenge`) and on
`/auth/v1` (`/signup`, `/otp`, `/magiclink`, `/resend`, `/recover`, `/reauthenticate`, an
email or phone change on `PUT /user`, a phone factor's challenge) — behind BOTH the
per-identifier send budget (the address, number or user) and its client-IP bucket. A missing
or oversized captcha token is refused without spending (it is never sent). Only the
service-role admin calls (`/invite`, `/admin/generate_link`) send without a budget.

Past the limit the endpoint answers a generic `429` with `Retry-After` — like the generic
`401`, it never reveals whether the account exists — and a successful credentials sign-in
resets its key. The credentials limiter also keeps a looser IP-wide bucket (ten times the
configured `max`), so one IP cannot walk a list of identifiers. The sign-in-start limiter
counts every hit rather than only failures, because the cost being bounded is the work
done for an unauthenticated caller: minting a PKCE verifier, a `state`, a nonce and a
signed transaction cookie, plus provider-id probing.

The session-read limiter exists for the same reason: `GET {basePath}/session` is
unauthenticated work — a cookie verification plus a store read, and possibly a re-issue —
and 300 per minute leaves room for many users behind one address (an office NAT). A `429`
never signs anyone out: `SessionProvider` keeps the session it knew and waits out `Retry-After`
before its next focus or interval refetch.

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
trusted by default, since without a proxy anyone can set it. Left unset on `denextAuth`,
the flag is **inherited from the app** (`trustForwardedHeaders` in `denext.config.ts` or
`DENEXT_TRUST_PROXY=1`), so the limiters and `clientIp()` agree on who the client is; set
it on `denextAuth` only to override the app for auth. An IPv6 client is normalised
and bucketed by **/64**, so a client cannot walk its own prefix for a fresh budget.

Two behaviours worth knowing:

- **An undeclared proxy disables the per-IP budgets rather than sharing one.** When a
  request arrives from a loopback, private, link-local or unique-local peer and no trusted
  `x-forwarded-for` hop names the client (the limit-address rule `rateLimit()` and
  `clientIpForLimits()` follow; with or without the header, and in local development too),
  every visitor looks like the proxy — so the sign-in-start,
  session-read and captcha budgets are skipped for it and every IP-wide bucket is dropped, with one
  console warning naming the fix, instead of turning the 21st sign-in site-wide into a
  fifteen-minute outage. The per-subject keys keep working: the credentials limiter's (it
  carries the submitted identifier), the send budget's address and the second-factor
  budget's user.
  Setting `canonicalOrigin` while neither `denextAuth` nor the app decided
  `trustForwardedHeaders` warns once, on the first auth request, for the same reason.
  Two app settings change that rule for every per-address limit, auth's included:
  `rateLimitHeader` (a header such as `cf-connecting-ip` that your proxy sets to the client
  address — the model is Supabase Auth's `GOTRUE_RATE_LIMIT_HEADER`) keys the budgets on that
  address whenever a request from a trusted proxy (`rateLimitTrustedProxies`, or a
  loopback/private peer under `trustForwardedHeaders`) carries one — from any other peer the
  header is ignored, so a client that reaches the origin directly can't pick a fresh bucket per
  request — and `rateLimitLocalAddresses: true` counts a
  loopback/private peer by its own address instead of skipping it. See
  [Deploy › Per-address limits](/docs/deploy#per-address-limits-behind-a-proxy).
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
    captcha: { max: 30, windowMs: 60_000 }, // captcha verifier calls per client IP (or false)
    store: myRedisRateLimitStore, // RateLimitStore — share counts across replicas
  },
  // or: rateLimit: false (disables ALL SIX — you rate-limit at the edge)
});
```

`max` / `windowMs` / `keyGenerator` belong to the credentials limiter and never apply to the other
five, which are tuned under `signin`, `session`, `verification`, `mfa` and `captcha` (`captcha:
false` turns just that one off). `store` is shared by all six (their keys are namespaced apart). The
default store is a bounded per-process map — fine for a single instance, but each replica counts on
its own, so pass a shared `store` behind several — `postgresRateLimitStore({ sql })` is one (see
[Postgres](#postgres)). With [`@denext/backend`](/docs/backend#postgres)'s Postgres (`backend({
postgres })`) and no `store` set, the limiters count in `auth_rate_limits` on that database (the
adapter's own table with `backendAuthAdapter()`), so every replica already shares one budget.

## API tokens and `requireBearer`

`issueApiToken(config, { userId, name?, scopes?, expiresInSeconds?, session? })` mints `tok_` plus
256 bits of CSPRNG entropy and returns the **plaintext exactly once**; what is stored is the SHA-256
(hex) of the full presented string, so a database read yields nothing usable and verification is an
indexed exact-match lookup rather than an in-process comparison — there is no timing oracle to
equalise. `session` is the session minting the token (what `auth()` returned): the token records
whether the user's identity provider started it, and an SSO user's token authenticates only when it
did — one minted without a session, or from any other, is refused. Every verification re-reads the
owner: a banned owner's tokens authenticate nothing while the ban lasts, and a deleted owner's
nothing at all. `requireBearer(authConfig, { scope, role })` — or `requireBearer({ scope, role })`,
which reads the config `denextAuth()` was built with (`activeAuthConfig()`) — is the `createApi()`
middleware that authenticates `Authorization: Bearer tok_…` and extends the handler's context with
`{ token, user, session }`, where `session` has the same shape `requireSession()` provides — so a
handler written against `ctx.session.user.id` works under either credential. Every authentication
failure (absent header, wrong scheme, unknown, revoked, expired, or a token whose user was deleted)
is the **identical** `401` with `WWW-Authenticate: Bearer`, so the response can't be used to probe
which tokens exist; a valid token that lacks the required scope or role gets a `403` instead,
keeping "who are you" distinguishable from "may you". Scope and role are any-of, and a **scopeless
token satisfies no scope requirement** — scoping an endpoint never silently admits older, scopeless
tokens. The middleware is pre-tagged with `documentsSecurity(…, [{ bearerAuth: [] }])`, so
`@denext/openapi` marks every endpoint that applies it as secured with nothing written on the
definition. What it cannot do is describe the scheme: declare the matching `securitySchemes: {
bearerAuth: { type: "http", scheme: "bearer" } }` **once** in the `openapi()` plugin options, or the
document references a scheme it never defines (and Swagger UI shows no Authorize button). Bearer
auth **never sets a cookie** and never slides a session forward: a token carries its own credential
on every call and can't be escalated into a browser session.

```ts
// lib/auth.ts
import { createApi, requireBearer } from "denext/server";
import { authConfig } from "./auth-config.ts";

export const authed = createApi().use(requireBearer(authConfig, { scope: "pets:write" }));

// app/api/pets/route.ts
export const POST = authed.define({ body: NewPet }, ({ body, ctx }) => add(ctx.user.id, body));
```

The management endpoints are `POST {basePath}/tokens` (mint — returns the plaintext once, `201`, and
a `409` once you already hold 50 live tokens, so a compromised session cannot mint credentials
without bound), `GET {basePath}/tokens` (list, redacted: no hashes, and the plaintext no longer
exists anywhere) and `DELETE {basePath}/tokens/:id` (revoke). All three are **cookie session only**
— they never read the `Authorization` header, so a leaked token can't mint another one, widen its
own scopes or revoke a sibling — and they require a **complete** session, so a first factor alone
can't produce a credential that outlives the second-factor requirement. The mutations are
same-origin-gated like every other auth POST. Revoking a token you don't own answers the same `404`
an unknown id gets.

All of this needs an adapter implementing the API-token group. Without one the functions
throw with an actionable message at the call that needs them, and `{basePath}/tokens`
simply doesn't exist (a plain 404) — `requireBearer` throws at **module load**, not on
the first request, so an API whose auth could never succeed fails where it is written.
`listApiTokens(config, userId)` and `revokeApiToken(config, id)` are the programmatic
half; records carry `tokenHash`, so redact before sending a list anywhere.

## Native apps and account deletion

An app whose WebView can't carry the `__Host-` cookie — a Capacitor shell at
`capacitor://localhost` calling `https://api.example.com` — uses **native session mode**:

```ts
denextAuth({
  // …
  adapter: sqliteAuthAdapter({ path: "auth.db" }), // needs the native session group
  native: {
    redirectUris: ["com.example.app://auth/callback"], // exact match
    refreshTokenMaxAge: 90 * 86_400, // optional: sign in again after 90 days, however active
    apple: { clientIds: ["com.example.app"], clientSecret: () => appleClientSecretJwt() },
    google: { clientIds: [IOS_CLIENT_ID, WEB_CLIENT_ID] },
  },
  onAccountDeleted: async ({ user }) => await db.deleteEverythingOf(user.id),
});
```

The app signs in through a system browser sheet (`openAuthSession`) and receives a one-time
code at its redirect URI, or sends a native Apple / Google sheet's `id_token`; either way it
gets a short-lived bearer access token (`nat_…`) and a rotating refresh token (`nrt_…`).
`auth()`, `requireAuth()` and `requireSession()` accept that bearer as a session (it never
slides and sets no cookie); the `/tokens` and `/mfa*` endpoints still read the cookie only.
`revokeAllSessions(userId)`, a password reset and a pre-account-hijacking eviction end the
native sessions too. `POST {basePath}/account/delete` deletes the signed-in user after a
recent sign-in, revoking their Sign in with Apple tokens. Deletion ends every credential the
user held, whether or not the adapter's `deleteUser` removed it: each verification re-reads the
user, so a deleted user's cookie session, native access token, bearer API token and `/auth/v1`
access token (one with no `session_id` included) authenticate nothing from the next request.

A user with a second factor who signs in with a native `id_token` gets a pending sign-in, not
tokens: `{ mfa_required: true, mfa_token, expires_in, factors }`, finished at `POST
{basePath}/native/mfa` with a TOTP, backup or SMS code (`nativeSession()`'s `completeMfa`; `POST
{basePath}/native/mfa-challenge` texts a phone factor first). The `mfa_token` is single-use, lives
five minutes, and is not a credential for anything else. Under `mfa.required: "always"` a user with
no factor yet gets the same pending result with `mfa_enroll: true`, and finishes it by enrolling a
first factor: `POST {basePath}/native/mfa-enroll` (`{ factor_id, secret, uri, mfa_token }`), then
`POST {basePath}/native/mfa-confirm` with a code (the tokens plus `backup_codes`) —
`nativeSession()`'s `enrollMfa` and `confirmMfaEnrollment`, under the web enrollment's rules
(first factor only, the MFA budget, single-use tokens).

The whole flow — CORS for the app's origin, the client helper `nativeSession()`,
`createApiClient({ base, auth })`, the id_token checks, the second factor and deletion — is on
[App backend](/docs/app-backend).

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
const result = await signIn("credentials", { credentials: { email, password } });
if (result.ok) location.href = "/dashboard";
else if (result.error === "throttled") show(`try again in ${result.retryAfter}s`);
else show("wrong email or password"); // "invalid_credentials" — never says which
await signIn("email", { credentials: { email } }); // mails a magic link
await signOut({ callbackUrl: "/" });
```

A `credentials` sign-in resolves `{ ok, … }` and never rejects for a refusal — only a
network failure or a non-JSON answer (no auth mounted at `basePath`) throws. On `ok: false`
the `error` is a stable code derived from the callback's status, because the server's own
`error` text is generic by design: `"invalid_credentials"` (`401`: a wrong password, an
unknown user or a wrong one-time code), `"throttled"` (`429`, with `retryAfter` in
seconds), `"access_denied"` (`403`: your `signIn` callback refused), `"unavailable"`
(`5xx`) or `"rejected"` (anything else — read `status`).

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

## `next-auth` (Auth.js v5) apps

A Next.js app written for Auth.js v5 runs on denext with its source unchanged. `denext migrate`
aliases `next-auth`, `next-auth/react`, `next-auth/webauthn`, `next-auth/jwt` and
`next-auth/providers/*` to denext's
compat modules, which map Auth.js onto `denextAuth` (a NextAuth.js v4 app too: see
[NextAuth.js v4 apps](#nextauthjs-v4-apps)):

```ts
// auth.ts — as written for Next.js
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub, Credentials({ authorize: async (c) => await checkPassword(c) })],
  callbacks: {
    jwt: ({ token, user }) => (user ? { ...token, role: user.role } : token),
    session: ({ session, token }) => ({ ...session, role: token.role }),
  },
});

// app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/auth";
export const { GET, POST } = handlers;

// middleware.ts
export { auth as middleware } from "@/auth";
```

`auth()` reads the session in a Server Component, a route handler or a Server Action;
`auth(handler)` wraps a route handler or middleware (`request.auth`); `export { auth as middleware }`
runs `callbacks.authorized`. `next-auth/react` gives the client `SessionProvider`, `useSession`,
`signIn`, `signOut`, `getSession`, `getCsrfToken` and `getProviders`, `next-auth/webauthn` gives
the passkey `signIn`, and `next-auth/jwt` gives `getToken`, `encode` and `decode`.

`NextAuth` also takes a lazy config, `NextAuth(async (req) => config)`: it runs on every request,
with the `NextRequest` in the route handlers and middleware and `undefined` in `auth()`,
`signIn()` and `signOut()`, as in Auth.js. Concurrent requests each read their own config.

On a next-compat build the aliases need no import map: `next-auth/react` and `next-auth/webauthn`
(in the app or in a library under `node_modules`) bundle from denext's runtime, and `next-auth`,
`next-auth/jwt` and the providers resolve to the shim, so an installed `next-auth` package is
never loaded.

| Auth.js                                                                                                                | On denext                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHub`, `Google`, `Apple`, `Discord`, `MicrosoftEntraID`, `GitLab`, `Facebook`, `Slack`, `Okta`, `Auth0`, `Keycloak` | denext's presets; `clientId` / `clientSecret` (and an `issuer`) default to `AUTH_<ID>_ID` / `_SECRET` / `_ISSUER`; `authorization.params`, `profile()` and `allowDangerousEmailAccountLinking` apply          |
| `Twitter`, `LinkedIn`, `Twitch`, `Spotify`, `Cognito`, `Zoom`, `Notion`                                                | the same, from endpoint data the shim carries (X, Zoom and Notion send the client credentials as HTTP Basic)                                                                                                  |
| `AzureAD` (`next-auth/providers/azure-ad`)                                                                             | Microsoft Entra ID under the id `azure-ad`: `AUTH_AZURE_AD_ID` / `_SECRET`, the tenant from `AUTH_AZURE_AD_ISSUER`                                                                                            |
| The other OAuth / OIDC providers (`Kakao`, `Reddit`, `Zitadel`, `WorkOS`, … 71 of them)                                | generated from Auth.js's own definitions (see below); `AUTH_<ID>_*` defaults, options such as `issuer`, `apiBaseUrl` or `tenantId`, and the profile mapping as Auth.js has them                               |
| `Passkey`, `WebAuthn`                                                                                                  | denext's [passkeys](#passkeys-webauthn): `relayingParty` → `rpId` / `rpName` / `origins`; `next-auth/webauthn`'s `signIn("passkey")` signs in, `{ action: "register" }` adds one                              |
| A custom provider object (`{ id, type: "oauth" \| "oidc", authorization, … }`)                                         | An `OAuthProvider` object (or `oidc()`)                                                                                                                                                                       |
| `Credentials`                                                                                                          | `credentials()`, plus its rate limits                                                                                                                                                                         |
| `Resend`, `SendGrid`, `Postmark`, `Mailgun`, `ForwardEmail`, `Loops`, `Nodemailer`, `Email`                            | `magicLink()`; the service's HTTP API (`AUTH_<ID>_KEY`) or `smtpMailer()` sends the link                                                                                                                      |
| `session.strategy: "jwt"`                                                                                              | denext's signed cookie, the `jwt` callback's token sealed inside it (AES-256-GCM, a key derived from `AUTH_SECRET`)                                                                                           |
| `session.strategy: "database"`                                                                                         | `session.strategy: "database"` on the adapter's `Session` rows                                                                                                                                                |
| `adapter` (`@auth/prisma-adapter`, `@auth/drizzle-adapter`, …)                                                         | bridged onto denext's adapter port: users, accounts, sessions, verification tokens; roles, bans and `sessionsValidAfter` through its optional `getUserExtension` / `updateUserExtension` (an extension table) |
| `callbacks.signIn` / `jwt` / `session` / `redirect` / `authorized`                                                     | run with Auth.js's arguments (`account` carries the provider tokens, `profile` the raw profile)                                                                                                               |
| `events.signIn` / `signOut` / `createUser` / `linkAccount` / `updateUser` / `session`                                  | fired from denext's events (the first four with `ip`); `session` on every read, `updateUser` when the adapter updates a user                                                                                  |
| `pages`                                                                                                                | `pages`: the built-in GET pages under `/api/auth` redirect to `signIn` / `signOut` / `error` / `verifyRequest` (same-origin only), and `newUser` receives a first sign-in; without them, plain built-in pages |
| `AUTH_SECRET`, `AUTH_URL`                                                                                              | `secret`, `canonicalOrigin` (+ `basePath` from its path)                                                                                                                                                      |

### Every Auth.js provider, generated

The OAuth / OIDC providers denext has no preset for are generated from `@auth/core`'s own
`providers/` at a pinned version (`deno task gen:auth-providers`): each module carries Auth.js's
endpoints, scopes, token-endpoint authentication (HTTP Basic unless the provider names
`client_secret_post`), its `checks` and its `profile()` mapping as data, checked against Auth.js's own
`profile()` on sample profiles when it is generated. A drift test holds the checked-in modules to
the pinned provider list. An OIDC provider discovers its endpoints from the issuer; one Auth.js
reads userinfo for (`idToken: false`) does too. An OAuth provider's address is never treated as
verified; an OIDC one only when its `email_verified` claim says so.

The providers whose Auth.js definition reads the user in code are generated too, with that request
as data the generator checks against Auth.js's own: Dropbox and Todoist (a `POST`), Trakt (API-key
headers), Foursquare and HubSpot (the token in the URL), Nextcloud and Bungie (an id from the token
response in the URL; Bungie's API key goes in Auth.js's documented `headers: { "X-API-Key": … }`
option) and VK (the address from the token response). TikTok adds its `client_key` to the token
request, LINE's `id_token` is verified HS256 under the channel secret as its specification has it,
and NetSuite reads the RESTlet the app deploys, given as `userinfo` (an https URL):

```ts
NetSuite({
  accountID: "1234567",
  userinfo:
    "https://1234567.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1",
});
```

Three are not provided: Azure DevOps (a deprecated JWT assertion flow), BankID Norge (userinfo as a
signed JWT) and WeChat (its `platformType` option switches the authorization URL and scope). Write
one as a custom provider object if its API allows; [Limitations](/docs/limitations) lists the
reasons.

A generated provider is imported and configured like any Auth.js one. Its credentials default to
`AUTH_<ID>_ID` / `AUTH_<ID>_SECRET`, the id upper-cased with `-` turned into `_`
(`next-auth/providers/42-school` reads `AUTH_42_SCHOOL_ID`), and a provider with an issuer reads
`AUTH_<ID>_ISSUER`. The options its definition reads (`issuer`, `apiBaseUrl`, `tenantId`,
`connection`, `scope`, …) are passed the same way; an issuer or another URL the app supplies must
be `https:`, or the provider is a config error:

```ts
// auth.ts
import Kakao from "next-auth/providers/kakao"; // AUTH_KAKAO_ID / AUTH_KAKAO_SECRET
import Reddit from "next-auth/providers/reddit";
export const { handlers, auth } = NextAuth({
  providers: [Kakao, Reddit({ checks: ["state"] })],
});
```

`checks` overrides the provider's own list as in Auth.js. Each value must be `"pkce"`, `"state"`,
`"nonce"` or `"none"`; anything else (`Reddit({ checks: ["pcke"] })`) throws a `TypeError` when
the provider is built, naming the provider and the accepted values, so a typo can't turn PKCE off. `state` is sent and checked whatever the list says.

### Passkeys from `next-auth/providers/passkey`

`next-auth/providers/passkey` (and `…/webauthn`) turns on denext's [passkeys](#passkeys-webauthn) under the
auth base path, and the app's client calls stay Auth.js's:

```tsx
// auth.ts
import Passkey from "next-auth/providers/passkey";
export const { handlers, auth } = NextAuth({
  adapter, // its Authenticator rows hold the credentials
  providers: [Credentials({ authorize }), Passkey],
  experimental: { enableWebAuthn: true },
});

// a client component
import { signIn } from "next-auth/webauthn";
<button onClick={() => signIn("passkey")}>Sign in with a passkey</button>;
<button onClick={() => signIn("passkey", { action: "register" })}>Add a passkey</button>;
```

The relying party is `AUTH_URL`'s origin, never the request's host. `relayingParty: { id?, name?,
origin? }` sets it: `id` is the RP ID, `name` what the authenticator shows, and `origin` (a string
or a list, every entry accepted) the origins a ceremony may come from — with only an `id` it is
`https://<id>`, never taken from the request. `authenticationOptions` / `registrationOptions`
carry the ceremony `timeout` (milliseconds) and `userVerification` (registration's also under
`authenticatorSelection`); `Passkey` requires user verification unless they ask for less, and
`WebAuthn` prefers it:

```ts
Passkey({
  relayingParty: { id: "example.com", name: "Example", origin: ["https://example.com"] },
  authenticationOptions: { timeout: 120_000, userVerification: "preferred" },
});
```

A passkey is registered for a signed-in user whose address is verified, after a recent
sign-in; Auth.js's sign-up by passkey (an unverified email creating an account) is not offered.
With an Auth.js adapter, a credential is its `Authenticator` row and a `webauthn` account, as
Auth.js stores them. The ceremony's challenge (Auth.js keeps it in a cookie) goes to the app's
[cache store](/docs/multi-instance): single-use, taken atomically, and expiring with the ceremony.
Instances that share a store (`postgresCacheStore`, `redisCacheStore`, `denoKvCacheStore`, or one
host's SQLite file) finish each other's ceremonies; with the in-memory store a ceremony must
finish on the instance that began it, as with sticky sessions. A custom `CacheStore` without the
optional `takeData` (the atomic take) behaves like the in-memory store here: the challenge stays
on the instance that began the ceremony.

An Auth.js adapter's schema has no column for denext's roles, bans or `sessionsValidAfter`. Give
it two more methods over a table of your own, keyed by user id, and `requireAuth({ role })`, a
ban and `revokeAllSessions()` work through it, its database sessions included (times are epoch
seconds; `null` clears a field):

```ts
import type { AdapterUserExtension } from "next-auth";
const adapter = {
  ...PrismaAdapter(prisma),
  getUserExtension: (userId: string) => prisma.userExtension.findUnique({ where: { userId } }),
  updateUserExtension: (userId: string, patch: AdapterUserExtension) =>
    prisma.userExtension.upsert({ where: { userId }, create: { userId, ...patch }, update: patch }),
};
```

denext keeps its own defaults where they are stricter, and nothing is relaxed for parity:

- **CSRF.** Every state-changing POST (`signin`, `signout`, the credentials callback, `session`
  updates) needs Auth.js's double-submit `csrfToken` **and** passes denext's same-origin check.
  The CSRF cookie is a signed `__Host-` cookie.
- **OAuth.** A provider's `checks` decide PKCE and the OIDC `nonce` as in Auth.js (a provider
  that names none gets PKCE, plus a `nonce` for OIDC; `Reddit` and the others whose definition
  says `checks: ["state"]` get no `code_verifier` they would refuse), but every flow sends and
  verifies `state`, even where `checks` leave it out or say `"none"`. The `redirect_uri` comes from `AUTH_URL`, never the `Host` header, so production
  needs `AUTH_URL`.
- **Redirects.** A `callbackUrl` / `redirectTo` goes through the `redirect` callback, then is kept
  to a same-origin path. A callback that returns another origin lands on `/`.
- **Cookies.** The session is `__Host-denext_auth` (`Secure`, `httpOnly`, `SameSite=Lax`), with
  no `cookies` override. Over plain http on a loopback host, or outside production, the names
  drop the `__Host-` prefix, which a browser refuses there (as `denextAuth`'s do; see
  [Base path and cookies](#base-path-and-cookies)), much as Auth.js drops `__Secure-`. A session also ends 30 days after sign-in at the latest
  (`session.maxLifetime`), however often it slides.
- **Email links** open a confirmation page by default; `Resend({ confirm: false })` signs in on
  the GET, as Auth.js does.

The full list is in [Differences](/docs/differences) and [Limitations](/docs/limitations).

## NextAuth.js v4 apps

An app written for NextAuth.js v4 (`next-auth@4`) migrates the same way, with no source changes:
`denext migrate` also aliases v4's `next-auth/next`, `next-auth/middleware` and
`next-auth/adapters`, wires `@denext/pages-router` for a `pages/api/auth/[...nextauth].ts` route,
and reports the v4 APIs and Auth.js adapters it found (`denext migrate --check` lists what to
check). The v4 server API runs on the same shim as v5's:

```ts
// lib/auth.ts — as written for NextAuth.js v4
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
export const authOptions: NextAuthOptions = {
  providers: [CredentialsProvider({ credentials: {}, authorize: (c, req) => check(c, req) })],
};

// pages/api/auth/[...nextauth].ts (Pages Router)
import NextAuth from "next-auth";
export default NextAuth(authOptions);

// app/api/auth/[...nextauth]/route.ts (App Router)
const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };

// middleware.ts
export { default } from "next-auth/middleware";
export const config = { matcher: ["/dashboard/:path*"] };
```

- **`NextAuth(authOptions)`** returns the route handler for both routers (it is also v5's
  `{ handlers, auth, signIn, signOut }`), and `NextAuth(req, res, authOptions)` answers a Pages API
  route directly. A Pages API route's `(req, res)` is translated to a `Request` and back; every
  endpoint is the v5 one, with the same CSRF, redirect and cookie rules.
- **`getServerSession(authOptions)`** (from `next-auth` or `next-auth/next`) reads the session in a
  Server Component, a route handler or a Server Action; **`getServerSession(req, res,
  authOptions)`** in `getServerSideProps` and an API route. The same `authOptions` object always
  reads the same instance as its route. `unstable_getServerSession` is the same function.
- **`next-auth/middleware`**: the default export gates every path `config.matcher` selects;
  `withAuth(middleware, { callbacks: { authorized }, pages })` runs `authorized({ token, req })`
  (default: whether there is a token) and hands an authorized request to your middleware with
  `req.nextauth.token`. An unauthorized request is redirected to `pages.signIn` (default
  `/api/auth/signin`) with its path as `callbackUrl`; the auth endpoints, the sign-in and error
  pages and the framework's assets are never gated. The token is the JWT strategy's, as in v4: it
  opens with `NEXTAUTH_SECRET` even before the `[...nextauth]` route has loaded, and a database
  session has none.
- **`next-auth/react`**: `getSession({ req })` / `getSession(ctx)`, `getCsrfToken({ req })` and
  `getProviders()` work on the server (`getServerSideProps`, an API route) — answered in-process
  for the current request, else over HTTP to `NEXTAUTH_URL` (never the request's `Host`).
  `useSession({ required, onUnauthenticated })`, `signIn(provider, { callbackUrl, redirect })` and
  `signOut({ callbackUrl, redirect })` behave as in v4; `signIn` with a provider the server doesn't
  list opens the sign-in page.
- **`authorize(credentials, req)`** gets a `req` that answers v4's reads (`req.headers["x-forwarded-for"]`,
  `req.query`, `req.body`) as well as v5's `Request` methods.
- **Environment**: `NEXTAUTH_SECRET` and `NEXTAUTH_URL` (or v5's `AUTH_SECRET` / `AUTH_URL`).
  Production needs `NEXTAUTH_URL`.

An Auth.js adapter from the app's own dependencies — `@auth/prisma-adapter`,
`@auth/drizzle-adapter`, or v4's `@next-auth/prisma-adapter` — backs users, linked accounts,
verification tokens and `session: { strategy: "database" }` sessions on its own tables. A Prisma
app runs on the Deno client `denext migrate` wires (`denext task prisma:setup` once); Drizzle runs
on any of its drivers (on SQLite, `node:sqlite` through `drizzle-orm/sqlite-proxy` and denext's
`better-sqlite3` compat).

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

## Supabase clients: `/auth/v1`

With [`backend({ supabase })`](/docs/backend#supabase-keys-and-access-tokens) the users
`denextAuth()` keeps are also served by a GoTrue-compatible API at `/auth/v1`, so the stock
`@supabase/supabase-js` client's `supabase.auth.*` works unchanged against your app — and a cookie
session and a token session are the same user, in the same adapter:

```ts
// denext.config.ts
import { credentials, denextAuth, github } from "denext/server";
import { backend, backendAuthAdapter } from "@denext/backend";

export default {
  plugins: [
    denextAuth({
      secret: Deno.env.get("AUTH_SECRET")!,
      canonicalOrigin: "https://app.example.com",
      providers: [credentials(), github({ clientId: "…", clientSecret: "…" })],
      adapter: backendAuthAdapter(), // or sqliteAuthAdapter() / inMemoryAuthAdapter()
      sendVerificationRequest: sendMail, // confirmation, magic-link, recovery and invite mail
    }),
    backend({
      postgres: {},
      supabase: {
        auth: {
          siteUrl: "https://app.example.com",
          redirectUrls: ["https://app.example.com/**", "myapp://auth/*"],
          anonymousUsers: true,
          sendSms: ({ phone, message }) => sms.send(phone, message), // phone OTP + phone MFA
          mfa: { phone: true },
        },
      },
    }),
  ],
};
```

```ts
// the browser, a Capacitor shell, a script — anything supabase-js runs in
import { createClient } from "@supabase/supabase-js";
const supabase = createClient("https://app.example.com", PUBLISHABLE_KEY);
await supabase.auth.signUp({ email, password, options: { data: { name } } });
await supabase.auth.signInWithPassword({ email, password });
await supabase.auth.signInWithOtp({ phone: "+15555550100" });
await supabase.auth.signInWithOAuth({ provider: "github" }); // a provider from denextAuth()
await supabase.auth.mfa.enroll({ factorType: "totp" });
await supabase.auth.admin.listUsers(); // with the secret key, on a server
```

What it serves: `signup` (email or phone with a password, or anonymous), `token` with
`grant_type=password | refresh_token | pkce | id_token` (Google / Apple id tokens, from
`idTokenProviders` or `native.google` / `native.apple`), `otp` and `magiclink`, `verify` (POST, and
the GET an emailed link opens — implicit fragment or PKCE `?code=`), `resend`, `recover`, `user`
(GET and PUT: metadata, password, email and phone changes), `reauthenticate`, `logout` (`scope=local
| others | global`; `global` also ends the user's denextAuth cookie sessions, stateless ones
included, and `others` all of them while keeping the caller's token session), `authorize` (OAuth
through the providers you configured; their callback stays `{basePath}/callback/:provider`),
`user/identities/authorize` and identity unlinking, `factors` (TOTP, phone and WebAuthn: enroll,
challenge, verify, unenroll; recovery codes; `aal2` after a verified factor), `settings`, `sso`
(SAML 2.0, below), `token?grant_type=web3` (Web3 sign-in, below), the OAuth 2.1 server (`oauth/*`,
`user/oauth/grants`, below), and the admin API — `admin/users` (paginated list, create, read, update
incl. `ban_duration`, delete), `invite`, `admin/generate_link`, `admin/users/:id/factors`,
`admin/oauth/clients` and `admin/custom-providers`. Errors are GoTrue's `{ code, error_code, msg }`,
so `supabase-js` raises `AuthApiError` with the same `code`s.

Users gain Supabase's fields on every adapter: `phone`, `userMetadata` / `appMetadata` (free-form
JSON; only the admin API writes `app_metadata`), `isAnonymous`, timestamps, `bannedUntil`,
`sessionsValidAfter`, and
identity rows with `identityData`. Access tokens carry Supabase's claims (`sub`, `role`, `aud`,
`email`, `phone`, `app_metadata`, `user_metadata`, `aal`, `amr`, `session_id`, `is_anonymous`,
`exp`, `iat`, `iss`), so RLS policies written for Supabase work through `db()` and auto-REST.

`sendSms`, `captcha`, `hooks` and `anonymous` can also be set once on `denextAuth({ … })`; they
then apply to denext's own endpoints and to `/auth/v1`. The `/auth/v1` options below override
`sendSms`, `captcha` and `anonymous` there, and merge `hooks` key by key. A hook beats a plain
sender wherever either is set: a `hooks.sendSms` on `denextAuth()` delivers `/auth/v1`'s texts
even when `supabase: { auth: { sendSms } }` is set.

The `/auth/v1` options (`backend({ supabase: { auth } })`):

| Option                             | Default                          | What it does                                                                                                             |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `siteUrl`                          | `canonicalOrigin`                | Where links land by default                                                                                              |
| `redirectUrls`                     | `[]`                             | Other `redirect_to` targets (`*` one segment, `**` anything)                                                             |
| `jwtExpiry`                        | `3600`                           | Access-token lifetime, seconds                                                                                           |
| `refreshTokenReuseInterval`        | `10`                             | Seconds a used refresh token may be presented again                                                                      |
| `disableSignup`                    | `false`                          | Refuse new sign-ups (invites and the admin API still create users)                                                       |
| `autoconfirm` / `phoneAutoconfirm` | `false`                          | Sign in at sign-up without confirming the email / phone                                                                  |
| `anonymousUsers`                   | `false`                          | Allow `signInAnonymously()` (default: `denextAuth({ anonymous })`)                                                       |
| `minPasswordLength`                | `8`                              | Password policy (`weak_password`)                                                                                        |
| `otpLength` / `otpExpiry`          | `6` / `3600`                     | Email and SMS codes                                                                                                      |
| `sendSms`                          | none                             | Deliver SMS codes (phone sign-up, phone OTP, phone MFA)                                                                  |
| `captcha`                          | off                              | `{ provider: "hcaptcha" \| "turnstile", secret }` — checks `captchaToken`                                                |
| `hooks`                            | none                             | `customAccessToken`, `sendEmail`, `sendSms` (Supabase's auth hooks)                                                      |
| `smtp`                             | `GOTRUE_SMTP_*`                  | Send `/auth/v1`'s mail over SMTP: `smtpMailer()`'s options plus GoTrue's `subjects` and `templates` (below)              |
| `requireReauthentication`          | `false`                          | A password change needs a `reauthenticate()` nonce                                                                       |
| `manualLinking`                    | `true`                           | Allow `linkIdentity()`                                                                                                   |
| `mfa`                              | TOTP                             | `{ phone: true }` adds SMS factors; `maxFactors` (10)                                                                    |
| `idTokenProviders`                 | `native.google` / `native.apple` | `{ google?, apple? }` — the client ids `signInWithIdToken` accepts                                                       |
| `saml`                             | none                             | SAML SSO: `providers`, `signingKey` + `signingCertificate`, `encryptionKey` + `encryptionCertificate`, `metadataRefresh` |
| `oauthServer`                      | off                              | `{ authorizationPath?, codeExpiry? }` — the OAuth 2.1 server, below                                                      |
| `web3`                             | off                              | `{ ethereum?: { chainIds?, domains? }, solana?: { domains? }, maxAge? }`                                                 |

`sendSms`, `captcha`, `hooks` and `anonymous` set on `denextAuth()` apply here too unless these
options set their own (a hook set here wins over the same hook there, and any `hooks.sendSms`
wins over a plain `sendSms`) — see
[Captcha](#captcha) and [Hooks](#hooks).

**Email delivery.** `/auth/v1` mails through `hooks.sendEmail` when set, else the auth config's
`sendVerificationRequest`, else SMTP: the `smtp` option, or — when it is unset — Supabase Auth's own
settings from the environment, `GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`, `GOTRUE_SMTP_USER`,
`GOTRUE_SMTP_PASS`, `GOTRUE_SMTP_ADMIN_EMAIL` (the sender) and `GOTRUE_SMTP_SENDER_NAME`, with
`GOTRUE_MAILER_SUBJECTS_<KIND>` and `GOTRUE_MAILER_TEMPLATES_<KIND>` (`CONFIRMATION`, `INVITE`,
`RECOVERY`, `MAGIC_LINK`, `EMAIL_CHANGE`, `REAUTHENTICATION`); the environment is read only when
both `GOTRUE_SMTP_HOST` and `GOTRUE_SMTP_ADMIN_EMAIL` are set. The transport is
[`smtpMailer()`](#sending-mail-over-smtp), so TLS is required (465 is implicit TLS, any other port
must offer STARTTLS). Subjects default to GoTrue's ("Confirm Your Email", "Your Magic Link", …). A
template is a URL of an HTML file, fetched on first use (http(s), 10 s, a redirect followed only to
`https:` on the same origin, at most 1 MiB) and kept for 10 minutes. It is a Go template, rendered
as GoTrue renders it, over the data GoTrue gives each action: every one has `{{ .SiteURL }}`,
`{{ .Email }}`, `{{ .Token }}` and `{{ .Data }}` (the user's metadata); all but reauthentication
add `{{ .ConfirmationURL }}`, `{{ .TokenHash }}` and `{{ .RedirectTo }}`, and an email change adds
`{{ .NewEmail }}` and `{{ .SendingTo }}`. `if` / `else if` / `else`, `with`, `range` (with
`break` / `continue`), variables, pipes, `{{- … -}}` trim markers, comments and the builtin
functions (`and`, `or`, `not`, `len`, `index`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `print`,
`printf`, `println`, `html`, `urlquery`) work, and every value written out is HTML-escaped:

```html
<h2>{{ if .Data.name }}Welcome, {{ .Data.name }}{{ else }}Welcome{{ end }}</h2>
<p><a href="{{ .ConfirmationURL }}">Confirm your email</a></p>
{{- if eq .Data.plan "team" }}<p>Your team is waiting.</p>{{ end }}
```

A template that can't be parsed or run (`define` / `template` / `block`, an unknown function), or
one that can't be fetched, is replaced by the built-in one and the reason logged.
`denext generate docker --stack` lists the `GOTRUE_SMTP_*` variables in `.env.example`.

### SAML single sign-on

With `saml` set, `signInWithSSO({ domain })` or `({ providerId })` starts an SP-initiated login,
the IdP posts to `/auth/v1/sso/saml/acs`, and this service provider's metadata is at
`/auth/v1/sso/saml/metadata` (the entity id unless `saml.entityId` says otherwise). Identity
providers come from two places that work side by side: `saml.providers` in config
(`[{ id, domains, metadataXml, attributeMapping, linkExistingAccounts?, allowSignUp? }]`,
read-only), and the providers stored through
the SSO admin API below. An entity id, and every domain, belongs to one provider only.

```ts
backend({
  supabase: {
    auth: {
      saml: {
        providers: [{ id: "acme", domains: ["acme.com"], metadataXml: ACME_METADATA }],
        // Optional: sign AuthnRequests and turn Single Logout on (RSA, RSA-SHA256).
        signingKey: Deno.env.get("SAML_SP_SIGNING_KEY"), // PKCS #8 PEM, or an RSA private JWK
        signingCertificate: Deno.env.get("SAML_SP_SIGNING_CERT"), // its X.509 certificate (PEM)
        // Optional: let IdPs encrypt assertions to this SP.
        encryptionKey: Deno.env.get("SAML_SP_ENCRYPTION_KEY"),
        encryptionCertificate: Deno.env.get("SAML_SP_ENCRYPTION_CERT"),
        // Optional: refresh stored metadata URLs in the background (default: when next used).
        metadataRefresh: { intervalSeconds: 900 },
      },
    },
  },
});
```

Each key is checked against its certificate on first use, and both certificates are published in
the SP metadata (`use="signing"` / `use="encryption"`, with the encryption algorithms accepted).
Generate a pair with `openssl req -x509 -newkey rsa:2048 -nodes -keyout sp.key -out sp.crt`; keep
the keys server-side (they are secrets) and give IdP administrators the metadata URL.

Responses are verified by denext's own SAML code: a strict XML parser (no DOCTYPE or entities),
exclusive c14n, RSA-SHA256/512 or ECDSA-SHA256 signatures only, keys only from the metadata's
certificates, claims read only from the element whose signature verified (signature-wrapping,
duplicate IDs, a second assertion, comment injection are refused), audience, recipient,
destination, validity window and `InResponseTo` checked, and each assertion ID accepted once
(remembered in the adapter, so every replica shares it). IdP-initiated logins are refused: the
`RelayState` names a single-use record of the request being answered. A user's SSO identity is
`sso:<id>`. The provider vouches only for addresses on its `domains`; a first sign-in never
takes over an existing account with the same email (`email_exists`) unless a config-declared
provider sets `linkExistingAccounts: true`, and a new SSO user is created only while sign-ups are
allowed (`disableSignup`, `allowSignUp: false`). See the SAML trust model under Threat notes.

**The SSO admin API** (GoTrue's `/admin/sso/providers`; service role only, so server-side):

| Request                           | Body / answer                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /admin/sso/providers`        | `{ items: SSOProvider[] }`                                                                         |
| `POST /admin/sso/providers`       | `{ type: "saml", metadata_xml \| metadata_url, domains, attribute_mapping, name_id_format }` → 201 |
| `GET /admin/sso/providers/:id`    | the `SSOProvider`                                                                                  |
| `PUT /admin/sso/providers/:id`    | any of the create fields; the metadata must keep its entity id                                     |
| `DELETE /admin/sso/providers/:id` | the removed `SSOProvider` (its domains and session records go with it)                             |

An `SSOProvider` is `{ id, saml: { entity_id, metadata_xml, metadata_url?, attribute_mapping,
name_id_format? }, domains: [{ domain }], created_at, updated_at }`. `attribute_mapping` is
GoTrue's `{ keys: { field: { name | names, default?, array? } } }`: the first named attribute
present (every value with `array`), else `default`, lands in `user_metadata.field`. Errors are
GoTrue's: `saml_idp_already_exists` (422), `sso_domain_already_exists`, `saml_entity_id_mismatch`,
`saml_metadata_fetch_failed`, `validation_failed`, `sso_provider_not_found` (404). A
`metadata_url` must be HTTPS; it is fetched with `safeFetch` pinned to that host (private
addresses refused, 256 KiB, 10 s). (`http://localhost` is accepted only under
`dangerouslyAllowInsecureProviders`.) The adapter's SSO group stores them:
`inMemoryAuthAdapter`, `sqliteAuthAdapter` and `postgresAuthAdapter` (migrations
`0004_auth_sso_providers`, `0006_auth_sso_metadata_validity`) implement it.

**Metadata validity.** The metadata's own `validUntil` (an `xs:dateTime` with a time zone) and
`cacheDuration` (an `xs:duration` such as `PT6H` or `P1D`) are read from the EntityDescriptor and
an enclosing EntitiesDescriptor — the earliest `validUntil` and the shortest `cacheDuration` win;
a malformed value refuses the metadata (`bad_metadata`, a 400 `validation_failed` from the admin
API). A provider whose metadata is past its `validUntil` — stored, or a config-declared
`metadataXml` — fails closed: `POST /sso` and IdP-initiated Single Logout answer 400
`saml_metadata_expired`, the ACS and an SP-initiated logout land on `redirect_to` with
`error_code=saml_metadata_expired`, and the logger warns once per provider. Creating or updating a
provider with already-expired metadata is a 400 `validation_failed`. A `metadata_url` provider is
fetched again at the earliest of a day after the last fetch, `cacheDuration` after it and
`validUntil` (never within five minutes of the last fetch); the record keeps `metadataValidUntil`
and that `metadataRefreshAfter` (epoch seconds; columns `metadata_valid_until`,
`metadata_refresh_after`). A failed refresh — an unreachable URL, an invalid or expired document,
one for another entity id — keeps the stored copy, usable only while it is within its own
`validUntil`; fresh metadata from a later refresh (or the admin API) reopens the provider. The
fetch is single-flight per provider and, after a failure, backs off for five minutes, doubling up
to an hour, so a stream of sign-ins never fetches one URL more than once per window.

By default a due provider is fetched when it is next used. `saml.metadataRefresh: {
intervalSeconds }` (default 900, at least 60) refreshes every due provider in the background
instead — one at a time, with jitter, failures logged and never thrown; the timer does not keep the
process alive and stops when the plugin is torn down. Or run it on your own schedule from a job:

```ts
// jobs/sso-metadata.ts
import { defineJob, refreshSsoMetadata } from "denext/server";

export default defineJob({
  description: "refresh stored SAML metadata URLs",
  schedule: "*/30 * * * *",
  handler: async () => {
    const { refreshed, failed } = await refreshSsoMetadata(); // { checked, refreshed, unchanged, failed, skipped, results }
    if (failed) console.warn(`SAML metadata: ${failed} provider(s) failed to refresh`);
    console.info(`SAML metadata: ${refreshed} refreshed`);
  },
});
```

`refreshSsoMetadata(config?, { force?, jitterMs? })` uses the active `denextAuth()` config unless
given one, and shares the fetch limiter with sign-ins. supabase-js 2.117 has no `auth.admin.sso`
client; call the endpoints with the secret key.

**Single Logout** is on when `saml.signingKey` is set, and the SP metadata then advertises
`/auth/v1/sso/saml/slo` (HTTP-Redirect and HTTP-POST):

- _SP-initiated._ `POST /logout` (supabase-js `signOut()`) for a session a SAML assertion started
  ends it at once, as always, and answers `200 { url }` instead of `204`: the IdP's
  SingleLogoutService URL with a LogoutRequest signed over the HTTP-Redirect binding for that
  session's NameID and SessionIndex. Send the browser there (`?redirect_to=` on `/logout` names
  where it lands afterwards); the IdP's signed LogoutResponse comes back to `/sso/saml/slo` and is
  checked against the request it answers (single-use `RelayState`, `InResponseTo`). A
  `scope=others` logout, a non-SAML session, or an IdP without a SingleLogoutService stays `204`.
- _IdP-initiated._ A LogoutRequest at `/sso/saml/slo` (HTTP-Redirect: the query signature over
  `SAMLRequest`, `RelayState`, `SigAlg` as received; HTTP-POST: an enveloped XML signature through
  the same strict verifier as a Response) must be signed by the IdP, name this SP's SLO URL as its
  Destination, be fresh (`IssueInstant` within five minutes, `NotOnOrAfter`) and new (its ID is
  claimed once). It ends every session that NameID started — only those whose SessionIndex it
  names, when it names any — and is answered with a signed LogoutResponse.

**Encrypted assertions.** With `saml.encryptionKey` an `EncryptedAssertion` is accepted: key
transport RSA-OAEP (`xmlenc#rsa-oaep-mgf1p`, `xmlenc11#rsa-oaep` with SHA-1 or SHA-256), content
AES-128/256-GCM (`xmlenc11`) or AES-128/256-CBC (`xmlenc`); anything else is
`unsupported_algorithm`. A Response signature is verified before anything is decrypted, so it
covers the cipher text; the decrypted Assertion then goes through exactly the checks a plaintext
one does (the strict parser, one assertion, IDs unique across the whole document, its own
signature when it has one). An `EncryptedID` — the NameID of an Assertion's Subject, or of an
IdP's LogoutRequest — is accepted under the same rules: the same algorithms and content model
(one EncryptedData, exactly one EncryptedKey), opened only after the signature covering it (the
Assertion's, the Response's, the LogoutRequest's) has verified, and its decrypted content must be
exactly one `saml:NameID`, parsed by the strict parser in the EncryptedID's namespace context
(markup or a comment inside it is `unexpected_markup`). A Subject or LogoutRequest holding two
identifiers, or an EncryptedID beside a NameID, is `malformed_response`; an EncryptedID anywhere
else (a SubjectConfirmation, an attribute) is refused. Without an encryption key an
`EncryptedAssertion` or `EncryptedID` is refused (`encrypted_assertion_unsupported`).

`denext/server` exports the primitives underneath for your own endpoints: `verifySamlResponse`
(`sp.encryptionKey`), `buildAuthnRequest` (signed with `sp.signingKey`), `buildLogoutRequest`,
`buildLogoutResponse`, `peekLogoutMessage`, `verifyLogoutRequest` and `verifyLogoutResponse`.

### OAuth 2.1 server

With `oauthServer: {}` your app is an authorization server other apps (an MCP client, a partner's
web app, a CLI) sign your users in with — Supabase's "OAuth 2.1 server". Register a client with the
secret key (`supabase.auth.admin.oauth.createClient({ client_name, redirect_uris })`; also
`listClients`, `getClient`, `updateClient`, `deleteClient`, `regenerateClientSecret`). The client
sends the user to `/auth/v1/oauth/authorize` (`response_type=code`, `client_id`, `redirect_uri`,
`scope`, `state`, `code_challenge`, `code_challenge_method=S256`, optional `nonce`); denext sends
them on to your consent page, `{siteUrl}{authorizationPath}?authorization_id=…` (default
`/oauth/consent`), which you build with the user's own session:

```ts
// the consent page (signed in as the user)
const { data } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
if ("redirect_url" in data) location.assign(data.redirect_url); // already granted
else {
  // show data.client.name, data.scope … then:
  await supabase.auth.oauth.approveAuthorization(authorizationId); // or denyAuthorization
}
```

The client exchanges the code at `POST /auth/v1/oauth/token` (`grant_type=authorization_code`, the
`code_verifier`, client authentication by its registered `token_endpoint_auth_method`:
`client_secret_basic`, `client_secret_post`, or `none` for a public client) and gets an access
token — a Supabase JWT with `client_id` and `scope` claims, so RLS can tell a third party's request
from the user's own — a refresh token (`grant_type=refresh_token`) and, with the `openid` scope, an
id_token. `GET /auth/v1/oauth/userinfo` answers within the scopes (`openid`, `email`, `profile`,
`phone`), and `/auth/v1/.well-known/oauth-authorization-server` (and `openid-configuration`)
describes the server. Users see and revoke their grants with `supabase.auth.oauth.listGrants()` /
`revokeGrant({ clientId })`.

### Stored providers (`custom:`)

`supabase.auth.admin.customProviders.createProvider({ provider_type, identifier: "custom:acme",
name, client_id, client_secret, … })` stores an OAuth 2.0 provider (`authorization_url`,
`token_url`, `userinfo_url`) or an OIDC one (`issuer`; its discovery document is fetched and checked
when you save it, or give `authorization_url` + `token_url` + `jwks_uri`), with `scopes`,
`authorization_params`, `attribute_mapping` (`{ sub, email, email_verified, name, picture }` →
the provider's claim names) and `enabled` / `email_optional`; list, get, update and delete it the
same way. `signInWithOAuth({ provider: "custom:acme" })` then signs in through it, exactly like a
configured provider; register `https://<your app>/auth/v1/callback` as its redirect URI.
`acceptable_client_ids`, `custom_claims_allowlist`, `pkce_enabled` and `skip_nonce_check` are stored
and returned but not applied: PKCE and the nonce are always used and checked.

### Web3 sign-in

`web3: { ethereum: {}, solana: {} }` turns on `supabase.auth.signInWithWeb3({ chain, wallet })`: the
wallet signs a Sign-In with Ethereum (EIP-4361) or Sign-In with Solana message, and the user whose
identity is that address is signed in (created on first sign-in unless `disableSignup`). The
identity is GoTrue's: provider `web3`, `sub` / provider id `web3:<chain>:<address>` with the address
exactly as the message writes it (supabase-js writes Ethereum addresses lower-case, so a checksummed
spelling is another identity, as in GoTrue), `identity_data.custom_claims` `{ address, chain,
network, domain, statement }`, `app_metadata.provider` `web3`, and `amr` method `web3`. Refusals are
GoTrue's too: a disabled chain answers `422 web3_provider_disabled`, an unknown one `400
web3_unsupported_chain`, a malformed request or message `400 validation_failed`, and a signature or
message that doesn't sign in here (wrong signer, URI, domain, chain id, time window, a used nonce)
the OAuth-style `400 { error: "invalid_grant", error_description }` with GoTrue's descriptions.
Ethereum signatures are verified by recovering the signer (secp256k1 and Keccak-256 in denext's own
TypeScript; Web Crypto has neither), Solana's with Web Crypto's Ed25519. `ethereum.chainIds`
restricts the `Chain ID`, `domains` allows message domains besides the app's own host, and `maxAge`
(600 seconds) bounds how old `Issued At` may be.

### Threat notes

- **Keys.** The secret key and the legacy `service_role` JWT bypass row-level security and the
  admin API trusts them: server-side only. The publishable key is public by design — authorization
  is RLS and the endpoints' own checks.
- **Tokens.** Access tokens are ES256 (or HS256 under a legacy secret) with `exp` required and only
  Supabase's three roles; `none` and algorithm confusion are refused. Every request re-checks the
  token's session, so `signOut` ends it at once (Supabase lets it live to expiry). Refresh tokens
  rotate; a used one is answered again only within `refreshTokenReuseInterval`, after which
  presenting it is a replay that revokes the whole session.
- **Codes and links.** Email / SMS codes are stored only as a hash of an HMAC under the auth secret,
  are single-use, expire (`otpExpiry`) and are rate-limited per address (`rateLimit.mfa` /
  `rateLimit.verification`); a link and its code are one secret. Password sign-in uses the
  credentials limiter and answers an unknown user and a wrong password alike; a second sign-up for
  a confirmed address answers with an obfuscated user.
- **Pre-account hijacking.** The first proof of an account's address keeps only what the account's
  own sign-up confirmation proves: that confirmation keeps the password the sign-up chose. Any other
  first proof — a magic link, an email or SMS code, a recovery link, an invite, a trusted SSO link —
  removes the password, the second factors, the passkeys, the bearer API tokens and every session
  (token and cookie) set up before it. An anonymous user's address change keeps only the password
  it held when the change was requested, and an anonymous user can't set a password without an
  address. An OAuth sign-in vouches only for the address it asserts, and linking it to an
  unconfirmed account (`allowDangerousEmailAccountLinking`) clears that account the same way.
  A sign-up for an unconfirmed account with no password yet (made by a one-time code or an invite)
  sets its password and binds it as a new sign-up does; a sign-up with a different password than
  the account's contests it for good (the account's password becomes one nobody holds, so no later
  sign-up can claim it), and an account with a verified phone keeps its password. An
  admin-generated sign-up link is the account's own sign-up confirmation: it keeps the password
  the admin set.
- **Assurance level.** Once a user holds a verified factor, changing the password, email or phone
  (`PUT /user`), linking or unlinking an identity, and managing factors, recovery codes and
  passkeys need an `aal2` session (`401` / `403 insufficient_aal`, GoTrue's rule). A session that
  still owes its second factor can only read the user, finish MFA and sign out; the other account
  endpoints refuse it.
- **One user store.** A ban (`ban_duration`) refuses denextAuth's own sign-ins too and ends every
  session of both kinds; while it lasts, the user's tokens (bearer API tokens, native tokens,
  access and refresh tokens) are refused at every use as well, and so is every denextAuth cookie
  session, a stateless one included (each read re-reads the user) — so a stateless cookie still
  owing its second factor can't finish the step-up either. A ban also stamps the user's
  `sessionsValidAfter`, so a cookie session from before it stays ended once the ban is lifted. A
  password change through `/auth/v1` ends the user's other sessions, including every denextAuth
  cookie session, stateless ones included (`sessionsValidAfter`); an admin password change ends
  all of them, as in GoTrue.
  `session.user.emailVerified` of an access token is read from the stored user, never from the
  user-writable `user_metadata`, whose `email_verified` / `phone_verified` are always the stored
  flags.
- **PKCE and OAuth.** Only `s256` is accepted. An OAuth flow is bound to the browser by denext's
  signed transaction cookie; a PKCE flow started cross-origin finishes without it, but nothing —
  no session, no identity link — happens until the code is exchanged with the verifier. Implicit
  flows (tokens in the fragment) have the login-CSRF exposure GoTrue's have; prefer PKCE.
- **Redirects.** `redirect_to` must be the site URL's origin or match `redirectUrls`; anything else
  falls back to the site URL.
- **MFA.** Factor secrets are sealed under the auth secret; a challenge is single-use and lives five
  minutes; a TOTP step is never accepted twice; removing a verified factor needs `aal2`.
- **SAML encryption is not integrity.** Anyone holding the SP's public encryption certificate can
  encrypt an assertion to it, so a decrypted Assertion is trusted only through a signature: the
  Response's (checked over the cipher text before decrypting) or the Assertion's own. AES-CBC is
  malleable; when no Response signature covers the cipher text, every refusal from the key unwrap
  to the decrypted Assertion's signature is the one `decryption_failed` (and the ACS answers every
  refusal with the same redirect), so a forged cipher text learns nothing about padding or
  well-formedness. An `EncryptedID` is opened only after the signature covering it verified (an
  unsigned message is refused before anything is decrypted), so a tampered cipher text is
  `bad_signature`; were it ever reached uncovered, every refusal inside the decryption window would
  be the same `decryption_failed`. Prefer IdPs that sign the Response, and AES-GCM.
- **SAML keys and Single Logout.** The SP signing and encryption keys are secrets; rotate one by
  publishing the new certificate in the metadata first. Single Logout ends denext's sessions
  immediately and only asks the IdP to end its own — a user who never reaches the IdP's SLO page
  keeps their IdP session. A logout message is refused unless signed by the IdP's metadata
  certificate, and a replayed one is refused; its ID, like an assertion ID, is remembered in the
  adapter so every replica shares the check. An adapter without that table falls back to
  `@denext/backend`'s Postgres when `backend({ postgres })` is set up, and to a per-process
  cache only without either.
- **SAML trust model.** An IdP speaks only for the email domains its provider was registered
  with. An address on one of them becomes the account's verified email; an IdP stored through the
  admin API that asserts any other address is refused (`403 email_address_not_authorized`), and a
  config-declared one signs in a user with no email on the account. Registering a domain proves
  nothing, so verify that a customer owns a domain before you register their IdP for it. A first
  SSO sign-in never takes over an existing account with the same email, as in GoTrue: it is
  refused with `email_exists` unless a config-declared provider sets `linkExistingAccounts` (and
  then only for addresses on its domains). SSO users are created only while sign-ups are allowed
  (`disableSignup`, the provider's `allowSignUp`), and have no `email` identity. An SSO user's
  password, email and phone belong to its IdP: `PUT /user` refuses to change them
  (`422 user_sso_managed`, as in GoTrue), and its last SSO identity can't be unlinked.
- **SSO users sign in through their IdP only**, so the IdP's MFA, policies and deprovisioning
  hold. Every other sign-in looks an SSO user up as "no such user", as GoTrue does: a magic link,
  an email or SMS code, a password, a recovery link or a resend (on `/auth/v1` and through
  `magicLink()`, `emailOtp()`, `phoneOtp()`, `credentials()` and `{basePath}/reset`) sends nothing
  and answers as for an unknown address. Unlike GoTrue, an address belongs to one account, so a
  sign-up for an SSO user's address answers as for a registered one instead of creating a second
  account, and an OAuth, native or `id_token` sign-in with that address is refused rather than
  linked (even with `allowDangerousEmailAccountLinking`). A code or reset link issued before the
  account became an SSO user signs nobody in. An SSO user can't register a passkey, a passkey it
  held before signs it in nowhere, and linking an identity to it needs a session its IdP started;
  unlike GoTrue, an identity linked that way (an OAuth account) does not sign it in (`422
  user_sso_managed` on `/auth/v1`, `AccountNotLinkedError` in denextAuth). The
  admin API's `generate_link` answers `user_not_found` for `recovery` and the email-change links,
  and `email_exists` for `magiclink`, `signup` and `invite` (GoTrue would create a new account
  for them), as does `POST /invite`. A user is an SSO user when its stored
  `app_metadata.provider` is `sso:<id>` (its first SAML sign-in sets it), so linking or unlinking
  identities never changes it, and neither does the admin API (as GoTrue's `is_sso_user`, it is
  not admin-writable: an `app_metadata.provider` that would make a user an SSO user, stop one being
  one or move it to another provider is kept as stored, and `POST /admin/users` never creates
  one). An existing account an IdP was linked to (`linkExistingAccounts`) is not an SSO user and
  keeps its other sign-in methods; an SSO user another provider signed up is never linked
  (`email_exists`).
- **An SSO user's sessions are the ones its IdP started.** A session of an SSO user whose stored
  `amr` has no `sso/saml` entry — one from before the account became an SSO user, or from before
  non-SSO sign-ins of SSO users were refused — is refused at every use (`403 session_not_found`)
  and at refresh (`refresh_token_not_found`, and its session is revoked). A session that stepped
  up with MFA after a SAML sign-in keeps its `sso/saml` entry and keeps working. Whether a session
  was SSO-started is read from its stored session, never from the access token's `amr` claim,
  which the custom access token hook may rewrite: linking an identity onto an SSO user, and the
  `amr` of the session `auth()` returns for a bearer access token, both come from the stored
  session. A token issued to an OAuth client lives only when its grant was approved from a session
  the IdP started; one approved from any other session (or recorded before denext kept that fact)
  is refused at use and revoked at refresh, and its code can't be exchanged. denextAuth's own
  sessions never come from an IdP: an SSO user's native session is refused at use and revoked at
  refresh, and its cookie session reads as signed out from its next request (every cookie-session
  read re-reads the user). A bearer API token of an SSO user authenticates only when it was minted
  from a session the IdP started (`issueApiToken({ session })`); one minted without a session or
  from any other — `POST {basePath}/tokens` mints from a cookie session, so never — is refused.
  `GET /reauthenticate` for an SSO user answers `422 user_sso_managed` and sends nothing (GoTrue
  sends a nonce `PUT /user` then refuses).
- **SAML endpoints.** The SingleSignOnService and SingleLogoutService URLs in IdP metadata are sent
  to the browser, so they must be `https:` (a loopback `http:` one only under
  `dangerouslyAllowInsecureProviders`); any other scheme refuses the metadata at registration, at
  a refresh and at use.
- **SAML metadata URLs** are fetched SSRF-safely (HTTPS, host-pinned, private addresses refused);
  the metadata's own signature is not checked, so register only URLs of the IdP you trust. Expired
  metadata (`validUntil`) fails closed rather than keep trusting a certificate the IdP may have
  retired; the fetch limiter keeps a flood of sign-ins from turning into a flood of fetches.
- **OAuth 2.1 server.** A `redirect_uri` must equal a registered one (a loopback `http:` one may
  differ only in its port); an unknown client or redirect is answered with an error, never a
  redirect. PKCE S256 is required of every client. An authorization request is bound to the first
  signed-in user who opens it and settles once; its code is stored as a hash, single-use and
  short-lived (`codeExpiry`, 120 seconds), and presenting a used code again revokes the tokens it
  was exchanged for. Client secrets are 256 random bits stored as a SHA-256, shown only on create
  and regenerate. Refresh tokens are the same rotating families as first-party sessions (reuse
  revokes the family) and refresh only for their own client — never at `/token`. Revoking a grant,
  or deleting a client, revokes every session the client holds at once. A client's access token
  carries `client_id`: it reads `GET /user` and userinfo, but cannot change the password, factors
  or identities, list grants or answer a consent request. It is accepted by `auth()`, `db()` and
  auto-REST like the user's own, so write RLS policies on `auth.jwt() ->> 'client_id'` where a
  third party should see less.
- **Stored providers.** The client secret is sealed (AES-256-GCM under a key derived from the auth
  secret) and never returned. Discovery, token, userinfo and JWKS calls go through the same
  SSRF-safe, host-pinned fetch as configured providers, and endpoints must be `https:`. A stored
  provider's flow carries the same signed transaction, `state`, PKCE and OIDC `nonce`.
- **Web3.** A signature counts only for a message naming this app: its domain is the app's host
  (or in `domains`), its `URI` the site URL or an allowed redirect URL, `Version` 1, a configured
  `Chain ID`, `Issued At` neither in the future (30 s of skew) nor older than `maxAge`,
  `Expiration Time` / `Not Before` honored. The nonce — or the whole message when it has none — is
  claimed once in the adapter, so a captured signature can't be replayed. Ethereum signatures with
  a high `s` (EIP-2) or a recovery id other than 27 / 28 are refused, and a mixed-case address
  must carry its EIP-55 checksum. The app's host is the site URL's: set `siteUrl` or the auth
  `canonicalOrigin` in production, or it is the request's own `Host`. Wallet phishing is out of
  scope: a user who signs a message for another site's domain is refused here, but the wallet is
  what shows them the domain.

## Security notes

- **CSRF.** Every state-changing auth POST — the Credentials, email and phone callbacks,
  `/anonymous`, `/signout`, `/verify`, `/reset`, `/reset/confirm`, the `/mfa` steps and the
  `/tokens` mutations — is gated on a same-origin `Origin` / `Referer`. With `canonicalOrigin` set
  it is matched exactly and scheme-strictly; otherwise the request's own `Host` is the fallback.
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
- **OAuth/OIDC.** Authorization Code with a CSRF `state` on every flow, plus PKCE (S256) and,
  for OIDC, a `nonce` unless the provider's [`checks`](#pkce-state-and-nonce-checks) leave them
  out; `id_token`s verified against the provider's JWKS across the RS/PS/ES families
  (`RS/PS/ES 256/384/512`; `none` and unknown algorithms rejected) — HS256 only for an `oidc`
  provider configured with `idTokenAlg: "HS256"`, verified under its client secret, with no
  other algorithm accepted from it — plus `iss`, `aud`
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
- **Pre-account hijacking.** A first magic-link or code sign-in (or a password reset) into an
  account whose address was never verified retires everything set up without that proof —
  the password, any TOTP factor and backup codes, passkeys, bearer tokens, server-side
  sessions and native app sessions — before marking it verified, and no passkey can be
  registered on it until then.
- **Native sessions.** The one-time code is hashed at rest, bound to the registered redirect URI and
  a PKCE `S256` challenge, lives 60 seconds (`codeTtl`) and gets one try; it is minted only for a
  sign-in made after `/native/authorize` began, so a lingering browser session can't be handed to
  whatever app started the flow. Access tokens are HMAC-signed under their own MAC domain and
  re-checked against their session family on every request, so a revoked family stops at once. A
  replayed refresh token (an older generation with a valid MAC) revokes its whole family; a forged
  one (bad MAC) is refused without touching it. Two settings adjust this:
  `native.refreshTokenMaxAge` caps a family absolutely from its sign-in (default none), and
  `native.refreshReuseInterval` (default 10 seconds, as GoTrue's, at most 60; `0` is strict) lets
  the immediately previous refresh token re-fetch the same pair shortly after its rotation, so
  refreshes that race don't sign the user out — at the cost of missing a replay inside that window.
  The native POSTs take no ambient credential, so a request with no `Origin` (a native HTTP client)
  passes, while a present `Origin` must be this app or one the `cors` config allows, and `"null"`
  never is. See [App backend](/docs/app-backend#security).

The [security posture guide](/docs/security) maps every Next.js, React and next-auth /
Auth.js CVE class against denext's own implementation, with a live parity test suite.

## Clerk instead of `denextAuth`

A hosted provider works too, unchanged: `@clerk/nextjs` runs on denext's next-compat pipeline
the way it runs on Next.js — `clerkMiddleware()` with `createRouteMatcher` in `middleware.ts`,
`<ClerkProvider>` in the root layout, `auth()` and `currentUser()` in Server Components and
route handlers (a `defineApi` route included). Its client components render as islands straight
from the package, and in a Deno Desktop window the same provider signs in through
`installClerkDesktopBridge({ nativeClerk: true })` from `denext/desktop/clerk` (see
[Clerk on Deno Desktop](/docs/desktop#desktop-clerk)).
[examples/clerk](https://github.com/Brainwires/denext/tree/main/examples/clerk) is the runnable
version: email code, password, Google / GitHub and passkeys, a protected page and API, the Clerk
dashboard steps, Tailscale for your other devices, and tests against a Clerk development instance
in its test mode (`+clerk_test` addresses verify with `424242`).

## Limitations

What the first-party auth layer still does not do — the full ledger is
[Known limitations](/docs/limitations):

- **Emailed tokens are delivered after the response.** Every one goes through your
  `sendVerificationRequest` (`smtpMailer()` or your own), handed over after the response, so
  delivery is best-effort where the platform freezes the isolate.
- **Passkeys: two attestation formats, three algorithms.** Only `none` and `packed` statements
  are verified — `tpm`, `android-key`, `apple` and `fido-u2f` are refused, or with
  [`attestation.mds`](#attestation-the-fido-metadata-service) and `allowUnattested` registered
  as unattested — as are ES384, ES512 and Ed448 keys. The Metadata Service checks fetch no
  certificate revocation lists.
- **Single-node SQLite, additive schema only, and sliding expiry only on paths that own a
  `Response`** — see [Database adapter](#database-adapter) and [Sessions](#sessions).
- **`verifyTotp` is SHA-1 only**, the algorithm every authenticator app supports.
- **Apple's name arrives once.** Apple posts the user's name on their first authorization
  only; without an adapter to store it, later sessions carry no name.
- **`magicLink({ confirm: false })` spends a link on its GET**, so a mail gateway that
  pre-fetches links can burn one; the default confirmation page (or `emailOtp()`) avoids it.
- **Rotating `secret` invalidates the one-time codes in flight**: they are keyed under the
  current (first) secret, and live for minutes. A retired secret can be removed once
  `denext auth reseal` reports zero remaining.
- **Stateless cookie sessions end early only through an adapter**: a password reset, a ban or
  `revokeAllSessions` stamps the stored user's `sessionsValidAfter`; with no adapter there is
  no user to stamp, and a cookie lives until it expires.
- **`mfa.required: "always"` is trust-on-first-use**: a user with no factor enrolls one
  during the step-up, so whoever holds the first factor at that moment chooses the second.
- **A Server Action must spend the MFA attempt budget itself.** The endpoints spend it; a
  Server Action calling `verifySecondFactor` or `confirmTotp` calls
  `spendMfaAttempt(authConfig, { userId })` first (see above).
- **An email address's local part must be ASCII**: the emailed flows refuse an SMTPUTF8 local
  part. An internationalised domain is accepted and carried in its punycode form
  (`ada@bücher.de` is `ada@xn--bcher-kva.de`).
