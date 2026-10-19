/**
 * What `next-auth/providers/passkey` and `…/webauthn` share: Auth.js's WebAuthn options mapped
 * onto denext's passkey settings (`denextAuth({ passkeys })`).
 *
 * @module
 */

import type { AuthPasskeyConfig } from "../../../server/auth/types.ts";
import { describeProvider, type ProviderDescriptor } from "./shared.ts";

/** Auth.js's WebAuthn ceremony options (the parts denext reads). */
export interface WebAuthnCeremonyOptions {
  /** How long the ceremony may take, in milliseconds. */
  timeout?: number;
  /** `"required"`, `"preferred"` or `"discouraged"` (read as `"preferred"`). */
  userVerification?: string;
  /** Registration's authenticator selection (its `userVerification` is read). */
  authenticatorSelection?: { userVerification?: string; residentKey?: string };
}

/** The options of `next-auth/providers/passkey` and `…/webauthn`. */
export interface WebAuthnUserConfig {
  /** Provider id. */
  id?: string;
  /** Display name. */
  name?: string;
  /**
   * The relying party: `id` (the RP ID, default the request's host name), `name` (shown by the
   * authenticator) and `origin` (the origins a ceremony may come from); the first of a list is
   * the RP ID and name, and every listed origin is accepted.
   */
  relayingParty?: {
    id?: string | string[];
    name?: string | string[];
    origin?: string | string[];
  };
  /** Sign-in ceremony options (`timeout`, `userVerification`). */
  authenticationOptions?: WebAuthnCeremonyOptions;
  /** Registration ceremony options (`timeout`, `authenticatorSelection.userVerification`). */
  registrationOptions?: WebAuthnCeremonyOptions;
  /** Accepted for Auth.js compatibility: denext's verification is its own. */
  verifyAuthenticationOptions?: Record<string, unknown>;
  /** Accepted for Auth.js compatibility: denext's verification is its own. */
  verifyRegistrationOptions?: Record<string, unknown>;
  /** Accepted for Auth.js compatibility (the browser's conditional UI is the app's own). */
  enableConditionalUI?: boolean;
  /** Accepted for Auth.js compatibility: denext registers passkeys for signed-in users only. */
  formFields?: Record<string, unknown>;
  /** Accepted for Auth.js compatibility: denext registers passkeys for signed-in users only. */
  getUserInfo?: unknown;
  /** Accepted for Auth.js compatibility: the relying party comes from `relayingParty`. */
  getRelayingParty?: unknown;
  /** Accepted for Auth.js compatibility: denext runs its own WebAuthn verification. */
  simpleWebAuthn?: unknown;
  /** Accepted for Auth.js compatibility. */
  simpleWebAuthnBrowserVersion?: string | false;
}

/** The first of one value or a list. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Every value of one value or a list. */
function all(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * The relying party: the RP ID, its name and the origins a ceremony may come from. Auth.js takes
 * the origin from the request when only the RP ID is set; denext never trusts the request for it,
 * so it is the RP ID's own https origin.
 */
function relyingParty(options: WebAuthnUserConfig): AuthPasskeyConfig {
  const rp = options.relayingParty ?? {};
  const rpId = first(rp.id);
  const rpName = first(rp.name);
  const origins = all(rp.origin);
  const settings: AuthPasskeyConfig = {};
  if (rpId) settings.rpId = rpId;
  if (rpName) settings.rpName = rpName;
  if (origins.length) settings.origins = origins;
  else if (rpId) settings.origins = [`https://${rpId}`];
  return settings;
}

/** User verification: `"required"` when the options ask for it, else the provider's default. */
function userVerificationOf(
  options: WebAuthnUserConfig,
  fallback: "required" | "preferred",
): "required" | "preferred" {
  const asked = options.authenticationOptions?.userVerification ??
    options.registrationOptions?.authenticatorSelection?.userVerification ??
    options.registrationOptions?.userVerification;
  if (asked === undefined) return fallback;
  return asked === "required" ? "required" : "preferred";
}

/** The passkey settings Auth.js's WebAuthn options describe. */
function passkeySettings(
  options: WebAuthnUserConfig,
  userVerification: "required" | "preferred",
): AuthPasskeyConfig {
  const settings = relyingParty(options);
  settings.userVerification = userVerificationOf(options, userVerification);
  const timeout = options.authenticationOptions?.timeout ?? options.registrationOptions?.timeout;
  if (typeof timeout === "number" && timeout > 0) settings.timeout = Math.round(timeout / 1000);
  return settings;
}

/**
 * Describe a WebAuthn provider: it lists as `type: "webauthn"` and builds denext's passkey
 * settings instead of a provider.
 *
 * @param meta The default id and name, and the default user verification.
 * @param options The app's options.
 * @returns The descriptor.
 */
export function webAuthnDescriptor(
  meta: { id: string; name: string; userVerification: "required" | "preferred" },
  options: WebAuthnUserConfig,
): ProviderDescriptor<WebAuthnUserConfig> {
  const descriptor = {
    id: options.id ?? meta.id,
    name: options.name ?? meta.name,
    type: "webauthn" as const,
    options,
  };
  return describeProvider(descriptor, () => ({
    passkeys: passkeySettings(options, meta.userVerification),
  }));
}
