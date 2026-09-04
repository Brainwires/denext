/**
 * Shared context + message resolution for the next-intl compat layer.
 *
 * @module
 */

import { createContext } from "../../../mod.ts";
import type { Context } from "../../runtime/hooks.ts";
import type { VNodeChild } from "../../jsx/types.ts";
import { formatIcu, type IcuValues } from "./icu.ts";
import { formatMarkup, formatRich, type MarkupValues, type RichValues } from "./rich.ts";

/** A nested message catalog: keys map to strings or further nested catalogs. */
export interface NestedMessages {
  /** A message string, or a nested sub-catalog. */
  [key: string]: string | NestedMessages;
}

/** The active i18n configuration visible to hooks/components. */
export interface IntlConfig {
  /** The active BCP-47 locale. */
  locale: string;
  /** The nested message catalog. */
  messages: NestedMessages;
  /** IANA time zone (used by the formatter). */
  timeZone?: string;
  /** "Now" reference for relative-time formatting. */
  now?: Date;
}

/** Internal context carrying the active {@link IntlConfig}. */
export const IntlContext: Context<IntlConfig | null> = createContext<IntlConfig | null>(null);

/** Resolve a dotted `path` within nested `messages`, or `undefined`. */
function resolvePath(messages: NestedMessages, path: string): string | undefined {
  let node: string | NestedMessages | undefined = messages;
  for (const part of path.split(".")) {
    if (node == null || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** The translation function returned by `useTranslations` / `getTranslations`. */
export interface Translator {
  /** Translate `key` (relative to the namespace), formatting ICU with `values`. */
  (key: string, values?: IcuValues): string;
  /** The raw (unformatted) message for `key`. */
  raw(key: string): string | undefined;
  /** Whether a message exists for `key`. */
  has(key: string): boolean;
  /**
   * Translate `key` as rich text: `<tag>…</tag>` markup in the message invokes the matching
   * handler in `values` (e.g. `{ link: (chunks) => <a>{chunks}</a> }`), returning a node.
   */
  rich(key: string, values?: RichValues): VNodeChild;
  /**
   * Translate `key` as markup: like {@link Translator.rich} but tag handlers return strings
   * and the result is a string (for non-React contexts).
   */
  markup(key: string, values?: MarkupValues): string;
}

/**
 * Build a {@link Translator} bound to `namespace` over `messages`/`locale`.
 * Missing keys return `namespace.key` (visible, like next-intl's dev behavior).
 *
 * @param namespace The key prefix (or undefined for the root).
 * @param messages The nested catalog.
 * @param locale The active locale.
 * @returns The translator.
 */
export function makeTranslator(
  namespace: string | undefined,
  messages: NestedMessages,
  locale: string,
): Translator {
  const full = (key: string) => (namespace ? `${namespace}.${key}` : key);
  const t = ((key: string, values?: IcuValues) => {
    const path = full(key);
    const message = resolvePath(messages, path);
    if (message === undefined) return path;
    return formatIcu(message, values, locale);
  }) as Translator;
  t.raw = (key: string) => resolvePath(messages, full(key));
  t.has = (key: string) => resolvePath(messages, full(key)) !== undefined;
  t.rich = (key: string, values?: RichValues) => {
    const message = resolvePath(messages, full(key));
    if (message === undefined) return full(key); // visible fallback, like `t()`
    return formatRich(message, values, locale);
  };
  t.markup = (key: string, values?: MarkupValues) => {
    const message = resolvePath(messages, full(key));
    if (message === undefined) return full(key);
    return formatMarkup(message, values, locale);
  };
  return t;
}
