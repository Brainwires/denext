/**
 * `expo-localization` for denext: the user's locales and calendar from the platform's `Intl`
 * and `navigator.languages`, which in the Capacitor shell's WebView follow the device's
 * language and region settings. Synchronous, as Expo's.
 *
 * Beyond Expo's web build: `measurementSystem` is derived from the region (`us` for the US,
 * Liberia and Myanmar, `uk` for the United Kingdom, else `metric`, the OS default for each),
 * and `textDirection` falls back to the language's script direction. The currency fields are
 * null, as on Expo's web build (no web API reports the region's currency). The hooks re-render
 * on the page's `languagechange` event.
 *
 * @example
 * ```ts
 * import { getCalendars, getLocales } from "denext/expo/localization";
 *
 * const [{ languageCode, regionCode }] = getLocales();
 * const [{ timeZone, uses24hourClock }] = getCalendars();
 * ```
 *
 * @module
 */

import { useEffect, useMemo, useReducer } from "../runtime/hooks.ts";

/** One of the user's locales. */
export interface Locale {
  /** The BCP 47 language tag (`"en-US"`). */
  languageTag: string;
  /** The language without the region (`"en"`). */
  languageCode: string | null;
  /** The ISO 15924 script (`"Latn"`), when the tag names one. */
  languageScriptCode: string | null;
  /** The region (`"US"`), from the tag. */
  regionCode: string | null;
  /** The region of the preferred language: the same as `regionCode` here. */
  languageRegionCode: string | null;
  /** The region's currency (null: no web API reports it). */
  currencyCode: string | null;
  /** The currency's symbol (null with `currencyCode`). */
  currencySymbol: string | null;
  /** The language's currency (null). */
  languageCurrencyCode: string | null;
  /** The language currency's symbol (null). */
  languageCurrencySymbol: string | null;
  /** The decimal separator (`"."`). */
  decimalSeparator: string | null;
  /** The digit grouping separator (`","`). */
  digitGroupingSeparator: string | null;
  /** The text direction. */
  textDirection: "ltr" | "rtl";
  /** The region's measurement system, or null without a region. */
  measurementSystem: "metric" | "us" | "uk" | null;
  /** The region's temperature unit, or null without a region. */
  temperatureUnit: "celsius" | "fahrenheit" | null;
}

/** Days of the week as `firstWeekday` numbers them (Sunday = 1). */
export enum Weekday {
  SUNDAY = 1,
  MONDAY = 2,
  TUESDAY = 3,
  WEDNESDAY = 4,
  THURSDAY = 5,
  FRIDAY = 6,
  SATURDAY = 7,
}

/** The Unicode calendar types. */
export enum CalendarIdentifier {
  /** Thai Buddhist calendar. */
  BUDDHIST = "buddhist",
  /** Traditional Chinese calendar. */
  CHINESE = "chinese",
  /** Coptic calendar. */
  COPTIC = "coptic",
  /** Traditional Korean calendar. */
  DANGI = "dangi",
  /** Ethiopic calendar, Amete Alem. */
  ETHIOAA = "ethioaa",
  /** Ethiopic calendar, Amete Mihret. */
  ETHIOPIC = "ethiopic",
  /** Gregorian calendar. */
  GREGORY = "gregory",
  /** Gregorian calendar (alias). */
  GREGORIAN = "gregory",
  /** Traditional Hebrew calendar. */
  HEBREW = "hebrew",
  /** Indian calendar. */
  INDIAN = "indian",
  /** Islamic calendar. */
  ISLAMIC = "islamic",
  /** Islamic calendar, tabular (civil epoch). */
  ISLAMIC_CIVIL = "islamic-civil",
  /** Islamic calendar, Saudi Arabia sighting. */
  ISLAMIC_RGSA = "islamic-rgsa",
  /** Islamic calendar, tabular (astronomical epoch). */
  ISLAMIC_TBLA = "islamic-tbla",
  /** Islamic calendar, Umm al-Qura. */
  ISLAMIC_UMALQURA = "islamic-umalqura",
  /** ISO 8601 calendar. */
  ISO8601 = "iso8601",
  /** Japanese imperial calendar. */
  JAPANESE = "japanese",
  /** Persian calendar. */
  PERSIAN = "persian",
  /** Republic of China calendar. */
  ROC = "roc",
}

/** The user's calendar preferences. */
export interface Calendar {
  /** The calendar type, or null when the platform does not say. */
  calendar: CalendarIdentifier | null;
  /** Whether times use a 24-hour clock, or null when the platform does not say. */
  uses24hourClock: boolean | null;
  /** The first day of the week (Sunday = 1), or null when the platform does not say. */
  firstWeekday: Weekday | null;
  /** The time zone (`"Europe/Warsaw"`), or null. */
  timeZone: string | null;
}

/** Regions whose OS default is Fahrenheit. */
const FAHRENHEIT = new Set([
  "AG",
  "BS",
  "BZ",
  "FM",
  "KN",
  "KY",
  "LR",
  "MH",
  "MS",
  "PW",
  "TC",
  "US",
  "VG",
]);

/** Languages written right to left. */
const RTL = new Set([
  "ar",
  "arc",
  "ckb",
  "dv",
  "fa",
  "ha",
  "he",
  "khw",
  "ks",
  "ps",
  "sd",
  "ur",
  "yi",
]);

