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

/** The "now" reference (provider-supplied, else the current time). */
export function useNow(): Date {
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
