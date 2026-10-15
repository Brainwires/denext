/**
 * `smtpMailer()`: a zero-dependency SMTP client (RFC 5321) on `Deno.connect` /
 * `Deno.connectTls` / `Deno.startTls`, shaped as a {@link SendVerificationRequest} so it plugs
 * straight into `denextAuth({ sendVerificationRequest })`, with `send()` for any other message.
 *
 * - **TLS is required.** Port 465 (or `secure: true`) is implicit TLS; any other port speaks
 *   plain SMTP only until `STARTTLS`, which the server must offer and which must succeed, or
 *   nothing is sent. Bytes the server sent after its `220` to `STARTTLS` (a man-in-the-middle
 *   injecting replies into the plaintext phase) abort the send. Plaintext needs an explicit
 *   `insecure: true`, and is refused for any host that isn't loopback.
 * - **AUTH** `PLAIN` (preferred) or `LOGIN`, only ever over TLS (or loopback plaintext).
 * - **One connection per message**, closed after it: nothing — no socket, no authenticated
 *   state — is shared between two sends, so one tenant's mail never rides another's session.
 * - **Every step is timed** (`timeoutMs`, default 10 s, for the connect, the TLS handshake,
 *   each reply and each write); a reply larger than 64 KiB is refused.
 * - Messages are built by {@link ./smtp-message.ts}: CR/LF in any header value is refused,
 *   addresses are validated, non-ASCII subjects are RFC 2047-encoded, and the DATA payload is
 *   dot-stuffed.
 *
 * Neither the password nor the message is ever logged; an error names the step and the
 * server's reply code.
 *
 * @module
 */

import {
  buildMessage,
  dotStuff,
  headerSafe,
  type Mailbox,
  type MailMessage,
  parseMailbox,
  validAddress,
} from "./smtp-message.ts";
import type { SendVerificationRequest, VerificationRequestParams } from "./types.ts";

export { type MailMessage, SmtpMessageError } from "./smtp-message.ts";

/** Options for {@linkcode smtpMailer}. */
export interface SmtpMailerOptions {
  /** The SMTP server's host name (also the name its certificate must carry). */
  host: string;
  /** The port. Default `465` with `secure`, else `587`. */
  port?: number;
  /**
   * Implicit TLS from the first byte (SMTPS). Default: `true` on port 465, else `false` —
   * STARTTLS, which is then required.
   */
  secure?: boolean;
  /** The user to authenticate as (`AUTH PLAIN` / `LOGIN`); give `pass` with it. */
  user?: string;
  /** The password. */
  pass?: string;
  /** The sender: `noreply@example.com` or `Example <noreply@example.com>`. */
  from: string;
  /**
   * Send in plaintext, without STARTTLS — only to a loopback host (`localhost`, `127.0.0.1`,
   * `::1`), e.g. a local mail catcher. Refused for any other host.
   */
  insecure?: boolean;
  /** How long each step may take, in milliseconds. Default `10000`. */
  timeoutMs?: number;
  /** The name sent with `EHLO`. Default `"localhost"`. */
  clientName?: string;
  /** Extra trusted CA certificates (PEM), for a server with a private CA. */
  caCerts?: string[];
  /**
   * Shape the mail for one verification token: subject, text and an optional HTML part.
   * Default: a short English message per purpose.
   */
  render?: (params: VerificationRequestParams) => SmtpContent;
}

/** What {@linkcode SmtpMailerOptions.render} returns. */
export interface SmtpContent {
  /** The subject. */
  subject: string;
  /** The plain-text body. */
  text: string;
  /** An HTML alternative. */
  html?: string;
}

/** A configured mailer: a `sendVerificationRequest`, and `send()` for any message. */
export interface SmtpMailer extends SendVerificationRequest {
  /**
   * Send one message over its own connection.
   *
   * @param message The recipient, subject and body.
   * @throws {SmtpError} When the server refuses or a step times out.
   * @throws {SmtpMessageError} When an address or a header value is invalid.
   */
  send(message: MailMessage): Promise<void>;
}

/** Why a send failed: the step, and the server's reply code when it answered. */
export class SmtpError extends Error {
  /** The SMTP reply code, when the server answered (`535`, `550`, …). */
  readonly code?: number;
  /** Builds the error. */
  constructor(message: string, code?: number) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
  }
}

/** The resolved settings. */
interface Settings {
  host: string;
  port: number;
  secure: boolean;
  insecure: boolean;
  auth?: { user: string; pass: string };
  from: Mailbox;
  timeoutMs: number;
  clientName: string;
  caCerts?: string[];
}

