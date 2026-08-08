// Message-catalog plumbing behind `useTranslations()`.
//
// The active locale's catalog reaches the tree by two paths that must agree:
//   • server render — `render-page` wraps the tree in a `MessagesContext`
//     provider, so server components (and SSR'd client islands) resolve
//     translations during the render;
//   • client hydration — the same catalog is embedded in the `#__denext_data`
//     hydration island, which `useTranslations()` reads (and re-reads on soft
//     navigation between locales).

import { createContext } from "./context.ts";
import type { Context } from "./hooks.ts";
import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../jsx/types.ts";

/** A flat message catalog for one locale: message key → template string. */
export type Messages = Record<string, string>;

/** Values interpolated into a message template's `{name}` placeholders. */
export type TranslationVars = Record<string, string | number>;

/** A translation function: look up `key` and interpolate any `{var}` placeholders. */
export type TranslateFn = (key: string, vars?: TranslationVars) => string;

/**
 * Internal context carrying the active locale's {@link Messages} to
 * {@linkcode useTranslations} during server rendering. Provided around the page
 * tree by the server renderer; empty by default.
 */
export const MessagesContext: Context<Messages> = createContext<Messages>({});

/**
 * Wrap `child` in a {@link MessagesContext} provider so descendants resolve
 * `useTranslations()` against `messages` during server rendering.
 *
 * @param messages The active locale's catalog.
 * @param child The subtree to wrap.
 * @returns The provider VNode.
 */
export function provideMessages(messages: Messages, child: VNodeChild): VNode {
  return h(MessagesContext, { value: messages, children: child });
}

/**
 * Substitute `{name}` placeholders in `template` with `vars.name`. Unmatched
 * placeholders are left intact (so a missing var is visible, not silently blank).
 *
 * @param template The message template, e.g. `"Hello, {name}!"`.
 * @param vars The interpolation values, if any.
 * @returns The interpolated string.
 */
export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (whole, name: string) => (name in vars ? String(vars[name]) : whole),
  );
}

/** Build a {@link TranslateFn} over `messages` (missing keys return the key). */
export function makeTranslate(messages: Messages): TranslateFn {
  return (key, vars) => interpolate(messages[key] ?? key, vars);
}
