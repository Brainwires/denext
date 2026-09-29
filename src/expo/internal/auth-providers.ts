/**
 * What the `expo-auth-session/providers/*` shims share: the per-platform client id, the
 * provider's minimum scopes and a random nonce. Internal: not a `denext/expo/*` entrypoint.
 * Nothing here runs at import time.
 *
 * @module
 */

import { nativePlatform } from "../../mobile/bridge.ts";

/** The per-platform client ids a provider config may carry. */
export interface ProviderClientIds {
  /** The client id for every platform (the fallback). */
  clientId?: string;
  /** The web client id. */
  webClientId?: string;
  /** The iOS client id. */
  iosClientId?: string;
  /** The Android client id. */
  androidClientId?: string;
}

/**
 * The client id for the platform the page runs on: `iosClientId` / `androidClientId` inside
 * the Capacitor shell, `webClientId` on the web, else `clientId`. (Expo picks by
 * `Platform.OS`, which is `"web"` in denext's shell; the shell is a native app to the
 * provider, so its native client id is the right one.)
 *
 * @param config The provider config.
 * @param provider The provider's name, for the error.
 * @returns The client id.
 * @throws When the platform's id and `clientId` are both missing.
 */
export function providerClientId(config: ProviderClientIds, provider: string): string {
  const platform = nativePlatform();
  const property = platform === "ios"
    ? "iosClientId"
    : platform === "android"
    ? "androidClientId"
    : "webClientId";
  const id = config[property] ?? config.clientId;
  if (id === undefined) {
    throw new Error(
      `Client Id property \`${property}\` must be defined to use ${provider} auth on this platform.`,
    );
  }
  return id;
}

/**
 * `scopes` plus the provider's required ones, without duplicates.
 *
 * @param scopes The app's scopes.
 * @param required The provider's minimum scopes.
 */
export function applyRequiredScopes(scopes: string[] = [], required: string[]): string[] {
  return [...new Set([...scopes, ...required])];
}

/**
 * A random hex string of `size` bytes (a nonce).
 *
 * @param size The number of random bytes.
 */
export function randomHex(size: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(size)),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/** Whether the page runs on the web (not inside the Capacitor shell). */
export function isWebAuth(): boolean {
  return nativePlatform() === "web";
}