/** The largest reply accepted, in bytes (a hostile server can't make us buffer more). */
const MAX_REPLY_BYTES = 64 * 1024;

/** Whether `host` is a loopback name or address. */
function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

/** The host, trimmed; refused when empty or holding whitespace. */
function hostOf(options: SmtpMailerOptions): string {
  const host = typeof options.host === "string" ? options.host.trim() : "";
  if (!host || /[\s\0]/.test(host)) throw new TypeError("smtpMailer: `host` is required");
  return host;
}

/** The port: given, or 465 for implicit TLS and 587 for STARTTLS. */
function portOf(options: SmtpMailerOptions, secure: boolean): number {
  const port = options.port ?? (secure ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("smtpMailer: `port` must be an integer from 1 to 65535");
  }
  return port;
}

/** `insecure`, allowed only to a loopback host and never with `secure`. */
function insecureOf(options: SmtpMailerOptions, host: string, secure: boolean): boolean {
  if (options.insecure !== true) return false;
  if (secure || !isLoopback(host)) {
    throw new TypeError(
      "smtpMailer: `insecure: true` (plaintext) is only allowed to a loopback host, without " +
        "`secure` — mail to any other server goes over TLS",
    );
  }
  return true;
}

/** The credentials, given together or not at all. */
function authOf(options: SmtpMailerOptions): { auth?: { user: string; pass: string } } {
  if ((options.user === undefined) !== (options.pass === undefined)) {
    throw new TypeError("smtpMailer: give `user` and `pass` together");
  }
  return options.user === undefined ? {} : { auth: { user: options.user, pass: options.pass! } };
}

/** The EHLO name: a host name. */
function clientNameOf(options: SmtpMailerOptions): string {
  const clientName = headerSafe(options.clientName ?? "localhost", "client name");
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(clientName)) {
    throw new TypeError("smtpMailer: `clientName` must be a host name");
  }
  return clientName;
}

/** The step timeout, positive. */
function timeoutOf(options: SmtpMailerOptions): number {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!(timeoutMs > 0)) throw new TypeError("smtpMailer: `timeoutMs` must be positive");
  return timeoutMs;
}

/** Validate the options once, at construction, so a misconfiguration fails at startup. */
function resolveSettings(options: SmtpMailerOptions): Settings {
  const host = hostOf(options);
  const secure = options.secure ?? options.port === 465;
  return {
    host,
    port: portOf(options, secure),
    secure,
    insecure: insecureOf(options, host, secure),
    ...authOf(options),
    from: parseMailbox(options.from),
    timeoutMs: timeoutOf(options),
    clientName: clientNameOf(options),
    ...(options.caCerts ? { caCerts: options.caCerts } : {}),
  };
}

/** A parsed reply: its code and its lines' text. */
interface Reply {
  code: number;
  lines: string[];
}

/** UTF-8 → base64, for AUTH. */
function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** One SMTP session over one connection. */
class SmtpSession {
  #conn: Deno.Conn;
  #buffer = new Uint8Array(0);
  readonly #timeoutMs: number;

  constructor(conn: Deno.Conn, timeoutMs: number) {
    this.#conn = conn;
    this.#timeoutMs = timeoutMs;
  }

  /** Run `work` under the step timeout; on expiry the connection is closed and the step fails. */
  async #timed<T>(step: string, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.close();
        reject(new SmtpError(`smtpMailer: ${step} timed out`));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read one complete (possibly multi-line) reply. */
  async read(step: string): Promise<Reply> {
    return await this.#timed(step, this.#readReply(step));
  }

