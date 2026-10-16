---
title: Internationalization
slug: i18n
lead: Locale routing with a default-locale prefix, locale negotiation, automatic hreflang, and the next-intl compat surface with its ICU message formatter.
---

## Configure locales

Internationalized routing is one config field —
`i18n: { locales, defaultLocale, localePrefix?, messages?, hreflang?, domains? }`.
`localePrefix` is `"as-needed"` (the default — the default locale is served unprefixed at
`/about`, every other locale is prefixed at `/fr/about`) or `"always"` (every
locale is prefixed, including the default; an unprefixed path redirects to the
detected locale's prefix). `messages` holds optional catalogs keyed by locale —
the active locale's catalog is provided to the render and embedded in the
hydration payload, which is what powers `useTranslations()`. The full field list
lives on the [configuration page](/docs/config).

```ts
// denext.config.ts
export default {
  i18n: {
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "as-needed",
    messages: { en: { greeting: "Hello" }, fr: { greeting: "Bonjour" } },
  },
} satisfies DenextConfig;
```

## A locale per domain

`domains` serves a locale on its own host with no prefix, as Next's `i18n.domains` does:
`example.fr/about` renders French. Each entry pins a `domain` to a `defaultLocale`, served
unprefixed on that host; its other `locales` (all of them when omitted) are still prefixed
there, and `http: true` makes its generated URLs `http://` for local testing. Locales tied to
no domain keep the prefix rules above on the primary host. The render path and
`localeMiddleware` match the request's host (`X-Forwarded-Host` under `trustForwardedHeaders`
only, else `Host`) against the configured domains, and an unlisted host gets the default locale.
`canonicalOrigin` no longer masks domain routing: it governs absolute URLs only.
`localeMiddleware` never redirects on a matched domain, and the hreflang alternates for a
domain's locales are absolute URLs on that domain.

```ts
export default {
  i18n: {
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
    domains: [{ domain: "example.fr", defaultLocale: "fr" }],
  },
} satisfies DenextConfig;
```

## Where the locale lands

The locale is peeled off the pathname at request time — the router core is
untouched — and merged into the route `params`, so pages, layouts, templates and
client hydration all see `params.locale`. In a Client Component, `useLocale()`
from `denext` reads the locale the server resolved and re-reads it on soft
navigation; Server Components should read `params.locale` directly.

Because peeling happens before matching, **middleware matchers see the
locale-stripped path** — `matcher: "/admin/:path*"` fires for `/fr/admin/x` as
well as `/admin/x`, so a locale prefix can never route around a path-restricted
middleware. That note is owned by
[the deployment guide's app-layer responsibilities](/docs/deploy).

```tsx
"use client";
import { useLocale } from "denext";

export function LocaleBadge() {
  return <span>{useLocale()}</span>;
}
```

## Negotiation

`localeMiddleware(i18n)` from `denext/server` redirects an unprefixed request to
the visitor's detected locale when it differs from the default. Detection picks
the best supported locale from the `NEXT_LOCALE` cookie (highest priority), then
the `Accept-Language` header, falling back to the default locale; it matches
both exact tags and the primary subtag, so `fr-CA` matches a supported `fr`.
Requests that already carry a locale prefix, or whose detected locale is the
default, pass through untouched. The pieces are exported individually too —
`detectLocale`, `parseAcceptLanguage`, `peelLocale`, `localeHref`,
`resolveMessages`.

```ts
// middleware.ts
import { localeMiddleware } from "denext/server";

export default [localeMiddleware({ locales: ["en", "fr"], defaultLocale: "en" })];
```

## Automatic hreflang

With `i18n` configured, denext emits a complete per-locale `hreflang` cluster
(plus `x-default`) and a per-locale canonical on every page, in SSR and static
export alike, derived from the locale list — Next.js leaves this to you. A
page's own `alternates.languages` always wins, and `i18n.hreflang: false` opts
out. The [metadata page](/docs/metadata) owns the details.

## next-intl compat

Alias `next-intl` in your import map and an unmodified next-intl app runs:
`next-intl`, `next-intl/server`, `next-intl/navigation`, `next-intl/middleware`
and `next-intl/routing` all resolve to first-party modules (`denext migrate`
writes the aliases for you). The client surface is `NextIntlClientProvider`,
`useTranslations`, `useLocale`, `useMessages`, `useFormatter`, `useNow` and
`useTimeZone`, plus `t.rich()` / `t.markup()` for rich-text and markup
rendering. `createNavigation(routing)` returns a locale-prefixing `Link`,
`usePathname`, `useRouter`, `redirect`/`permanentRedirect` and a reverse-mapping
`getPathname` — including localized `pathnames`, per-locale URL translation.

```jsonc
// deno.json
{ "imports": { "next-intl": "jsr:@denext/denext/next-intl" } }
```

## ICU messages

Messages are formatted by a first-party ICU implementation built on the standard
`Intl.*` APIs — zero npm deps and zero bundled data, no `intl-messageformat`. It
covers plurals with `offset:` and `#`, `selectordinal`, `select`, submessages
nested to any depth, `duration`, `spellout`/`ordinal`, and the `::` skeletons:

- **Number skeletons**, long and concise: `currency/EUR`, `unit/…`,
  `measure-unit/…` with `per-measure-unit/…`, `unit-width-*`, fraction and
  significant digits (`.00##`, `.00+`, `.00/w`, `.##/@@#r`, `@@#`),
  `precision-increment/0.05`, `rounding-mode-*`, `compact-*` / `K` / `KK`,
  `scientific` / `engineering` / `E0`, `sign-*` / `+!` / `()`, `group-*` / `,_`,
  `integer-width/…` / `000`, `scale/N`, `%` / `%x100` and `numbering-system/…`.
  A token `Intl.NumberFormat` has no option for (`decimal-always`) is ignored, as
  next-intl's formatter ignores it.
- **Date skeletons**: every CLDR field `Intl.DateTimeFormat` can express — era,
  year, month, day, weekday, the four hour cycles (`h`/`H`/`K`/`k`), `j`,
  minute, second, fractional seconds (`S`), day periods (`B`) and the time-zone
  name styles (`z`, `v`, `O`, `Z`, `X`). A quarter, week or day-of-year field
  throws, as in next-intl, rather than rendering a date without it.

```text
{count, plural, offset:1 =0 {nobody} one {you and # other} other {you and # others}}
```
