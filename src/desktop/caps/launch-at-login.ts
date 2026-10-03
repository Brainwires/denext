/**
 * The `launchAtLogin` capability: start the app when the user logs in, through
 * `Deno.desktop.launchAtLogin` (denext's pinned Deno Desktop runtime) — macOS 13+ `SMAppService`
 * (the app becomes a login item), a Windows `HKCU\…\Run` value, a Linux XDG autostart entry. The
 * entry is named after `desktop.app.identifier`. The page side is `denext/desktop/app`'s
 * `getLaunchAtLogin` / `setLaunchAtLogin`.
 *
 * Under the stock runtime every method answers `unavailable`.
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import { type DesktopAppApi, desktopAppApi } from "../launch-events.ts";

/** The states the runtime reports. */
const STATES = ["enabled", "disabled", "requires-approval", "not-supported"];

/** Options for {@linkcode launchAtLoginCapability}. */
export interface LaunchAtLoginCapabilityOptions {
  /** The runtime's app API (default `Deno.desktop`); tests pass a fake. */
  readonly api?: DesktopAppApi;
}

/** The runtime's launch-at-login API, or `unavailable`. */
function nativeLogin(api: DesktopAppApi | undefined): NonNullable<DesktopAppApi["launchAtLogin"]> {
  const l = api?.launchAtLogin;
  if (typeof l?.get !== "function" || typeof l.set !== "function") {
    throw new DesktopCapError(
      "unavailable",
      "this Deno Desktop runtime cannot start the app at login (denext's pinned runtime can)",
    );
  }
  return l;
}

/** A state the page can rely on (anything unexpected reads `not-supported`). */
function state(value: unknown): string {
  return typeof value === "string" && STATES.includes(value) ? value : "not-supported";
}

/**
 * Build the `launchAtLogin` capability.
 *
 * @param options The runtime API (tests).
 * @returns The capability.
 */
export function launchAtLoginCapability(
  options: LaunchAtLoginCapabilityOptions = {},
): DesktopCapability {
  const api = () => options.api ?? desktopAppApi();
  return {
    name: "launchAtLogin",
    methods: {
      get: { handler: async () => ({ state: state(await nativeLogin(api()).get()) }) },
      set: {
        handler: async (args) => {
          const enabled = (args as { enabled?: unknown } | null)?.enabled;
          if (typeof enabled !== "boolean") {
            throw new DesktopCapError("validation", "enabled must be a boolean");
          }
          const login = nativeLogin(api());
          try {
            return { state: state(await login.set(enabled)) };
          } catch {
            // The OS's message can name paths (the autostart entry); the page gets a fixed one.
            throw new DesktopCapError("failed", "the OS did not change the login item", {
              status: 500,
            });
          }
        },
      },
    },
  };
}
