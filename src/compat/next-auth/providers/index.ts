/**
 * `next-auth/providers` on denext: the provider types. Each provider is its own module
 * (`next-auth/providers/github`, `…/google`, `…/credentials`, `…/resend`, `…/nodemailer`,
 * `…/email`, `…/apple`, `…/discord`, `…/microsoft-entra-id`); a custom OAuth / OIDC provider
 * is a plain object (`{ id, name, type: "oauth", authorization, token, userinfo, … }`).
 *
 * @module
 */

export type { Provider } from "../types.ts";
export type {
  BuiltProvider,
  CustomOAuthConfig as OAuthConfig,
  EndpointConfig,
  EnvReader,
  OAuthUserConfig,
  ProfileUser,
  ProviderDescriptor,
} from "./shared.ts";
export type { CredentialInput, CredentialsConfig } from "./credentials.ts";
export type { EmailUserConfig, SendVerificationRequestParams } from "./email-shared.ts";
export type { NodemailerUserConfig, SmtpServerOptions } from "./nodemailer.ts";
export type { ResendUserConfig } from "./resend.ts";