/** The user's language tags, most preferred first (at least one). */
function languageTags(): string[] {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } })
    .navigator;
  const tags = nav?.languages?.length ? [...nav.languages] : nav?.language ? [nav.language] : [];
  if (tags.length > 0) return tags;
  try {
    return [new Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return ["en-US"];
  }
}

/** What `Intl.Locale` says of a tag, where the runtime has it. */
interface LocaleParts {
  language?: string;
  script?: string;
  region?: string;
  getTextInfo?: () => { direction?: string };
  textInfo?: { direction?: string };
  getWeekInfo?: () => { firstDay?: number };
  weekInfo?: { firstDay?: number };
}

/** `Intl.Locale` for `tag`, or an empty object when it cannot be parsed. */
function localeParts(tag: string): LocaleParts {
  try {
    return new Intl.Locale(tag) as unknown as LocaleParts;
  } catch {
    return {};
  }
}

/** The separators `tag` formats numbers with. */
function separators(tag: string): { decimal: string | null; grouping: string | null } {
  try {
    const parts = new Intl.NumberFormat(tag).formatToParts(10000.5);
    return {
      decimal: parts.find((p) => p.type === "decimal")?.value ?? null,
      grouping: parts.find((p) => p.type === "group")?.value ?? null,
    };
  } catch {
    return { decimal: null, grouping: null };
  }
}

/** The OS default measurement system of a region. */
function measurementSystem(region: string): "metric" | "us" | "uk" {
  if (region === "US" || region === "LR" || region === "MM") return "us";
  return region === "GB" ? "uk" : "metric";
}

/** One locale for `tag`. */
function toLocale(tag: string): Locale {
  const parts = localeParts(tag);
  const language = parts.language || tag.split("-")[0] || "en";
  const region = parts.region ?? null;
  const direction = parts.getTextInfo?.()?.direction ?? parts.textInfo?.direction;
  const { decimal, grouping } = separators(tag);
  return {
    languageTag: tag,
    languageCode: language,
    languageScriptCode: parts.script ?? null,
    regionCode: region,
    languageRegionCode: region,
    currencyCode: null,
    currencySymbol: null,
    languageCurrencyCode: null,
    languageCurrencySymbol: null,
    decimalSeparator: decimal,
    digitGroupingSeparator: grouping,
    textDirection: direction === "rtl" || (!direction && RTL.has(language)) ? "rtl" : "ltr",
    measurementSystem: region ? measurementSystem(region) : null,
    temperatureUnit: region ? (FAHRENHEIT.has(region) ? "fahrenheit" : "celsius") : null,
  };
}

/**
 * The user's locales, most preferred first; always at least one.
 *
 * @returns The locales.
 */
export function getLocales(): [Locale, ...Locale[]] {
  return languageTags().map(toLocale) as [Locale, ...Locale[]];
}

/** `Intl.DateTimeFormat`'s resolved options with the fields read here. */
interface ResolvedDateOptions {
  locale?: string;
  calendar?: string;
  timeZone?: string;
  hourCycle?: string;
}

/**
 * The user's calendar preferences (one entry).
 *
 * @returns The calendars.
 */
export function getCalendars(): [Calendar, ...Calendar[]] {
  let options: ResolvedDateOptions = {};
  let hourCycle: string | undefined;
  try {
    options = new Intl.DateTimeFormat().resolvedOptions() as ResolvedDateOptions;
    hourCycle = (new Intl.DateTimeFormat(undefined, { hour: "numeric" })
      .resolvedOptions() as ResolvedDateOptions).hourCycle;
  } catch { /* no Intl: every field is null */ }
  const parts = localeParts(options.locale ?? languageTags()[0]);
  const firstDay = parts.getWeekInfo?.()?.firstDay ?? parts.weekInfo?.firstDay;
  return [{
    calendar: (options.calendar as CalendarIdentifier | undefined) ?? null,
    timeZone: options.timeZone ?? null,
    uses24hourClock: hourCycle ? hourCycle === "h23" || hourCycle === "h24" : null,
    // Intl numbers the ISO way (Monday = 1 … Sunday = 7); Expo's are Sunday = 1.
    firstWeekday: typeof firstDay === "number" ? (firstDay % 7) + 1 as Weekday : null,
  }];
}

/** Re-render on the page's `languagechange` event. */
function useLanguageChange(): number {
  const [key, bump] = useReducer((n: number, _action: void) => n + 1, 0);
  useEffect(() => {
    const target = globalThis as {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
    if (typeof target.addEventListener !== "function") return;
    const listener = () => bump();
    target.addEventListener("languagechange", listener);
    return () => target.removeEventListener?.("languagechange", listener);
  }, []);
  return key;
}

/**
 * Hook form of {@linkcode getLocales}: re-renders when the user's languages change.
 *
 * @returns The locales.
 */
export function useLocales(): [Locale, ...Locale[]] {
  const key = useLanguageChange();
  return useMemo(() => getLocales(), [key]);
}

/**
 * Hook form of {@linkcode getCalendars}: re-renders when the user's languages change.
 *
 * @returns The calendars.
 */
export function useCalendars(): [Calendar, ...Calendar[]] {
  const key = useLanguageChange();
  return useMemo(() => getCalendars(), [key]);
}