  async #readReply(step: string): Promise<Reply> {
    const lines: string[] = [];
    // The whole reply, every line of it, is capped — not each line alone.
    for (let size = 0; size <= MAX_REPLY_BYTES;) {
      const line = await this.#readLine(step);
      const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!match) throw new SmtpError(`smtpMailer: ${step}: malformed reply`);
      lines.push(match[3]);
      if (match[2] !== "-") return { code: Number(match[1]), lines };
      size += line.length + 2;
    }
    throw new SmtpError(`smtpMailer: ${step}: reply too long`);
  }

  async #readLine(step: string): Promise<string> {
    for (;;) {
      const end = this.#buffer.indexOf(10);
      if (end >= 0) {
        const line = new TextDecoder().decode(this.#buffer.subarray(0, end)).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(end + 1);
        return line;
      }
      if (this.#buffer.length > MAX_REPLY_BYTES) {
        throw new SmtpError(`smtpMailer: ${step}: reply too long`);
      }
      const chunk = new Uint8Array(4096);
      const n = await this.#conn.read(chunk);
      if (n === null) throw new SmtpError(`smtpMailer: ${step}: the server closed the connection`);
      const next = new Uint8Array(this.#buffer.length + n);
      next.set(this.#buffer);
      next.set(chunk.subarray(0, n), this.#buffer.length);
      this.#buffer = next;
    }
  }

  /** Whether bytes the server sent are still unread (refused before a TLS upgrade). */
  get pending(): boolean {
    return this.#buffer.length > 0;
  }

  /** Write raw text. */
  async write(step: string, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    await this.#timed(
      step,
      (async () => {
        for (let written = 0; written < bytes.length;) {
          written += await this.#conn.write(bytes.subarray(written));
        }
      })(),
    );
  }

  /** Send a command line and read its reply, which must carry one of `expect`. */
  async command(step: string, line: string, expect: readonly number[]): Promise<Reply> {
    await this.write(step, `${line}\r\n`);
    return expectReply(step, await this.read(step), expect);
  }

  /** Swap the transport for its TLS upgrade. */
  async upgrade(settings: Settings): Promise<void> {
    this.#conn = await this.#timed(
      "the TLS handshake",
      Deno.startTls(this.#conn as Deno.TcpConn, {
        hostname: settings.host,
        ...(settings.caCerts ? { caCerts: settings.caCerts } : {}),
      }).then(async (tls) => {
        await tls.handshake();
        return tls;
      }),
    );
  }

  close(): void {
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
  }
}

/** The reply, when its code is one of `expect`; else a refusal naming the step. */
function expectReply(step: string, reply: Reply, expect: readonly number[]): Reply {
  if (expect.includes(reply.code)) return reply;
  throw new SmtpError(`smtpMailer: ${step} was refused (${reply.code})`, reply.code);
}

/** The extensions an EHLO reply advertised, upper-cased (`STARTTLS`, `AUTH PLAIN LOGIN`, …). */
function extensionsOf(reply: Reply): string[] {
  return reply.lines.slice(1).map((line) => line.trim().toUpperCase());
}

/** `EHLO`, returning the advertised extensions. */
async function ehlo(session: SmtpSession, settings: Settings): Promise<string[]> {
  return extensionsOf(await session.command("EHLO", `EHLO ${settings.clientName}`, [250]));
}

