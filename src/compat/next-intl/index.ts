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

import { h, useContext } from "../../../mod.ts";
import type { VNode, VNodeChild } from "../../jsx/types.ts";
import {
  type IntlConfig,
  IntlContext,
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
  config: { locale: string; timeZone?: string; now?: Date },
): Formatter {
  const { locale, timeZone, now } = config;
  return {
    dateTime(date, options) {
      return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(date);
    },
    number(value, options) {
      return new Intl.NumberFormat(locale, options).format(value);
    },
    relativeTime(date, nowArg) {
      const from = new Date(nowArg ?? now ?? new Date()).getTime();
      const to = new Date(date).getTime();
      return formatRelative(locale, to - from);
    },
    list(items, options) {
      return new Intl.ListFormat(locale, options).format(items);
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
  /** The subtree that consumes translations. */
  children?: VNodeChild;
}

/**
 * Provide locale, messages, time zone, and "now" to descendant hooks.
 *
 * @param props The provider configuration.
 * @returns The provider element.
 */
export function NextIntlClientProvider(props: NextIntlClientProviderProps): VNode {
  const value: IntlConfig = {
    locale: props.locale,
    messages: props.messages ?? {},
    timeZone: props.timeZone,
    now: props.now,
  };
  return h(IntlContext, { value, children: props.children });
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
  return makeTranslator(namespace, messages, locale);
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
  /** Format a date/time. */
  dateTime(date: Date | number, options?: Intl.DateTimeFormatOptions): string;
  /** Format a number. */
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** Format a relative time between `date` and `now` (or the provider "now"). */
  relativeTime(date: Date | number, now?: Date | number): string;
  /** Format a list of strings. */
  list(items: Iterable<string>, options?: Intl.ListFormatOptions): string;
}

/**
 * A locale/timeZone-bound set of `Intl.*` formatters (dateTime, number,
 * relativeTime, list), matching next-intl's `useFormatter`.
 *
 * @returns The {@link Formatter}.
 */
export function useFormatter(): Formatter {
  const { locale, timeZone, now } = useIntl();
  return createFormatter({ locale, timeZone, now });
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
