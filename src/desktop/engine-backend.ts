/**
 * `desktop.backend`: the window engine `deno desktop` builds an app with, `"webview"` (the system
 * WebView: WKWebView, WebView2, WebKitGTK) or `"cef"` (Chromium). One value for every target, or a
 * per-OS object `{ macos?, windows?, linux?, default? }` (the keys `desktop.installers` and
 * `desktop.app.icons` use), so an app can ship CEF on Linux (where WebKitGTK has no WebRTC) and the
 * system WebView elsewhere. An OS the object leaves out takes `default`, else `"webview"`.
 *
 * Pure (a type import only): the config validator, the packaging scripts, `desktop run` / `dev`
 * and both doctors share it.
 *
 * @module
 */

import type { DesktopBackendConfig } from "../server/config.ts";

/** A window engine `deno desktop --backend` takes. */
export type DesktopBackend = "webview" | "cef";

/** A target OS, as `Deno.build.os` names it. */
export type DesktopBackendOs = "darwin" | "windows" | "linux";

/** The engine of an OS nothing configures. */
export const DEFAULT_DESKTOP_BACKEND: DesktopBackend = "webview";

/** The per-OS keys, in the order messages list them. */
const OS_KEYS = ["macos", "windows", "linux", "default"] as const;

/** The per-OS key of each target OS. */
const KEY_OF: Readonly<Record<DesktopBackendOs, "macos" | "windows" | "linux">> = {
  darwin: "macos",
  windows: "windows",
  linux: "linux",
};

const isBackend = (v: unknown): v is DesktopBackend => v === "webview" || v === "cef";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What is wrong with a `desktop.backend` value: the offending key's path, and why. */
export interface DesktopBackendProblem {
  /** `desktop.backend`, or the per-OS key's path (`desktop.backend.linux`). */
  readonly field: string;
  /** The reason, to follow the field in a message. */
  readonly message: string;
}

/**
 * What is wrong with `value` as a `desktop.backend` setting, or `null` when it is one (or unset).
 *
 * @param value The configured value.
 * @returns The problem, or `null`.
 */
export function desktopBackendProblem(value: unknown): DesktopBackendProblem | null {
  const field = "desktop.backend";
  if (value === undefined || isBackend(value)) return null;
  if (!isPlainObject(value)) {
    return {
      field,
      message: 'must be "webview", "cef" or a per-OS object { macos?, windows?, linux?, default? }',
    };
  }
  for (const [key, v] of Object.entries(value)) {
    if (!(OS_KEYS as readonly string[]).includes(key)) {
      return { field, message: `has an unknown key "${key}" (the keys are ${OS_KEYS.join(", ")})` };
    }
    if (v !== undefined && !isBackend(v)) {
      return { field: `${field}.${key}`, message: 'must be "webview" or "cef"' };
    }
  }
  return null;
}

/**
 * The target OS of a Rust target triple (`aarch64-apple-darwin` → `darwin`).
 *
 * @param target The triple `deno desktop --target` takes.
 * @returns The OS, or `null` for a triple of no desktop OS.
 */
export function desktopBackendOsOfTarget(target: string): DesktopBackendOs | null {
  if (target.includes("-apple-darwin")) return "darwin";
  if (target.includes("-windows")) return "windows";
  if (target.includes("-linux")) return "linux";
  return null;
}

/**
 * The engine `setting` picks for `os`: the string itself, else the object's key for the OS, else
 * its `default`; `undefined` when `setting` is unset (the caller's next source, then `"webview"`).
 *
 * @param setting The `desktop.backend` value (checked: an invalid one throws).
 * @param os The target OS.
 * @returns The engine, or `undefined` when nothing is set.
 * @throws {Error} When `setting` is not a `desktop.backend` setting.
 */
export function resolveDesktopBackend(
  setting: unknown,
  os: DesktopBackendOs,
): DesktopBackend | undefined {
  const problem = desktopBackendProblem(setting);
  if (problem !== null) throw new Error(`${problem.field} ${problem.message}`);
  if (setting === undefined || isBackend(setting)) return setting;
  const byOs = setting as DesktopBackendConfig;
  return byOs[KEY_OF[os]] ?? byOs.default ?? DEFAULT_DESKTOP_BACKEND;
}
