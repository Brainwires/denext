# Changelog

## Unreleased

### Added

- **The package.** denext's auth layer, which shipped inside `@denext/denext` (`denext/auth`,
  `denext/server`, `denext/next-auth/*`) through 4.x, is its own package from denext 5.0:
  `denextAuth()`, the providers, adapters and stores, SAML, the GoTrue-compatible `/auth/v1`,
  passkeys, MFA, the mailers and the `next-auth` compat (`@denext/auth/next-auth/*`). Its version
  is denext's, and it pins that `@denext/denext` version exactly. `auth()`, `requireAuth()`,
  `requireSession()`, `getSession()`, the session types, the rate-limit stores, password hashing
  and the Supabase key minting stay in `denext/server`. `denext upgrade` rewrites a 4.x project's
  imports: https://denext.dev/docs/upgrading-to-5
