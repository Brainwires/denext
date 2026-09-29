/**
 * React Native's `I18nManager` for React Native mode: right-to-left layout read from the page
 * (the root element's `dir`, else the locale) and switched live through `dir` on the root
 * element, with no restart. react-native-web ships it as a mock (`isRTL` always `false`).
 *
 * @module
 */

/** What `I18nManager.getConstants()` returns. */
export interface I18nManagerConstants {
  readonly isRTL: boolean;
  readonly doLeftAndRightSwapInRTL: boolean;
  readonly localeIdentifier?: string | null;
}

/** React Native's `I18nManager` module. */
export interface I18nManagerStatic {
  /** Whether the app lays out right to left. */
  readonly isRTL: boolean;
  /** Whether `left` / `right` styles swap in RTL (recorded; see `swapLeftAndRightInRTL`). */
  readonly doLeftAndRightSwapInRTL: boolean;
  getConstants(): I18nManagerConstants;
  allowRTL(allowRTL: boolean): void;
  forceRTL(forceRTL: boolean): void;
  swapLeftAndRightInRTL(flipStyles: boolean): void;
}

/** The app's choices. */
interface I18nState {
  allow: boolean;
  force: boolean;
  swap: boolean;
  /** The root's `dir` before `forceRTL` / `allowRTL` first wrote it (restored when unforced). */
  ownDir?: string | null;
  wrote: boolean;
}

let state: I18nState | undefined;

/** Languages written right to left (ISO 639-1 / -3 primary subtags). */
const RTL_LANGUAGES = new Set([
  "ar",
  "arc",
  "ckb",
  "dv",
  "fa",
  "he",
  "iw",
  "khw",
  "ks",
  "ku",
  "ps",
  "sd",
  "syr",
  "ug",
  "ur",
  "yi",
]);

/** RTL scripts that make a locale RTL whatever its language (`az-Arab`, `pa-Arab`). */
const RTL_SCRIPTS = /-(?:arab|hebr|thaa|syrc|nkoo|adlm|rohg)(?:-|$)/i;

/** The choices, created on first use. */
function i18nState(): I18nState {
  return state ??= { allow: true, force: false, swap: true, wrote: false };
}

/** Test hook: forget the app's choices (the root's `dir` is left as it is). */
export function resetI18nManagerForTesting(): void {
  state = undefined;
}

/** The page's locale: the root's `lang`, else the browser's language, else null. */
function localeIdentifier(): string | null {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const lang = root?.getAttribute?.("lang");
  if (lang) return lang;
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language ?? null;
}

/** Whether `locale` is written right to left. */
function isRtlLocale(locale: string | null): boolean {
  if (!locale) return false;
  if (RTL_SCRIPTS.test(locale)) return true;
  return RTL_LANGUAGES.has(locale.split(/[-_]/)[0].toLowerCase());
}

/** A `dir` value as `rtl` / `ltr`, else undefined. */
function direction(dir: string | null | undefined): "rtl" | "ltr" | undefined {
  const value = dir?.toLowerCase();
  return value === "rtl" || value === "ltr" ? value : undefined;
}

/** The root element's `dir` attribute, or null. */
function rootDirAttribute(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement?.getAttribute?.("dir") ?? null;
}

/**
 * Whether the app lays out right to left now: forced, else (while allowed) the page's own
 * `dir` (as it was before the manager first wrote it), else the locale's direction.
 */
function currentRTL(): boolean {
  const s = i18nState();
  if (s.force) return true;
  if (!s.allow) return false;
  const dir = direction(s.wrote ? s.ownDir : rootDirAttribute());
  return dir !== undefined ? dir === "rtl" : isRtlLocale(localeIdentifier());
}

/** Write `dir` on the root element for the current choices (remembering the page's own). */
function syncDir(): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  const s = i18nState();
  if (!s.wrote) {
    s.ownDir = rootDirAttribute();
    s.wrote = true;
  }
  document.documentElement.setAttribute("dir", currentRTL() ? "rtl" : "ltr");
}

/**
 * React Native's `I18nManager`, read from and applied to the page:
 *
 * - `isRTL`: `forceRTL(true)` wins; otherwise the root element's `dir` when the page set one,
 *   else whether the locale (the root's `lang`, else `navigator.language`) is written right to
 *   left, in both cases only while RTL is allowed (the default, as in React Native).
 * - `forceRTL` / `allowRTL` set `dir` on the root element at once, so the layout flips live
 *   (React Native needs an app restart). react-native-web lays out with the browser's `dir`
 *   (flex rows and logical properties follow it).
 * - `swapLeftAndRightInRTL` is recorded and reported; react-native-web no longer swaps
 *   `left` / `right` styles itself, so it changes nothing (use `start` / `end`).
 * - `getConstants().localeIdentifier` is the page's locale.
 *
 * @example
 * ```ts
 * import { I18nManager } from "react-native";
 *
 * I18nManager.forceRTL(true); // the root element gets dir="rtl" now
 * const flip = I18nManager.isRTL ? -1 : 1;
 * ```
 */
export const I18nManager: I18nManagerStatic = {
  get isRTL() {
    return currentRTL();
  },
  get doLeftAndRightSwapInRTL() {
    return i18nState().swap;
  },
  getConstants() {
    return {
      isRTL: currentRTL(),
      doLeftAndRightSwapInRTL: i18nState().swap,
      localeIdentifier: localeIdentifier(),
    };
  },
  allowRTL(allowRTL) {
    i18nState().allow = allowRTL !== false;
    syncDir();
  },
  forceRTL(forceRTL) {
    i18nState().force = forceRTL === true;
    syncDir();
  },
  swapLeftAndRightInRTL(flipStyles) {
    i18nState().swap = flipStyles !== false;
  },
};
