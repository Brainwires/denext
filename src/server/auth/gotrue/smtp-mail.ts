/**
 * `/auth/v1`'s own SMTP delivery: Supabase Auth's `GOTRUE_SMTP_*` settings, its mailer subjects
 * (`GOTRUE_MAILER_SUBJECTS_*`) and templates (`GOTRUE_MAILER_TEMPLATES_*`, URLs of HTML
 * templates), used when neither `hooks.sendEmail` nor `sendVerificationRequest` is configured.
 * `backend({ supabase })` reads them from the environment ({@linkcode goTrueSmtpFromEnv}); a
 * `supabase.auth.smtp` object sets them in code.
 *
 * Templates take GoTrue's simple placeholders — `{{ .ConfirmationURL }}`, `{{ .Token }}`,
 * `{{ .TokenHash }}`, `{{ .SiteURL }}`, `{{ .Email }}`, `{{ .NewEmail }}`, `{{ .RedirectTo }}`
 * — each HTML-escaped. A template that uses any other Go template action (`{{ if … }}`,
 * `{{ .Data.… }}`) is not rendered; the built-in one is sent instead and the reason logged.
 * A template URL is fetched (http(s) only, 10 s, at most 1 MiB, a redirect followed only to an
 * `https:` URL on the same origin) on first use and kept for 10 minutes; a failed fetch falls
 * back to the built-in template.
 *
 * @module
 */

import { readCappedBody } from "../../body.ts";
import { type SmtpMailer, smtpMailer, type SmtpMailerOptions } from "../smtp.ts";

/** The mails GoTrue sends, by the names its subject and template settings use. */
export type GoTrueMailKind =
  | "confirmation"
  | "invite"
  | "recovery"
  | "magic_link"
  | "email_change"
  | "reauthentication";

/** `/auth/v1`'s SMTP delivery: the server, plus GoTrue's subjects and template URLs. */
export interface GoTrueSmtpOptions extends Omit<SmtpMailerOptions, "render"> {
  /** Subjects by mail kind (`GOTRUE_MAILER_SUBJECTS_*`). */
  subjects?: Partial<Record<GoTrueMailKind, string>>;
  /** URLs of HTML templates by mail kind (`GOTRUE_MAILER_TEMPLATES_*`). */
  templates?: Partial<Record<GoTrueMailKind, string>>;
}

/** What one `/auth/v1` mail is rendered from. */
export interface GoTrueMailInput {
  /** The GoTrue email action (`signup`, `invite`, `magiclink`, `email`, …). */
  action: string;
  /** The recipient. */
  to: string;
  /** The ready-to-click verification link. */
  confirmationUrl: string;
  /** The one-time code. */
  token: string;
  /** The link's token hash. */
  tokenHash: string;
  /** The site URL. */
  siteUrl: string;
  /** Where the link lands. */
  redirectTo: string;
  /** The account's current address (an email change: the old one). */
  email: string;
  /** For an email change: the new address. */
  newEmail?: string;
}

/** Where log lines go. */
interface Logger {
  warn(message: string, meta?: unknown): void;
}

/** The mail kind a GoTrue email action uses (an email OTP uses the magic-link template). */
export function mailKindOf(action: string): GoTrueMailKind {
  switch (action) {
    case "invite":
      return "invite";
    case "recovery":
      return "recovery";
    case "magiclink":
    case "email":
      return "magic_link";
    case "email_change":
      return "email_change";
    case "reauthentication":
      return "reauthentication";
    default:
      return "confirmation";
  }
}

/** GoTrue's default subjects. */
const DEFAULT_SUBJECTS: Record<GoTrueMailKind, string> = {
  confirmation: "Confirm Your Email",
  invite: "You have been invited",
  recovery: "Reset Your Password",
  magic_link: "Your Magic Link",
  email_change: "Confirm Email Change",
  reauthentication: "Confirm reauthentication",
};

/** The built-in HTML templates, in GoTrue's placeholder syntax. */
const DEFAULT_TEMPLATES: Record<GoTrueMailKind, string> = {
  confirmation: "<h2>Confirm your signup</h2>\n<p>Follow this link to confirm your user:</p>\n" +
    '<p><a href="{{ .ConfirmationURL }}">Confirm your mail</a></p>\n' +
    "<p>Alternatively, enter the code: {{ .Token }}</p>\n",
  invite: "<h2>You have been invited</h2>\n<p>You have been invited to create a user on " +
    "{{ .SiteURL }}. Follow this link to accept the invite:</p>\n" +
    '<p><a href="{{ .ConfirmationURL }}">Accept the invite</a></p>\n',
  recovery:
    "<h2>Reset Password</h2>\n<p>Follow this link to reset the password for your user:</p>\n" +
    '<p><a href="{{ .ConfirmationURL }}">Reset Password</a></p>\n' +
    "<p>Alternatively, enter the code: {{ .Token }}</p>\n",
  magic_link: "<h2>Magic Link</h2>\n<p>Follow this link to login:</p>\n" +
    '<p><a href="{{ .ConfirmationURL }}">Log In</a></p>\n' +
    "<p>Alternatively, enter the code: {{ .Token }}</p>\n",
  email_change: "<h2>Confirm email address change</h2>\n<p>Follow this link to confirm the " +
    "update of your email address from {{ .Email }} to {{ .NewEmail }}:</p>\n" +
    '<p><a href="{{ .ConfirmationURL }}">Change email address</a></p>\n' +
    "<p>Alternatively, enter the code: {{ .Token }}</p>\n",
  reauthentication: "<h2>Confirm reauthentication</h2>\n<p>Enter the code: {{ .Token }}</p>\n",
};

