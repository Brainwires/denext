/**
 * The `desktop.menu` block of denext.config: the standard window items the backend adds to the
 * application menu (`desktop.menu.window`: New Window, Reopen Closed Window, the open windows),
 * as the validator and `runDesktop` read it. The behaviour is {@link ./window-menu.ts}.
 *
 * Client-safe: no Deno APIs.
 *
 * @module
 */

import { isAppPath } from "./tray-config.ts";

/** The standard window items (`desktop.menu.window`), resolved. */
export interface DesktopWindowMenuSettings {
  /** The app path New Window (Cmd/Ctrl+N) opens; `false` or unset: no item. */
  readonly newWindow?: string | false;
  /** Reopen Closed Window (Cmd/Ctrl+Shift+T) over the recently closed keyed windows. */
  readonly reopenClosed?: boolean;
  /** List the open windows, each focusing its window when chosen. */
  readonly list?: boolean;
}

/** `desktop.menu`, resolved. */
export interface DesktopMenuSettings {
  /** The standard window items. */
  readonly window?: DesktopWindowMenuSettings;
}

/**
 * Why `menu` is not a `desktop.menu`, as `[key, problem]` (the key under `desktop.`), or `null`.
 *
 * @param menu The configured value.
 * @returns The problem, or `null`.
 */
export function desktopMenuProblem(menu: unknown): [string, string] | null {
  if (menu === undefined) return null;
  if (typeof menu !== "object" || menu === null || Array.isArray(menu)) {
    return ["menu", "must be an object"];
  }
  const w = (menu as { window?: unknown }).window;
  if (w === undefined) return null;
  if (typeof w !== "object" || w === null || Array.isArray(w)) {
    return ["menu.window", "must be an object"];
  }
  const o = w as Record<string, unknown>;
  if (o.newWindow !== undefined && o.newWindow !== false && !isAppPath(o.newWindow)) {
    return ["menu.window.newWindow", 'must be a path of the app, like "/", or false'];
  }
  for (const key of ["reopenClosed", "list"]) {
    if (o[key] !== undefined && typeof o[key] !== "boolean") {
      return [`menu.window.${key}`, "must be a boolean"];
    }
  }
  return null;
}

/**
 * `desktop.menu` as `runDesktop` applies it, or `undefined` when unset. Throws for an invalid one
 * (the validator reports the same problem at config load).
 *
 * @param desktop The `desktop` block of the config.
 * @returns The settings.
 */
export function resolveDesktopMenuSettings(desktop: unknown): DesktopMenuSettings | undefined {
  const menu = (desktop as { menu?: unknown } | null | undefined)?.menu;
  if (menu === undefined) return undefined;
  const problem = desktopMenuProblem(menu);
  if (problem) throw new Error(`desktop: invalid desktop.${problem[0]}: ${problem[1]}`);
  const w = (menu as { window?: Record<string, unknown> }).window;
  if (w === undefined) return {};
  return {
    window: {
      ...(w.newWindow !== undefined ? { newWindow: w.newWindow as string | false } : {}),
      ...(w.reopenClosed !== undefined ? { reopenClosed: w.reopenClosed as boolean } : {}),
      ...(w.list !== undefined ? { list: w.list as boolean } : {}),
    },
  };
}