/** Open the connection: implicit TLS, or plain TCP (upgraded later). */
async function connect(settings: Settings): Promise<Deno.Conn> {
  const target = { hostname: settings.host, port: settings.port };
  const opening = settings.secure
    ? Deno.connectTls({
      ...target,
      ...(settings.caCerts ? { caCerts: settings.caCerts } : {}),
    }).then(async (tls) => {
      await tls.handshake();
      return tls;
    })
    : Deno.connect(target);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SmtpError("smtpMailer: connecting timed out")),
      settings.timeoutMs,
    );
  });
  try {
    return await Promise.race([opening, expired]);
  } catch (error) {
    // A connection that opens after the timeout is closed, not leaked.
    opening.then((conn) => conn.close(), () => {});
    if (error instanceof SmtpError) throw error;
    throw new SmtpError(`smtpMailer: connecting to the server failed (${(error as Error).name})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upgrade with STARTTLS unless the connection is already TLS (or plaintext was allowed),
 * returning the extensions the server advertises over the secured session.
 */
async function secure(
  session: SmtpSession,
  settings: Settings,
  extensions: string[],
): Promise<string[]> {
  if (settings.secure || settings.insecure) return extensions;
  if (!extensions.includes("STARTTLS")) {
    throw new SmtpError(
      "smtpMailer: the server does not offer STARTTLS; refusing to send in plaintext",
    );
  }
  await session.command("STARTTLS", "STARTTLS", [220]);
  // Anything already buffered was sent in plaintext before the handshake: an injection.
  if (session.pending) throw new SmtpError("smtpMailer: unexpected data before the TLS handshake");
  await session.upgrade(settings);
  return await ehlo(session, settings);
}

/** Authenticate with PLAIN, else LOGIN — whichever the server offers. */
async function authenticate(
  session: SmtpSession,
  auth: { user: string; pass: string },
  extensions: string[],
): Promise<void> {
  const mechanisms = extensions.find((e) => /^AUTH[ =]/.test(e))?.slice(5).split(/\s+/) ?? [];
  if (mechanisms.includes("PLAIN")) {
    const token = base64Utf8(`\0${auth.user}\0${auth.pass}`);
    await session.command("AUTH PLAIN", `AUTH PLAIN ${token}`, [235]);
    return;
  }
  if (mechanisms.includes("LOGIN")) {
    await session.command("AUTH LOGIN", "AUTH LOGIN", [334]);
    await session.command("AUTH LOGIN", base64Utf8(auth.user), [334]);
    await session.command("AUTH LOGIN", base64Utf8(auth.pass), [235]);
    return;
  }
  throw new SmtpError("smtpMailer: the server offers neither AUTH PLAIN nor AUTH LOGIN");
}

/** A message ready for the wire: its validated recipient and its dot-stuffed payload. */
interface Prepared {
  to: string;
  payload: string;
}

/** Run one transaction: greeting, EHLO, TLS, AUTH, envelope, DATA, QUIT. */
async function transact(session: SmtpSession, settings: Settings, { to, payload }: Prepared) {
  expectReply("the greeting", await session.read("the greeting"), [220]);
  const extensions = await secure(session, settings, await ehlo(session, settings));
  if (settings.auth) await authenticate(session, settings.auth, extensions);
  await session.command("MAIL FROM", `MAIL FROM:<${settings.from.address}>`, [250]);
  await session.command("RCPT TO", `RCPT TO:<${to}>`, [250, 251]);
  await session.command("DATA", "DATA", [354]);
  await session.write("DATA", `${payload}\r\n.\r\n`);
  expectReply("the message", await session.read("the message"), [250]);
  await session.command("QUIT", "QUIT", [221]).catch(() => {});
}

/** Minutes until `expiresAt` (epoch seconds), at least 1. */
function minutesLeft(expiresAt: number): number {
  return Math.max(1, Math.round((expiresAt - Date.now() / 1000) / 60));
}

/** The default mail for each verification purpose. */
function defaultVerificationContent(params: VerificationRequestParams): SmtpContent {
  const minutes = minutesLeft(params.expiresAt);
  const expiry = `It expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  const ignore = "If you didn't ask for this, you can ignore this email.";
  switch (params.purpose) {
    case "otp":
      return {
        subject: "Your sign-in code",
        text: `Your sign-in code is ${params.token}\n\n${expiry} ${ignore}\n`,
      };
    case "magic":
      return {
        subject: "Your sign-in link",
        text: `Open this link to sign in:\n\n${params.url}\n\n${expiry} ${ignore}\n`,
      };
    case "reset":
      return {
        subject: "Reset your password",
        text: `Open this link to choose a new password:\n\n${params.url}\n\n${expiry} ${ignore}\n`,
      };
    default:
      return {
        subject: "Confirm your email address",
        text:
          `Open this link to confirm your email address:\n\n${params.url}\n\n${expiry} ${ignore}\n`,
      };
  }
}

/**
 * Send one message with the resolved settings, over a connection of its own.
 *
 * @param settings The resolved settings.
 * @param message The message.
 */
async function sendWith(settings: Settings, message: MailMessage): Promise<void> {
  // Built (and every header value checked) before connecting: a refused message costs nothing.
  const prepared: Prepared = {
    to: validAddress(message.to, "recipient"),
    payload: dotStuff(buildMessage(settings.from, message)),
  };
  const session = new SmtpSession(await connect(settings), settings.timeoutMs);
  try {
    await transact(session, settings, prepared);
  } finally {
    session.close();
  }
}

/**
 * A mailer over SMTP: pass it as `denextAuth({ sendVerificationRequest: smtpMailer({ … }) })`,
 * and every verification email, password reset, magic link and one-time code goes out through
 * it; `mailer.send({ to, subject, text, html? })` sends anything else.
 *
 * ```ts
 * denextAuth({
 *   sendVerificationRequest: smtpMailer({
 *     host: "smtp.example.com", // port 587 + STARTTLS by default; 465 is implicit TLS
 *     user: Deno.env.get("SMTP_USER")!,
 *     pass: Deno.env.get("SMTP_PASS")!,
 *     from: "Example <noreply@example.com>",
 *   }),
 * });
 * ```
 *
 * @param options The server, the credentials, the sender and the TLS policy.
 * @returns The mailer.
 * @throws {TypeError} For an invalid setting (checked here, not at the first send).
 */
export function smtpMailer(options: SmtpMailerOptions): SmtpMailer {
  const settings = resolveSettings(options);
  const render = options.render ?? defaultVerificationContent;
  const send = (message: MailMessage) => sendWith(settings, message);
  const mailer = (async (params: VerificationRequestParams) => {
    await send({ to: params.identifier, ...render(params) });
  }) as SmtpMailer;
  mailer.send = send;
  return mailer;
}
