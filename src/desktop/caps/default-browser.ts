/**
 * The `defaultBrowser` capability (`denext desktop add default-browser`): the page asks to become
 * the system's default web browser and reads who handles a scheme, through
 * `setDefaultBrowser` / `getSchemeOwner` / `isDefaultBrowser` in `denext/desktop/app`. The work
 * happens in the app's own process ({@link ../default-browser.ts}): LaunchServices over FFI on
 * macOS (`--allow-ffi` of CoreServices and CoreFoundation), `xdg-settings` / `xdg-mime` on Linux
 * (`--allow-run`). Windows answers `unsupported`.
 *
 * Methods: `set` → `{ result }`, `owner({ scheme })` → `{ owner }`, `isDefault` →
 * `{ isDefault }`.
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import type { DesktopCapability, DesktopPermissions } from "../extension.ts";
import {
  CORE_FOUNDATION_PATH,
  CORE_SERVICES_PATH,
  createDefaultBrowser,
  DEFAULT_BROWSER_LINUX_PROGRAMS,
  type DefaultBrowserOptions,
  type DefaultBrowserOs,
} from "../default-browser.ts";

/**
 * The Deno permissions the capability needs on `os` (what the package scripts bake for it).
 *
 * @param os The OS.
 * @returns The permissions (none on Windows).
 */
export function defaultBrowserPermissions(os: DefaultBrowserOs): DesktopPermissions {
  if (os === "darwin") return { ffi: [CORE_SERVICES_PATH, CORE_FOUNDATION_PATH] };
  if (os === "linux") return { run: DEFAULT_BROWSER_LINUX_PROGRAMS };
  return {};
}

/**
 * Build the `defaultBrowser` capability for the app `options.identifier`.
 *
 * @param options The identifier (`desktop.app.identifier`), and the OS / FFI / runner (tests).
 * @returns The capability.
 */
export function defaultBrowserCapability(options: DefaultBrowserOptions): DesktopCapability {
  const os = options.os ?? (Deno.build.os as DefaultBrowserOs);
  const browser = createDefaultBrowser({ ...options, os });
  const permissions = defaultBrowserPermissions(os);
  return {
    name: "defaultBrowser",
    methods: {
      set: { permissions, handler: async () => ({ result: await browser.setDefaultBrowser() }) },
      owner: {
        permissions,
        handler: async (args) => ({
          owner: await browser.getSchemeOwner(
            (args as { scheme?: unknown } | null)?.scheme as string,
          ),
        }),
      },
      isDefault: {
        permissions,
        handler: async () => ({ isDefault: await browser.isDefaultBrowser() }),
      },
    },
  };
}
