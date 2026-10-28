/**
 * `next-auth/providers/nodemailer` on denext: passwordless sign-in links sent over SMTP by
 * denext's own `smtpMailer()` (TLS required; no `nodemailer` package), on denext's `magicLink()`
 * provider. `server` is an SMTP URL (`smtp://user:pass@host:587`) or `{ host, port, auth }`;
 * the default is `AUTH_EMAIL_SERVER` (then `EMAIL_SERVER`).
 *
 * ```ts
 * import Nodemailer from "next-auth/providers/nodemailer";
 * Nodemailer({ server: process.env.EMAIL_SERVER, from: "auth@example.com" });
 * ```
 *
 * @module
 */

import { smtpMailer, type SmtpMailerOptions } from "../../src/smtp.ts";
import {
  emailDescriptor,
  type EmailUserConfig,
  type SendVerificationRequestParams,
  signInMessage,
} from "./email-shared.ts";
import type { EnvReader, ProviderDescriptor } from "./shared.ts";

/** Nodemailer's SMTP transport options, as far as denext's mailer uses them. */
export interface SmtpServerOptions {
  /** The SMTP host. */
  host: string;
  /** The port (default 587, or 465 with `secure`). */
  port?: number;
  /** Implicit TLS (SMTPS). */
  secure?: boolean;
  /** Login. */
  auth?: { user?: string; pass?: string };
}

/** The options of the Nodemailer provider. */
export interface NodemailerUserConfig extends EmailUserConfig {
  /** The SMTP server: a URL or the transport options. */
  server?: string | SmtpServerOptions;
}

/** The SMTP settings a `server` option describes. */
export function smtpSettings(
  server: string | SmtpServerOptions,
  from: string,
): SmtpMailerOptions {
  if (typeof server !== "string") {
    return {
      host: server.host,
      port: server.port,
      secure: server.secure,
      user: server.auth?.user,
      pass: server.auth?.pass,
      from,
    };
  }
  const url = new URL(server);
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new TypeError("next-auth nodemailer: `server` must be an smtp:// or smtps:// URL");
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    secure: url.protocol === "smtps:",
    user: url.username ? decodeURIComponent(url.username) : undefined,
    pass: url.password ? decodeURIComponent(url.password) : undefined,
    from,
  };
}

/** Send one sign-in mail over SMTP. */
function smtpSender(
  options: NodemailerUserConfig,
  env: EnvReader,
): (params: SendVerificationRequestParams) => Promise<void> {
  return async (params) => {
    const server = options.server ?? env("AUTH_EMAIL_SERVER") ?? env("EMAIL_SERVER");
    if (!server) throw new Error("next-auth nodemailer: no `server` (set AUTH_EMAIL_SERVER)");
    const from = options.from ?? env("AUTH_EMAIL_FROM") ?? env("EMAIL_FROM") ?? "";
    const { subject, text, html } = signInMessage(params.url);
    await smtpMailer(smtpSettings(server, from)).send({
      to: params.identifier,
      subject,
      text,
      html,
    });
  };
}

/**
 * The Nodemailer (SMTP) email provider.
 *
 * @param options The SMTP `server`, the sender, an `id` / `name` override, your own
 *   `sendVerificationRequest`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Nodemailer(
  options: NodemailerUserConfig = {},
): ProviderDescriptor<NodemailerUserConfig> {
  return emailDescriptor(
    { id: "nodemailer", name: "Email" },
    options,
    (env) => smtpSender(options, env),
  );
}
