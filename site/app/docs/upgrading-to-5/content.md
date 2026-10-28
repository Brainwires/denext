---
title: Upgrading to 5.0
slug: upgrading-to-5
lead: What changes for a 4.x project in denext 5.0, and what `denext upgrade` rewrites for you.
---

## In short

Run `denext upgrade` from the project. When it moves the `jsr:@denext/denext` pin from 4.x to 5.0
or later it also makes the source and `deno.json` changes on this page, and prints each module it
rewrote. Preview them first with `denext upgrade --dry-run` (or `--json`). Every rewrite is
textual: comments, formatting and every other import are kept.

## The auth layer is `@denext/auth`

denext's first-party auth (`denextAuth()`, the providers, the adapters and stores, SAML, the
GoTrue-compatible `/auth/v1`, passkeys, MFA, the mailers, and the `next-auth` compat) left
`@denext/denext` for its own package, **`@denext/auth`**. It is opt-in like `@denext/backend`, and
it keeps `@denext/denext` under JSR's package size limit.

`@denext/auth`'s version is denext's own: auth 5.0.0 is built on denext 5.0.0 and pins it exactly.
Pin the two at the same range, and move them together (`denext upgrade` does):

```json
{
  "imports": {
    "denext": "jsr:@denext/denext@^5.0.0",
    "denext/server": "jsr:@denext/denext@^5.0.0/server",
    "@denext/auth": "jsr:@denext/auth@^5.0.0"
  }
}
```

Like every `@denext/*` pin, `@denext/auth` is held by Deno's minimum dependency age: `denext
create`, `migrate` and `upgrade` only pin a version old enough for it
([the supply-chain hold](/docs/toolchain#supply-chain-hold)).

### What stays in `denext/server`

These read the session or are shared with the rest of denext, so they did not move:

| Name                                                                               | What it is                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `auth()`, `requireAuth()`, `requireSession()`                                      | read the session / guard middleware and route handlers, through the plugin     |
| `AuthPluginMissingError`                                                           | what those three throw when no `denextAuth()` plugin is configured             |
| `getSession()`                                                                     | the signed-cookie session primitive (no plugin needed)                         |
| `AuthSession`, `AuthUser`, `AuthSessionSaml`, `SessionStore`                       | the session shapes and the store contract                                      |
| `inMemoryRateLimitStore`, `RateLimitStore`, `RateLimitWindow`                      | the stores `rateLimit()` counts in                                             |
| `hashPassword()`, `verifyPassword()`                                               | password hashing                                                               |
| `generateSupabaseKeys()`, `signSupabaseJwt()`, `verifySupabaseJwt()` and their kin | Supabase-compatible API keys and JWTs (`denext backend keys`, the stack verbs) |

Everything else that `denext/auth` exported, and that `denext/server` re-exported (`denextAuth`,
`github`, `credentials`, `sqliteAuthAdapter`, `requireBearer`, `smtpMailer`, `AuthConfig`, …), is
`@denext/auth`'s.

Without the plugin, `auth()`, `requireAuth()` and `requireSession()` now throw an
`AuthPluginMissingError` instead of reading as signed out: the message names `@denext/auth` and
how to add it. Code that runs with or without auth can catch it:

```ts
import { auth, AuthPluginMissingError } from "denext/server";

const session = await auth().catch((error) => {
  if (error instanceof AuthPluginMissingError) return null; // no auth configured: signed out
  throw error;
});
```

### What `denext upgrade` rewrites

| Before (4.x)                                                         | After (5.0)                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `import { auth, denextAuth, github } from "denext/server";`          | `import { auth } from "denext/server";` and `import { denextAuth, github } from "@denext/auth";` |
| `import { denextAuth } from "denext/server";`                        | `import { denextAuth } from "@denext/auth";` (only the specifier changes)                        |
| `import { auth, saml } from "denext/auth";`                          | `import { auth } from "denext/server";` and `import { saml } from "@denext/auth";`               |
| `import { requireBearer } from "@denext/denext/server";` (a library) | `import { requireBearer } from "@denext/auth";`                                                  |
| `"denext/auth": "jsr:@denext/denext@^4.9.0/auth"`                    | `"@denext/auth": "jsr:@denext/auth@^5.0.0"`                                                      |
| `"next-auth/jwt": "jsr:@denext/denext@^4.9.0/next-auth/jwt"`         | `"next-auth/jwt": "jsr:@denext/auth@^5.0.0/next-auth/jwt"`                                       |

`import type`, inline `type` modifiers, `as` renames, `export { … } from` re-exports and pinned
`jsr:@denext/denext@<range>/server` specifiers are split the same way. The `@denext/auth` entry is
added to the root `deno.json` when a module needs it. A `next-auth` import needs no change: its
alias in `deno.json` now points at `@denext/auth`'s shim.

`node_modules`, `.denext`, `dist`, `out`, `coverage` and `vendor` are not walked, nor are symbolic
links.

### What it can't rewrite

A namespace import (`import * as server from "denext/server"`), an `export *` or a dynamic
`import("denext/server")` can't be split by text. `denext upgrade` leaves it as it is and names it,
with the module path: import the auth names from `@denext/auth` by hand.

### Plugin and library authors

A package that imported auth names from `@denext/denext/server` now depends on `@denext/auth` too.
Add it to the package's `deno.json` `imports` at the same version as its `@denext/denext`
(`"@denext/auth": "jsr:@denext/auth@^5.0.0"`). `@denext/auth` is built on
`@denext/denext/auth-kit`, an entry point of denext's internals that moves with each release; it is
not a stable API.
