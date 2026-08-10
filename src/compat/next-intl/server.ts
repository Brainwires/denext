/**
 * `next-intl/server` compat — server-side i18n APIs (`getTranslations`,
 * `getLocale`, `getMessages`, `getFormatter`, `getRequestConfig`,
 * `setRequestLocale`).
 *
 * Register a request-config loader with `getRequestConfig` (as in
 * `i18n/request.ts`); the server getters call it to resolve messages/locale for
 * the active request. `setRequestLocale(locale)` records the active locale.
 *
 * @module
 */

import {
  type IntlConfig,
  makeTranslator,
  type NestedMessages,
  type Translator,
} from "./context.ts";
import { currentContext, type RequestContext } from "../../server/request-context.ts";

/** Params passed to a request-config loader. */
export interface RequestConfigParams {
  /** The locale, when statically known. */
  locale?: string;
  /** A promise of the locale (next-intl ≥3.22 shape). */
  requestLocale: Promise<string | undefined>;
}

/** What a request-config loader returns. */
export interface RequestConfig {
  /** The active locale (required by next-intl). */
  locale: string;
  /** The nested message catalog. */
  messages?: NestedMessages;
  /** IANA time zone. */
  timeZone?: string;
  /** "Now" reference. */
  now?: Date;
}

/** A request-config loader (the default export of `i18n/request.ts`). */
export type RequestConfigLoader = (
  params: RequestConfigParams,
) => RequestConfig | Promise<RequestConfig>;

let loader: RequestConfigLoader | null = null;
// Per-request locale, isolated via the request's AsyncLocalStorage context so
// concurrent SSR for different locales can't cross-contaminate. Falls back to a
// module-level value only when called outside a request (tests, static gen).
const localeByRequest = new WeakMap<RequestContext, string>();
let fallbackLocale: string | null = null;

/** Read the active locale for the current request (or the module fallback). */
function activeLocale(): string | null {
  const ctx = currentContext();
  if (ctx && localeByRequest.has(ctx)) return localeByRequest.get(ctx)!;
  return fallbackLocale;
}

/**
 * Register the request-config loader (the default export of `i18n/request.ts`).
 * Returns the loader unchanged, matching next-intl.
 *
 * @param fn The loader.
 * @returns `fn`.
 */
export function getRequestConfig(fn: RequestConfigLoader): RequestConfigLoader {
  loader = fn;
  return fn;
}

/**
 * Record the active locale for the current request (call at the top of a
 * server component / route). Also exported as `unstable_setRequestLocale`.
 *
 * @param locale The active locale.
 */
export function setRequestLocale(locale: string): void {
  const ctx = currentContext();
  if (ctx) localeByRequest.set(ctx, locale);
  else fallbackLocale = locale;
}
export { setRequestLocale as unstable_setRequestLocale };

/** Resolve the effective config for `locale` via the registered loader. */
async function resolve(locale: string | undefined): Promise<IntlConfig> {
  const active = locale ?? activeLocale() ?? "en";
  if (!loader) return { locale: active, messages: {} };
  const config = await loader({ locale: active, requestLocale: Promise.resolve(active) });
  return {
    locale: config.locale ?? active,
    messages: config.messages ?? {},
    timeZone: config.timeZone,
    now: config.now,
  };
}

/** The active locale (from `setRequestLocale`, else the loader, else `"en"`). */
export async function getLocale(): Promise<string> {
  const active = activeLocale();
  if (active) return active;
  return (await resolve(undefined)).locale;
}

/** The active nested message catalog. */
export async function getMessages(opts?: { locale?: string }): Promise<NestedMessages> {
  return (await resolve(opts?.locale)).messages;
}

/** The active IANA time zone, if configured. */
export async function getTimeZone(opts?: { locale?: string }): Promise<string | undefined> {
  return (await resolve(opts?.locale)).timeZone;
}

/** The "now" reference for the request. */
export async function getNow(opts?: { locale?: string }): Promise<Date> {
  return (await resolve(opts?.locale)).now ?? new Date();
}

/**
 * Server translator for an optional namespace.
 *
 * @param arg A namespace string, or `{ locale?, namespace? }`.
 * @returns A translator bound to the resolved locale/messages.
 */
export async function getTranslations(
  arg?: string | { locale?: string; namespace?: string },
): Promise<Translator> {
  const namespace = typeof arg === "string" ? arg : arg?.namespace;
  const locale = typeof arg === "object" ? arg?.locale : undefined;
  const config = await resolve(locale);
  return makeTranslator(namespace, config.messages, config.locale);
}

/** A server-side formatter (subset of the client `useFormatter` surface). */
export interface ServerFormatter {
  /** Format a date/time. */
  dateTime(date: Date | number, options?: Intl.DateTimeFormatOptions): string;
  /** Format a number. */
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** Format a list of strings. */
  list(items: Iterable<string>, options?: Intl.ListFormatOptions): string;
}

/**
 * A locale-bound server formatter.
 *
 * @param opts Optional explicit locale.
 * @returns The {@link ServerFormatter}.
 */
export async function getFormatter(opts?: { locale?: string }): Promise<ServerFormatter> {
  const { locale, timeZone } = await resolve(opts?.locale);
  return {
    dateTime: (date, options) =>
      new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(date),
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    list: (items, options) => new Intl.ListFormat(locale, options).format(items),
  };
}