/** The environment variable suffix of each kind. */
const KIND_ENV: Record<GoTrueMailKind, string> = {
  confirmation: "CONFIRMATION",
  invite: "INVITE",
  recovery: "RECOVERY",
  magic_link: "MAGIC_LINK",
  email_change: "EMAIL_CHANGE",
  reauthentication: "REAUTHENTICATION",
};

/** Every kind, in a fixed order. */
const KINDS = Object.keys(KIND_ENV) as GoTrueMailKind[];

/** The values each kind's settings read from the environment. */
function perKind(
  env: (name: string) => string | undefined,
  prefix: string,
): Partial<Record<GoTrueMailKind, string>> | undefined {
  const out: Partial<Record<GoTrueMailKind, string>> = {};
  for (const kind of KINDS) {
    const value = env(`${prefix}${KIND_ENV[kind]}`)?.trim();
    if (value) out[kind] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Supabase Auth's SMTP settings from the environment: `GOTRUE_SMTP_HOST`, `_PORT`, `_USER`,
 * `_PASS`, `_ADMIN_EMAIL` (the sender) and `_SENDER_NAME`, plus `GOTRUE_MAILER_SUBJECTS_*` and
 * `GOTRUE_MAILER_TEMPLATES_*`. `undefined` unless both the host and the sender are set.
 *
 * @param env Reads an environment variable.
 * @returns The options, or `undefined`.
 * @throws {TypeError} When `GOTRUE_SMTP_PORT` is not a port number.
 */
export function goTrueSmtpFromEnv(
  env: (name: string) => string | undefined,
): GoTrueSmtpOptions | undefined {
  const host = env("GOTRUE_SMTP_HOST")?.trim();
  const admin = env("GOTRUE_SMTP_ADMIN_EMAIL")?.trim();
  if (!host || !admin) return undefined;
  const portText = env("GOTRUE_SMTP_PORT")?.trim();
  const port = portText ? Number(portText) : undefined;
  if (port !== undefined && !Number.isInteger(port)) {
    throw new TypeError("GOTRUE_SMTP_PORT must be a port number");
  }
  const name = env("GOTRUE_SMTP_SENDER_NAME")?.trim();
  const user = env("GOTRUE_SMTP_USER");
  const pass = env("GOTRUE_SMTP_PASS");
  const subjects = perKind(env, "GOTRUE_MAILER_SUBJECTS_");
  const templates = perKind(env, "GOTRUE_MAILER_TEMPLATES_");
  return {
    host,
    ...(port !== undefined ? { port } : {}),
    from: name ? `${name.replace(/["\\<>]/g, "")} <${admin}>` : admin,
    ...(user ? { user, pass: pass ?? "" } : {}),
    ...(subjects ? { subjects } : {}),
    ...(templates ? { templates } : {}),
  };
}

/** Reads the process environment; `undefined` where env access isn't granted. */
function processEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** The last environment read, so an unchanged environment yields the same options object. */
let envSmtp: { key: string; options: GoTrueSmtpOptions | undefined } | undefined;

/**
 * {@linkcode goTrueSmtpFromEnv} over the process environment, returning the same object while
 * the variables are unchanged (the sender, and its template cache, are kept per object).
 *
 * @param env Reads an environment variable (default: the process environment).
 * @returns The options, or `undefined` when `GOTRUE_SMTP_HOST` / `_ADMIN_EMAIL` are unset.
 */
export function processGoTrueSmtp(
  env: (name: string) => string | undefined = processEnv,
): GoTrueSmtpOptions | undefined {
  const options = goTrueSmtpFromEnv(env);
  const key = JSON.stringify(options ?? null);
  if (envSmtp?.key !== key) envSmtp = { key, options };
  return envSmtp.options;
}

/** HTML-escape a substituted value. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The placeholders a template may use, and their values. */
function placeholders(input: GoTrueMailInput): Record<string, string> {
  return {
    ConfirmationURL: input.confirmationUrl,
    Token: input.token,
    TokenHash: input.tokenHash,
    SiteURL: input.siteUrl,
    Email: input.email,
    NewEmail: input.newEmail ?? "",
    RedirectTo: input.redirectTo,
  };
}

/**
 * Render a template's placeholders (values HTML-escaped), or `null` when it uses any template
 * action this renderer doesn't support.
 *
 * @param template The template.
 * @param input What the mail is rendered from.
 * @returns The HTML, or `null`.
 */
export function renderGoTrueTemplate(template: string, input: GoTrueMailInput): string | null {
  const values = placeholders(input);
  let unsupported = false;
  const html = template.replace(/\{\{-?\s*([^}]*?)\s*-?\}\}/g, (_, action: string) => {
    const name = /^\.([A-Za-z]+)$/.exec(action)?.[1];
    if (name === undefined || !(name in values)) {
      unsupported = true;
      return "";
    }
    return escapeHtml(values[name]);
  });
  return unsupported ? null : html;
}

/** The plain-text part: the link and the code, whatever the HTML template says. */
function plainText(kind: GoTrueMailKind, input: GoTrueMailInput): string {
  if (kind === "reauthentication") return `Enter the code: ${input.token}\n`;
  return `Follow this link:\n\n${input.confirmationUrl}\n\n` +
    (kind === "invite" ? "" : `Alternatively, enter the code: ${input.token}\n`);
}

/** How long a fetched template is kept, and the most one may weigh. */
const TEMPLATE_TTL_MS = 10 * 60_000;
const TEMPLATE_MAX_BYTES = 1024 * 1024;

/** One fetched template. */
interface CachedTemplate {
  at: number;
  body: Promise<string | null>;
}

/** The most redirects a template fetch follows. */
const MAX_TEMPLATE_REDIRECTS = 3;

/**
 * Fetch `url`, following a redirect only to an `https:` URL on the same origin (at most
 * {@linkcode MAX_TEMPLATE_REDIRECTS}): a template host can't bounce the server to another host —
 * an internal address, say — or downgrade it to plaintext.
 */
async function fetchSameOrigin(url: URL, fetchImpl: typeof fetch): Promise<Response> {
  const signal = AbortSignal.timeout(10_000);
  let current = url;
  for (let hops = 0;; hops++) {
    const res = await fetchImpl(current, { signal, redirect: "manual" });
    if (res.status < 300 || res.status > 399) return res;
    await res.body?.cancel();
    const location = res.headers.get("location");
    const next = location ? new URL(location, current) : null;
    if (!next || next.protocol !== "https:" || next.origin !== current.origin) {
      throw new Error("refused a redirect off the template's https origin");
    }
    if (hops >= MAX_TEMPLATE_REDIRECTS) throw new Error("too many redirects");
    current = next;
  }
}

/** Fetch a template URL: http(s), 10 s, ≤ 1 MiB; `null` on any failure. */
async function fetchTemplate(
  url: string,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("not an http(s) URL");
    }
    const res = await fetchSameOrigin(parsed, fetchImpl);
    if (!res.ok) throw new Error(`status ${res.status}`);
    // Streamed under the cap: an oversized (or endless) answer is cut off, never buffered.
    const bytes = await readCappedBody({ body: res.body } as Request, TEMPLATE_MAX_BYTES);
    if (!(bytes instanceof Uint8Array)) throw new Error("larger than 1 MiB, or stalled");
    return new TextDecoder().decode(bytes);
  } catch (error) {
    logger.warn("/auth/v1: a mailer template could not be fetched; using the built-in one", {
      reason: (error as Error).message,
    });
    return null;
  }
}

