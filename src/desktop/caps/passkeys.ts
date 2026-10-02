/**
 * The `passkeys` capability: native WebAuthn ceremonies through the OS platform authenticator
 * (`Deno.desktop.passkeys` in denext's pinned runtime — macOS ASAuthorizationController, Windows
 * webauthn.dll; Linux has none) for a page whose origin (a custom scheme) the webview's own WebAuthn
 * cannot use for the relying party. The page side is `denext/desktop/clerk`'s
 * `__clerk_internal_electron_passkeys`, so `@clerk/electron/passkeys` runs unchanged.
 *
 * The wire format is `@clerk/electron-passkeys`': the options as JSON (binary members unpadded
 * base64url), and a result envelope `{ ok: true, credential }` or
 * `{ ok: false, error: { code, message } }` with `code` one of `cancelled`, `invalid_rp`,
 * `not_supported`, `timeout`, `unknown`. This module mirrors `@clerk/electron`'s main-process
 * handler (`invokeNative`): the runtime's string is parsed and checked to be such an envelope, and
 * anything else becomes `unknown`.
 *
 * SECURITY. The native path skips the browser's origin check (the OS builds `clientDataJSON` for
 * `https://<rp-id>`), and on Windows nothing ties the RP ID to the app. So the options are
 * untrusted input, and `desktop.capabilities.passkeys: { rpIds: [...] }` pins the RP IDs this app
 * may request (anything else answers `invalid_rp` without reaching the OS). The pin is mandatory:
 * with no RP ID listed, every ceremony answers `invalid_rp` (fail closed). The bridge's gate
 * already limits the caller to the app's own top-level page.
 *
 * macOS: a request succeeds only when the app's code signature carries
 * `com.apple.developer.associated-domains` = `webcredentials:<rp-id>` (with a provisioning profile)
 * and `https://<rp-id>/.well-known/apple-app-site-association` lists `<TeamID>.<bundle id>`;
 * otherwise every request is `invalid_rp`.
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import type { DesktopCapability } from "../extension.ts";
import { DesktopCapError } from "../extension.ts";
import { type DesktopAppApi, desktopAppApi } from "../launch-events.ts";
import { isPasskeyEnvelope, passkeyFailure as failure } from "../passkey-envelope.ts";

/** The largest options JSON accepted. */
const MAX_OPTIONS_CHARS = 64 * 1024;
/** How long one ceremony may take before the bridge gives up (the OS has its own timeouts). */
const CEREMONY_TIMEOUT_MS = 5 * 60_000;

/** Options for {@linkcode passkeysCapability}. */
export interface PasskeysCapabilityOptions {
  /** The RP IDs the app may request. Absent or empty: none (every ceremony is `invalid_rp`). */
  readonly rpIds?: readonly string[];
  /** The runtime's app API (default `Deno.desktop`); tests pass a fake. */
  readonly api?: DesktopAppApi;
  /** The OS (default the running one); tests pass one. */
  readonly os?: typeof Deno.build.os;
}

/** The `optionsJson` argument, parsed (the RP check reads it). */
function readOptions(args: unknown): { json: string; parsed: Record<string, unknown> } {
  const json = (args as { optionsJson?: unknown } | null)?.optionsJson;
  if (typeof json !== "string" || json.length > MAX_OPTIONS_CHARS) {
    throw new DesktopCapError("validation", "optionsJson must be a JSON string up to 64 KiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DesktopCapError("validation", "optionsJson is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DesktopCapError("validation", "optionsJson must be an object");
  }
  return { json, parsed: parsed as Record<string, unknown> };
}

/** The RP ID a ceremony asks for: `rp.id` (create) or `rpId` (get). */
function rpIdOf(kind: "create" | "get", options: Record<string, unknown>): string {
  const id = kind === "create" ? (options.rp as { id?: unknown } | undefined)?.id : options.rpId;
  return typeof id === "string" ? id : "";
}

/**
 * Build the `passkeys` capability.
 *
 * @param options The allowed RP IDs, and (for tests) the runtime API.
 * @returns The capability.
 */
export function passkeysCapability(options: PasskeysCapabilityOptions = {}): DesktopCapability {
  const rpIds = (options.rpIds ?? []).map((id) => id.toLowerCase());
  const api = () => options.api ?? desktopAppApi();

  const ceremony = (kind: "create" | "get") => async (args: unknown, ctx: { window?: unknown }) => {
    const { json, parsed } = readOptions(args);
    const rpId = rpIdOf(kind, parsed).toLowerCase();
    if (rpIds.length === 0) {
      return failure(
        "invalid_rp",
        "desktop.capabilities.passkeys pins no RP ID: list the relying parties in { rpIds: [...] }",
      );
    }
    if (rpId === "" || !rpIds.includes(rpId)) {
      return failure("invalid_rp", `the RP ID "${rpId}" is not in desktop.capabilities.passkeys`);
    }
    const native = api()?.passkeys;
    if (typeof native?.[kind] !== "function") {
      return failure("not_supported", "this Deno Desktop runtime has no native passkeys");
    }
    const anchor = typeof ctx.window === "object" && ctx.window !== null
      ? { window: ctx.window }
      : undefined;
    try {
      const result: unknown = JSON.parse(await native[kind](json, anchor));
      return isPasskeyEnvelope(result)
        ? result
        : failure("unknown", "the native passkey call returned an unexpected result");
    } catch (err) {
      return failure("unknown", err instanceof Error ? err.message : String(err));
    }
  };

  return {
    name: "passkeys",
    methods: {
      capabilities: {
        handler: async () => {
          const native = api()?.passkeys;
          if (typeof native?.capabilities !== "function") {
            return { available: false, platformAuthenticator: false, securityKeys: false };
          }
          const caps = await native.capabilities();
          // `available` mirrors @clerk/electron's `native.isAvailable()`: the OS has a native path
          // at all (macOS, Windows); what it can use right now is the two flags.
          return {
            available: (options.os ?? Deno.build.os) !== "linux",
            platformAuthenticator: caps?.platformAuthenticator === true,
            securityKeys: caps?.securityKeys === true,
          };
        },
      },
      create: { timeoutMs: CEREMONY_TIMEOUT_MS, handler: ceremony("create") },
      get: { timeoutMs: CEREMONY_TIMEOUT_MS, handler: ceremony("get") },
    },
  };
}
