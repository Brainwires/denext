# @denext/auth

**First-party auth for [denext](https://denext.dev)**, as one opt-in plugin: OAuth 2.0 / OIDC
providers, credentials, magic links and one-time codes, passkeys, TOTP second factors, SAML 2.0
SSO, bearer API tokens, revocable sessions, the Supabase-compatible `/auth/v1` API that
`@denext/backend` mounts, and the `next-auth` (Auth.js v5 / NextAuth.js v4) compat.

```ts
// denext.config.ts
import { denextAuth, github } from "@denext/auth";

export default {
  plugins: [
    denextAuth({
      secret: Deno.env.get("AUTH_SECRET")!,
      providers: [
        github({
          clientId: Deno.env.get("GITHUB_ID")!,
          clientSecret: Deno.env.get("GITHUB_SECRET")!,
        }),
      ],
    }),
  ],
};
```

Read the session anywhere on the server with `auth()` from `denext/server`; guard middleware with
`requireAuth(request)` and API routes with `createApi().use(requireSession())`. Those stay in
`denext/server` and read through the plugin once it is in `plugins`; without it they throw an
error that says how to add it.

```ts
import { auth } from "denext/server";
const session = await auth(); // null when signed out
```

The package version is denext's own: `@denext/auth` X.Y.Z pins `@denext/denext` X.Y.Z exactly
(it builds on denext's internals), and `denext upgrade` moves the two together.

## next-auth

A migrated Next.js app keeps its `next-auth` imports: `denext migrate` maps `next-auth` and
`next-auth/*` to `jsr:@denext/auth/next-auth/*` in `deno.json`.

Docs: https://denext.dev/docs/auth (its `next-auth` sections) · https://denext.dev/docs/upgrading-to-5
