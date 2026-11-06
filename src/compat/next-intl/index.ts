/**
 * `next-intl` compat — client hooks and provider, built on denext's context and
 * an `Intl.*`-based ICU formatter (no `intl-messageformat` npm dep).
 *
 * Alias `next-intl` to this module in your import map:
 *
 * ```jsonc
 * "imports": { "next-intl": "jsr:@denext/denext/next-intl" }
 * ```
 *
 * Provides `NextIntlClientProvider`, `useTranslations`, `useLocale`,
 * `useMessages`, `useFormatter`, `useNow`, and `useTimeZone`.
 *
 * @module
 */

import { h, useContext, useMemo } from "../../../mod.ts";
import type { VNode, VNodeChild } from "../../jsx/types.ts";
import { CLIENT_REF } from "../../runtime/client-reference.ts";
import {
  type IntlConfig,
  IntlContext,
  type IntlFormats,
  makeTranslator,
  type NestedMessages,
  type Translator,
} from "./context.ts";

export { formatIcu } from "./icu.ts";
export type { IcuValue, IcuValues } from "./icu.ts";
export type { IntlConfig, NestedMessages, Translator } from "./context.ts";

/**
 * next-intl's `IntlErrorCode` — the categories an {@link IntlError} can carry (missing
 * message/format, environment fallback, formatting error, …).
 */
export enum IntlErrorCode {
  MISSING_MESSAGE = "MISSING_MESSAGE",
  MISSING_FORMAT = "MISSING_FORMAT",
  ENVIRONMENT_FALLBACK = "ENVIRONMENT_FALLBACK",
  INSUFFICIENT_PATH = "INSUFFICIENT_PATH",
  INVALID_MESSAGE = "INVALID_MESSAGE",
  INVALID_KEY = "INVALID_KEY",
  FORMATTING_ERROR = "FORMATTING_ERROR",
}

/** next-intl's `IntlError` — an error carrying an {@link IntlErrorCode} and the original message. */
export class IntlError extends Error {
  /** The category of failure. */
  readonly code: IntlErrorCode;
  /** The underlying message, when one was available. */
  readonly originalMessage?: string;
  /** Create an error of category `code`, optionally carrying the `originalMessage`. */
  constructor(code: IntlErrorCode, originalMessage?: string) {
    super(originalMessage ? `${code}: ${originalMessage}` : code);
    this.name = "IntlError";
    this.code = code;
    this.originalMessage = originalMessage;
  }
}

/**
 * next-intl's `hasLocale` — a type guard: whether `locale` is one of `locales`.
 *
 * @param locales The supported locales.
 * @param locale The candidate locale.
 * @returns Whether `locale` is in `locales`.
 */
export function hasLocale<T extends readonly string[]>(
  locales: T,
  locale: unknown,
): locale is T[number] {
  return typeof locale === "string" && locales.includes(locale);
}

/**
 * next-intl's `initializeConfig` — normalize a config object, filling defaults
 * (`messages` → `{}`). Returned as-is otherwise; denext reads locale/messages/timeZone/now.
 *
 * @param config The raw config.
 * @returns The config with defaults applied.
 */
export function initializeConfig(
  config: Omit<IntlConfig, "messages"> & { messages?: NestedMessages },
): IntlConfig {
  return { ...config, messages: config.messages ?? {} };
}

/**
 * next-intl's `createTranslator` — build a {@link Translator} outside React (e.g. in a
 * Server Action or a `generateMetadata`), from an explicit config.
 *
 * @param config `{ locale, messages, namespace? }`.
 * @returns A translator: `t(key, values)` (+ `.raw`/`.has`).
 */
export function createTranslator(
  config: { locale: string; messages?: NestedMessages; namespace?: string },
): Translator {
  return makeTranslator(config.namespace, config.messages ?? {}, config.locale);
}

/**
 * next-intl's `createFormatter` — build a {@link Formatter} outside React, from an
 * explicit config.
 *
 * @param config `{ locale, timeZone?, now? }`.
 * @returns The {@link Formatter}.
 */
