/**
 * What the email providers (`resend`, `nodemailer`, `email`) share: the descriptor, Auth.js's
 * `sendVerificationRequest` signature, and the plain sign-in message Auth.js sends by default.
 * Each maps onto denext's `magicLink()` provider, whose link opens a confirmation page by
 * default (a mail scanner can't spend it); `confirm: false` signs in on the GET, as Auth.js does.
 *
 * @module
 */

import { magicLink } from "../../src/providers.ts";
import type { VerificationRequestParams } from "../../src/types.ts";
import { describeProvider, type EnvReader, type ProviderDescriptor } from "./shared.ts";

/** What an Auth.js `sendVerificationRequest` receives. */
export interface SendVerificationRequestParams {
  /** The address the link goes to. */
  identifier: string;
  /** The sign-in link. */
  url: string;
  /** When the link expires. */
  expires: Date;
  /** The provider's options (its `from`, `apiKey` or `server`). */
  provider: Record<string, unknown>;
  /** The token inside the link. */
  token: string;
  /** Accepted for Auth.js compatibility (the built-in pages are unstyled). */
  theme: Record<string, unknown>;
  /** The request that asked for the link. */
  request: Request;
}

/** The options every email provider takes. */
export interface EmailUserConfig {
  /** Provider id. */
  id?: string;
  /** Display name. */
  name?: string;
  /** The sender address. */
  from?: string;
  /** Link lifetime in seconds (accepted; denext's `email.magicMaxAge` governs it). */
  maxAge?: number;
  /** Send the link yourself. */
  sendVerificationRequest?: (params: SendVerificationRequestParams) => void | Promise<void>;
  /** `false` signs in on the link's GET, as Auth.js does; default `true` (a confirmation page). */
  confirm?: boolean;
}

/** The subject, text and HTML of the default sign-in mail. */
export function signInMessage(
  url: string,
): { subject: string; text: string; html: string } {
  const host = new URL(url).host;
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return {
    subject: `Sign in to ${host}`,
    text: `Sign in to ${host}\n${url}\n\n`,
    html: `<p>Sign in to <strong>${host.replace(/</g, "&lt;")}</strong></p>` +
      `<p><a href="${escaped}">Sign in</a></p>`,
  };
}

/**
 * Describe an email provider.
 *
 * @param meta The default id and name.
 * @param options The app's options.
 * @param defaultSend Builds the sender used when the app gives none.
 * @returns The descriptor.
 */
export function emailDescriptor<O extends EmailUserConfig>(
  meta: { id: string; name: string },
  options: O,
  defaultSend: (env: EnvReader) => (params: SendVerificationRequestParams) => Promise<void>,
): ProviderDescriptor<O> {
  const id = options.id ?? meta.id;
  const descriptor = { id, name: options.name ?? meta.name, type: "email" as const, options };
  return describeProvider(descriptor, (env) => {
    const sender = options.sendVerificationRequest ?? defaultSend(env);
    const provider = magicLink({ id, name: options.name ?? meta.name, confirm: options.confirm });
    const send = async (params: VerificationRequestParams) => {
      await sender({
        identifier: params.identifier,
        url: params.url,
        expires: new Date(params.expiresAt * 1000),
        provider: { id, ...options } as unknown as Record<string, unknown>,
        token: params.token,
        theme: {},
        request: new Request(params.url),
      });
    };
    return { provider, send };
  });
}