/** A configured `/auth/v1` SMTP sender. */
export interface GoTrueSmtpSender {
  /**
   * Render and send one mail.
   *
   * @param input What the mail is rendered from.
   */
  send(input: GoTrueMailInput): Promise<void>;
}

/**
 * Build the `/auth/v1` SMTP sender for `options`: one {@linkcode smtpMailer} (a connection per
 * message), GoTrue's subjects, and its templates, fetched and cached.
 *
 * @param options The SMTP settings, subjects and templates.
 * @param logger Where template problems are reported.
 * @param fetchImpl `fetch` for the template URLs (tests).
 * @returns The sender.
 */
export function goTrueSmtpSender(
  options: GoTrueSmtpOptions,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): GoTrueSmtpSender {
  const { subjects, templates, ...server } = options;
  const mailer: SmtpMailer = smtpMailer(server);
  const cache = new Map<string, CachedTemplate>();
  const templateFor = (kind: GoTrueMailKind): Promise<string | null> => {
    const url = templates?.[kind];
    if (!url) return Promise.resolve(null);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TEMPLATE_TTL_MS) return hit.body;
    const body = fetchTemplate(url, logger, fetchImpl);
    cache.set(url, { at: Date.now(), body });
    return body;
  };
  return {
    async send(input) {
      const kind = mailKindOf(input.action);
      const custom = await templateFor(kind);
      let html = custom === null ? null : renderGoTrueTemplate(custom, input);
      if (custom !== null && html === null) {
        logger.warn(
          `/auth/v1: the ${kind} template uses template actions beyond the supported ` +
            "placeholders; using the built-in one",
        );
      }
      html ??= renderGoTrueTemplate(DEFAULT_TEMPLATES[kind], input)!;
      await mailer.send({
        to: input.to,
        subject: subjects?.[kind] ?? DEFAULT_SUBJECTS[kind],
        text: plainText(kind, input),
        html,
      });
    },
  };
}
