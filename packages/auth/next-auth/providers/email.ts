/**
 * `next-auth/providers/email` on denext: Auth.js's older name for the SMTP email provider
 * (`id: "email"`). It is `next-auth/providers/nodemailer` with that id.
 *
 * @module
 */

import Nodemailer, { type NodemailerUserConfig } from "./nodemailer.ts";
import type { ProviderDescriptor } from "./shared.ts";

/**
 * The SMTP email provider under its older id, `"email"`.
 *
 * @param options As for `next-auth/providers/nodemailer`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Email(
  options: NodemailerUserConfig = {},
): ProviderDescriptor<NodemailerUserConfig> {
  return Nodemailer({ id: "email", ...options });
}