export function createFormatter(
  config: { locale: string; timeZone?: string; now?: Date; formats?: IntlFormats },
): Formatter {
  const { locale, timeZone, now, formats } = config;
  // A string names an entry of the provider's `formats`; an unknown name is an error (as in
  // next-intl) rather than a silent default.
  const named = <O>(kind: keyof IntlFormats, o: O | string | undefined): O | undefined => {
    if (typeof o !== "string") return o;
    const hit = (formats?.[kind] as Record<string, O> | undefined)?.[o];
    if (!hit) throw new Error(`next-intl: no \`formats.${kind}.${o}\` format is configured`);
    return hit;
  };
  return {
    dateTime(date, options) {
      const o = named<Intl.DateTimeFormatOptions>("dateTime", options);
      return new Intl.DateTimeFormat(locale, { timeZone, ...o }).format(date);
    },
    number(value, options) {
      return new Intl.NumberFormat(locale, named<Intl.NumberFormatOptions>("number", options))
        .format(value);
    },
    relativeTime(date, nowArg) {
      const from = new Date(nowArg ?? now ?? new Date()).getTime();
      const to = new Date(date).getTime();
      return formatRelative(locale, to - from);
    },
    list(items, options) {
      return new Intl.ListFormat(locale, named<Intl.ListFormatOptions>("list", options))
        .format(items);
    },
  };
}

/** Read the active intl config, throwing a clear error if the provider is absent. */
function useIntl(): IntlConfig {
  const config = useContext(IntlContext);
  if (!config) {
    throw new Error(
      "next-intl: no <NextIntlClientProvider> found. Wrap your app (or use the " +
        "server APIs from next-intl/server).",
    );
  }
  return config;
}

/** The catalog of a provider given no `messages` (one object, so the value stays stable). */
const EMPTY_MESSAGES: NestedMessages = {};

/** Props for {@link NextIntlClientProvider}. */
export interface NextIntlClientProviderProps {
  /** The active locale. */
  locale: string;
  /** The nested message catalog for this locale. */
  messages?: NestedMessages;
  /** IANA time zone. */
  timeZone?: string;
  /** "Now" reference for relative-time formatting. */
  now?: Date;
  /** Named formats (`formats.dateTime.short`, …) for `useFormatter`. */
  formats?: IntlFormats;
  /**
   * next-intl's error handler. Accepted for parity; a function cannot cross from a Server
   * Component to the client, so a server-rendered provider drops it there (a dev warning says
   * so, as next-intl documents). denext's compat does not call it.
   */
  onError?: (error: IntlError) => void;
  /**
   * next-intl's missing-message fallback. Accepted for parity and dropped on the client like
   * {@link NextIntlClientProviderProps.onError}; denext's compat does not call it.
   */
  getMessageFallback?: (info: { error: IntlError; key: string; namespace?: string }) => string;
  /** The subtree that consumes translations. */
  children?: VNodeChild;
}

/** The provider's context value, one object while its inputs are unchanged. */
function useProviderValue(props: NextIntlClientProviderProps): IntlConfig {
  const { locale, messages, timeZone, now, formats } = props;
  // One value while the inputs are unchanged (as next-intl memoizes it): a fresh object per
  // render re-rendered every consumer and rebuilt every translator below the provider.
  return useMemo<IntlConfig>(
    () => ({ locale, messages: messages ?? EMPTY_MESSAGES, timeZone, now, formats }),
    [locale, messages, timeZone, now?.getTime(), formats],
  );
}

/** The client-reference id the boundary is emitted under (and the Flight entry registers). */
const PROVIDER_REF_ID = "denext#NextIntlClientProvider";

/**
 * The client half of {@link NextIntlClientProvider}: the framework client reference
 * `denext#NextIntlClientProvider`, so `"use client"` islands below a provider rendered from a
 * Server Component read its context after hydration (its props — locale, messages, time zone,
 * now, formats — cross in the Flight payload; functions are dropped). Registered by the
 * generated Flight entry; not something to render by hand.
 *
 * @param props The provider configuration.
 * @returns The provider element.
 */
