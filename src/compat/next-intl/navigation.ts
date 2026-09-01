/**
 * `next-intl/navigation` compat — locale-aware navigation built on denext's
 * router. `createNavigation(routing)` (and the legacy
 * `createSharedPathnamesNavigation`) return locale-prefixing `Link`,
 * `usePathname`, `useRouter`, `redirect`, and `getPathname`.
 *
 * @module
 */

import { h, Link as DenextLink, redirect as denextRedirect } from "../../../mod.ts";
import { usePathname as denextUsePathname, useRouter as denextUseRouter } from "../../../mod.ts";
import type { VNode } from "../../jsx/types.ts";
import { defineRouting, type ResolvedRouting, type RoutingConfig } from "./routing.ts";
import { useLocale } from "./index.ts";

/**
 * A navigation href: a plain pathname, or (for localized `pathnames` routing) an object
 * naming the internal `pathname` and the `params` to interpolate into its dynamic segments.
 */
export type LocalizedHref =
  | string
  | { pathname: string; params?: Record<string, string | number> };

/** Translate an internal pathname to its localized form for `locale` (identity if none). */
function localize(routing: ResolvedRouting, internal: string, locale: string): string {
  const entry = routing.pathnames?.[internal];
  if (!entry) return internal;
  return typeof entry === "string" ? entry : (entry[locale] ?? internal);
}

/** Reverse-map a localized pathname back to its internal form for `locale` (static paths). */
function internalize(routing: ResolvedRouting, localized: string, locale: string): string {
  if (!routing.pathnames) return localized;
  for (const [internal, entry] of Object.entries(routing.pathnames)) {
    const translated = typeof entry === "string" ? entry : (entry[locale] ?? internal);
    if (translated === localized) return internal;
  }
  return localized;
}

/** Resolve a possibly-object href to a localized pathname, interpolating any params. */
function resolveHref(routing: ResolvedRouting, href: LocalizedHref, locale: string): string {
  if (typeof href === "string") return localize(routing, href, locale);
  let path = localize(routing, href.pathname, locale);
  if (href.params) {
    for (const [key, value] of Object.entries(href.params)) {
      // Replace `[key]` and catch-all `[...key]` with the value.
      path = path.replace(new RegExp(`\\[(?:\\.\\.\\.)?${key}\\]`, "g"), String(value));
    }
  }
  return path;
}

/** Prefix `pathname` with `locale` per the routing prefix mode. */
function withPrefix(routing: ResolvedRouting, locale: string, pathname: string): string {
  if (routing.localePrefixMode === "never") return pathname;
  if (routing.localePrefixMode === "as-needed" && locale === routing.defaultLocale) return pathname;
  const clean = pathname === "/" ? "" : pathname;
  return `/${locale}${clean}`;
}

/** Strip a leading locale segment from `pathname`, if present. */
function stripPrefix(routing: ResolvedRouting, pathname: string): string {
  const seg = pathname.split("/")[1];
  if (routing.locales.includes(seg)) {
    const rest = "/" + pathname.split("/").slice(2).join("/");
    return rest === "/" ? "/" : rest.replace(/\/$/, "");
  }
  return pathname;
}

/** A locale-aware navigation target: a pathname (or localized href) + optional locale. */
export interface NavTarget {
  /** The (unprefixed, internal) href — a string, or `{ pathname, params }` for params. */
  href: LocalizedHref;
  /** An explicit locale (defaults to the active one). */
  locale?: string;
}

/** The navigation API returned by {@link createNavigation}. */
export interface Navigation {
  /** A locale-prefixing `<Link>`. */
  Link: (props: { href: LocalizedHref; locale?: string; [key: string]: unknown }) => VNode;
  /** The current pathname with the locale prefix stripped (and de-localized). */
  usePathname: () => string;
  /** A router whose `push`/`replace` prefix the active locale. */
  useRouter: () => Record<string, unknown>;
  /** Redirect to a locale-prefixed path. */
  redirect: (target: NavTarget | string, locale?: string) => never;
  /** Redirect permanently to a locale-prefixed path. */
  permanentRedirect: (target: NavTarget | string, locale?: string) => never;
  /** Compute the locale-prefixed pathname for a target. */
  getPathname: (target: NavTarget) => string;
}

/**
 * Build locale-aware navigation helpers from a routing config.
 *
 * @param config A routing config or a resolved routing. Optional (next-intl parity): with
 *   no config, the helpers pass hrefs through unprefixed (`localePrefix: "never"`).
 * @returns The {@link Navigation} helpers.
 */
export function createNavigation(config?: RoutingConfig | ResolvedRouting): Navigation {
  const base: RoutingConfig | ResolvedRouting = config ??
    { locales: [], defaultLocale: "", localePrefix: "never" };
  const routing: ResolvedRouting = "localePrefixMode" in base
    ? (base as ResolvedRouting)
    : defineRouting(base);

  function Link(props: { href: LocalizedHref; locale?: string; [key: string]: unknown }): VNode {
    const active = useLocale();
    const locale = props.locale ?? active;
    const href = withPrefix(routing, locale, resolveHref(routing, props.href, locale));
    return h(DenextLink, { ...props, href });
  }

  function usePathname(): string {
    const active = useLocale();
    // Strip the locale prefix, then reverse-translate the localized path to the
    // internal one (so an app reads the same pathname regardless of locale).
    return internalize(routing, stripPrefix(routing, denextUsePathname()), active);
  }

  function useRouter(): Record<string, unknown> {
    const router = denextUseRouter() as unknown as Record<string, unknown>;
    const active = useLocale();
    const push = router.push as (href: string) => void;
    const replace = router.replace as (href: string) => void;
    const target = (href: LocalizedHref, locale: string) =>
      withPrefix(routing, locale, resolveHref(routing, href, locale));
    return {
      ...router,
      push: (href: LocalizedHref, opts?: { locale?: string }) =>
        push(target(href, opts?.locale ?? active)),
      replace: (href: LocalizedHref, opts?: { locale?: string }) =>
        replace(target(href, opts?.locale ?? active)),
    };
  }

  function toPath(target: NavTarget | string, localeArg?: string): string {
    const href: LocalizedHref = typeof target === "string" ? target : target.href;
    const locale = (typeof target === "object" ? target.locale : localeArg) ??
      routing.defaultLocale;
    return withPrefix(routing, locale, resolveHref(routing, href, locale));
  }

  return {
    Link,
    usePathname,
    useRouter,
    getPathname: (target) => {
      const locale = target.locale ?? routing.defaultLocale;
      return withPrefix(routing, locale, resolveHref(routing, target.href, locale));
    },
    redirect: (target, locale) => denextRedirect(toPath(target, locale)) as never,
    permanentRedirect: (target, locale) => denextRedirect(toPath(target, locale)) as never,
  };
}

/** Legacy alias of {@link createNavigation}. */
export const createSharedPathnamesNavigation: typeof createNavigation = createNavigation;
/**
 * Legacy alias of {@link createNavigation}. When the routing config carries a
 * `pathnames` map, navigation translates hrefs to the active locale's paths (and
 * `usePathname` reverse-translates), matching next-intl's localized routing.
 */
export const createLocalizedPathnamesNavigation: typeof createNavigation = createNavigation;
