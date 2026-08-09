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

/** A locale-aware navigation target: a pathname + optional explicit locale. */
export interface NavTarget {
  /** The (unprefixed) href. */
  href: string;
  /** An explicit locale (defaults to the active one). */
  locale?: string;
}

/** The navigation API returned by {@link createNavigation}. */
export interface Navigation {
  /** A locale-prefixing `<Link>`. */
  Link: (props: { href: string; locale?: string; [key: string]: unknown }) => VNode;
  /** The current pathname with the locale prefix stripped. */
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
 * @param config A routing config or a resolved routing.
 * @returns The {@link Navigation} helpers.
 */
export function createNavigation(config: RoutingConfig | ResolvedRouting): Navigation {
  const routing: ResolvedRouting = "localePrefixMode" in config ? config : defineRouting(config);

  function Link(props: { href: string; locale?: string; [key: string]: unknown }): VNode {
    const active = useLocale();
    const locale = props.locale ?? active;
    return h(DenextLink, { ...props, href: withPrefix(routing, locale, props.href) });
  }

  function usePathname(): string {
    return stripPrefix(routing, denextUsePathname());
  }

  function useRouter(): Record<string, unknown> {
    const router = denextUseRouter() as unknown as Record<string, unknown>;
    const active = useLocale();
    const push = router.push as (href: string) => void;
    const replace = router.replace as (href: string) => void;
    return {
      ...router,
      push: (href: string, opts?: { locale?: string }) =>
        push(withPrefix(routing, opts?.locale ?? active, href)),
      replace: (href: string, opts?: { locale?: string }) =>
        replace(withPrefix(routing, opts?.locale ?? active, href)),
    };
  }

  function toPath(target: NavTarget | string, localeArg?: string): string {
    const href = typeof target === "string" ? target : target.href;
    const locale = (typeof target === "object" ? target.locale : localeArg) ??
      routing.defaultLocale;
    return withPrefix(routing, locale, href);
  }

  return {
    Link,
    usePathname,
    useRouter,
    getPathname: (target) =>
      withPrefix(routing, target.locale ?? routing.defaultLocale, target.href),
    redirect: (target, locale) => denextRedirect(toPath(target, locale)) as never,
    permanentRedirect: (target, locale) => denextRedirect(toPath(target, locale)) as never,
  };
}

/** Legacy alias of {@link createNavigation}. */
export const createSharedPathnamesNavigation: typeof createNavigation = createNavigation;
/** Legacy alias of {@link createNavigation} (pathnames map is ignored). */
export const createLocalizedPathnamesNavigation: typeof createNavigation = createNavigation;
