/**
 * The HTTP-API email providers (`sendgrid`, `postmark`, `mailgun`, `forwardemail`, `loops`): each
 * sends Auth.js's sign-in mail through its service's API with an API key (`apiKey`, default
 * `AUTH_<ID>_KEY`), on denext's `magicLink()` provider like `resend`.
 *
 * @module
 */

import {
  emailDescriptor,
  type EmailUserConfig,
  type SendVerificationRequestParams,
  signInMessage,
} from "./email-shared.ts";
import type { EnvReader, ProviderDescriptor } from "./shared.ts";

/** The options of an HTTP-API email provider. */
export interface HttpEmailUserConfig extends EmailUserConfig {
  /** The service's API key (default `AUTH_<ID>_KEY`). */
  apiKey?: string;
}

/** What one service's request needs. */
export interface HttpEmailMessage {
  /** The recipient. */
  to: string;
  /** The sender, as configured. */
  from: string;
  /** The provider's display name. */
  name: string;
  /** The API key. */
  apiKey: string;
  /** The sign-in link. */
  url: string;
  /** The default message's subject, text and HTML. */
  message: { subject: string; text: string; html: string };
}

/** One service: its id, name and the request that sends a message. */
export interface HttpEmailService<O extends HttpEmailUserConfig> {
  /** The provider id (its `AUTH_<ID>_KEY`). */
  id: string;
  /** Its display name. */
  name: string;
  /** The request that sends `mail`, given the app's options. */
  request(mail: HttpEmailMessage, options: O): { url: string; init: RequestInit };
}

/** Auth.js's default sender address. */
const DEFAULT_FROM = "Auth.js <no-reply@authjs.dev>";

/** Send one sign-in mail through `service`. */
function sender<O extends HttpEmailUserConfig>(
  service: HttpEmailService<O>,
  options: O,
  env: EnvReader,
): (params: SendVerificationRequestParams) => Promise<void> {
  const variable = `AUTH_${(options.id ?? service.id).toUpperCase().replace(/-/g, "_")}_KEY`;
  return async (params) => {
    const apiKey = options.apiKey ?? env(variable);
    if (!apiKey) throw new Error(`next-auth ${service.id}: no apiKey (set ${variable})`);
    const { url, init } = service.request({
      to: params.identifier,
      from: options.from ?? DEFAULT_FROM,
      name: options.name ?? service.name,
      apiKey,
      url: params.url,
      message: signInMessage(params.url),
    }, options);
    const res = await fetch(url, { method: "POST", ...init });
    if (!res.ok) throw new Error(`next-auth ${service.id}: the API answered ${res.status}`);
    await res.body?.cancel();
  };
}

/**
 * Describe an HTTP-API email provider.
 *
 * @param service The service.
 * @param options The app's options.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export function httpEmailDescriptor<O extends HttpEmailUserConfig>(
  service: HttpEmailService<O>,
  options: O,
): ProviderDescriptor<O> {
  return emailDescriptor(
    { id: service.id, name: service.name },
    options,
    (env) => sender(service, options, env),
  );
}

/** A JSON POST body with these headers. */
export function jsonRequest(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): { url: string; init: RequestInit } {
  return {
    url,
    init: {
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}