export function NextIntlClientBoundary(props: NextIntlClientProviderProps): VNode {
  return h(IntlContext, { value: useProviderValue(props), children: props.children });
}
Object.defineProperty(NextIntlClientBoundary, "displayName", { value: "NextIntlClientProvider" });
Object.defineProperty(NextIntlClientBoundary, CLIENT_REF, {
  value: {
    clientId: "denext",
    name: "NextIntlClientProvider",
    id: PROVIDER_REF_ID,
    // It renders no DOM of its own: an island carved beneath it hydrates wrapped in it.
    islandProvider: true,
  },
  enumerable: false,
  configurable: true,
});

/**
 * Provide locale, messages, time zone, and "now" to descendant hooks — Server Components and
 * `"use client"` islands alike. On the server it provides the context to the Server Components
 * below it (they read it during the Flight pass) and renders {@link NextIntlClientBoundary}, the
 * client reference that provides the same context in the browser.
 *
 * @param props The provider configuration.
 * @returns The provider element.
 */
export function NextIntlClientProvider(props: NextIntlClientProviderProps): VNode {
  return h(IntlContext, {
    value: useProviderValue(props),
    children: h(NextIntlClientBoundary, { ...props }),
  });
}

/**
 * next-intl's `IntlProvider` — the underlying provider that {@link NextIntlClientProvider}
 * wraps. denext's provider is client/server-agnostic, so this is the same component.
 */
export const IntlProvider: typeof NextIntlClientProvider = NextIntlClientProvider;

/**
 * Access translations for an optional `namespace`.
 *
 * @param namespace The key prefix (or omit for the root).
 * @returns A translator: `t(key, values)` (+ `.raw`/`.has`).
 */
export function useTranslations(namespace?: string): Translator {
  const { messages, locale } = useIntl();
  // Referentially stable while the namespace, catalog and locale are, as in next-intl: a
  // translator in a `useCallback` / `useEffect` dependency list must not change every render.
  return useMemo(() => makeTranslator(namespace, messages, locale), [namespace, messages, locale]);
}

/** The active locale. */
export function useLocale(): string {
  return useIntl().locale;
}

/** The active nested message catalog. */
export function useMessages(): NestedMessages {
  return useIntl().messages;
}

/** The active IANA time zone (or `undefined`). */
export function useTimeZone(): string | undefined {
  return useIntl().timeZone;
}

/**
 * The "now" reference (provider-supplied, else the current time).
 *
 * @param options next-intl's `{ updateInterval? }`. denext returns a stable "now" (the
 *   provider's, or the current time); the interval is accepted for parity and unused.
 */
export function useNow(_options?: { updateInterval?: number }): Date {
  const { now } = useIntl();
  return now ?? new Date();
}

/** The formatter surface returned by {@link useFormatter}. */
export interface Formatter {
  /** Format a date/time (options, or the name of a `formats.dateTime` entry). */
  dateTime(date: Date | number, options?: Intl.DateTimeFormatOptions | string): string;
  /** Format a number (options, or the name of a `formats.number` entry). */
  number(value: number, options?: Intl.NumberFormatOptions | string): string;
  /** Format a relative time between `date` and `now` (or the provider "now"). */
  relativeTime(date: Date | number, now?: Date | number): string;
  /** Format a list of strings (options, or the name of a `formats.list` entry). */
  list(items: Iterable<string>, options?: Intl.ListFormatOptions | string): string;
}

/**
 * A locale/timeZone-bound set of `Intl.*` formatters (dateTime, number,
 * relativeTime, list), matching next-intl's `useFormatter`.
 *
 * @returns The {@link Formatter}.
 */
export function useFormatter(): Formatter {
  const { locale, timeZone, now, formats } = useIntl();
  // Stable while its inputs are, like useTranslations.
  return useMemo(
    () => createFormatter({ locale, timeZone, now, formats }),
    [locale, timeZone, now, formats],
  );
}

/** Pick a sensible unit for a millisecond delta and format it relatively. */
function formatRelative(locale: string, deltaMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(deltaMs);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000000],
    ["month", 2592000000],
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
    ["second", 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "second") {
      return rtf.format(Math.round(deltaMs / ms), unit);
    }
  }
  return rtf.format(0, "second");
}
