/**
 * The message half of {@link ./smtp.ts | smtpMailer}: address validation, header encoding
 * (RFC 5322 / RFC 2047), a `quoted-printable` body (RFC 2045 §6.7) and the DATA payload with
 * dot-stuffing (RFC 5321 §4.5.2). Pure functions: nothing here touches the network.
 *
 * Every value that lands in a header is refused when it carries a CR, an LF or a NUL, so an
 * address, a display name or a subject taken from user input can never add a header (`Bcc:`)
 * or end the header block early. Addresses are checked against a conservative ASCII grammar —
 * no SMTPUTF8, no quoted local parts, no comments, no IP literals — which every mail server
 * accepts and which leaves no room for a second recipient (`a@x.test, b@y.test`) or a smuggled
 * SMTP argument (`a@x.test> NOTIFY=…`).
 *
 * @module
 */

/** Why a message can't be built. */
export class SmtpMessageError extends Error {
  /** Builds the error. */
  constructor(message: string) {
    super(message);
    this.name = "SmtpMessageError";
  }
}

/** A mailbox: an address and an optional display name. */
export interface Mailbox {
  /** The address (`ada@example.com`). */
  address: string;
  /** The display name, if any. */
  name?: string;
}

/** One outbound message. */
export interface MailMessage {
  /** The single recipient's address. */
  to: string;
  /** The subject (any Unicode; non-ASCII is RFC 2047-encoded). */
  subject: string;
  /** The plain-text body. */
  text: string;
  /** An HTML alternative, sent next to `text` as `multipart/alternative`. */
  html?: string;
  /** `Reply-To`, an address. */
  replyTo?: string;
}

/** A conservative dot-atom address: ASCII, a dotted domain, no quoting or literals. */
const ADDRESS = new RegExp(
  "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*" +
    "@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$",
);

/**
 * Refuse a header value that could add a header or end the header block.
 *
 * @param value The value.
 * @param what What it is, for the error.
 * @returns The value.
 * @throws {SmtpMessageError} On a CR, an LF or a NUL.
 */
export function headerSafe(value: string, what: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new SmtpMessageError(`smtpMailer: the ${what} contains a line break`);
  }
  return value;
}

/**
 * Validate an address.
 *
 * @param value The address.
 * @param what What it is, for the error.
 * @returns The address.
 * @throws {SmtpMessageError} When it is not a plain `local@domain.tld` address.
 */
export function validAddress(value: string, what: string): string {
  headerSafe(value, what);
  const at = value.lastIndexOf("@");
  if (
    value.length > 254 || at < 1 || at > 64 || !ADDRESS.test(value)
  ) {
    throw new SmtpMessageError(`smtpMailer: the ${what} is not a valid email address`);
  }
  return value;
}

/**
 * Parse a `from` setting: `ada@example.com` or `Ada Lovelace <ada@example.com>`.
 *
 * @param value The setting.
 * @returns The mailbox.
 * @throws {SmtpMessageError} When it is neither.
 */
export function parseMailbox(value: string): Mailbox {
  headerSafe(value, "sender");
  const angled = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  if (!angled) return { address: validAddress(value.trim(), "sender") };
  const name = angled[1].replace(/^"(.*)"$/, "$1").trim();
  const address = validAddress(angled[2].trim(), "sender");
  return name ? { address, name } : { address };
}

/** Whether a string is printable ASCII (space through `~`). */
function printableAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** The bytes of `value` as base64. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The most UTF-8 bytes one encoded-word carries (45 bytes → 60 base64 chars, 72 in all). */
const WORD_BYTES = 45;

/**
 * RFC 2047 `B` encoded-words for a header value that isn't plain ASCII, split on code-point
 * boundaries so no word cuts a character, and folded onto continuation lines.
 *
 * @param value The header value (already checked for line breaks).
 * @returns The value as is when it is printable ASCII, else its encoded-words.
 */
export function encodeHeaderText(value: string): string {
  if (printableAscii(value)) return value;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (encoder.encode(chunk + char).length > WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`).join("\r\n ");
}

/**
 * A mailbox as a header value: `"Name" <address>`, the name quoted (or encoded when it isn't
 * ASCII).
 *
 * @param mailbox The mailbox.
 * @returns The header value.
 */
function formatMailbox(mailbox: Mailbox): string {
  if (!mailbox.name) return mailbox.address;
  const name = headerSafe(mailbox.name, "display name");
  const shown = printableAscii(name)
    ? `"${name.replace(/(["\\])/g, "\\$1")}"`
    : encodeHeaderText(name);
  return `${shown} <${mailbox.address}>`;
}

/** The hex digits quoted-printable uses. */
const HEX = "0123456789ABCDEF";

/** One byte as `=XX`. */
function qpEscape(byte: number): string {
  return `=${HEX[byte >> 4]}${HEX[byte & 15]}`;
}

/** Whether a byte may stand for itself in quoted-printable (`=` never; space/tab mid-line). */
function qpLiteral(byte: number): boolean {
  return (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9;
}

/** Encode one line (no line break in it) as quoted-printable, with soft breaks at 76 columns. */
function qpLine(bytes: Uint8Array): string {
  const out: string[] = [];
  let line = "";
  bytes.forEach((byte, i) => {
    const last = i === bytes.length - 1;
    // Trailing whitespace would be stripped in transit: escape it.
    const token = qpLiteral(byte) && !(last && (byte === 32 || byte === 9))
      ? String.fromCharCode(byte)
      : qpEscape(byte);
    if (line.length + token.length > 75) {
      out.push(line + "=");
      line = "";
    }
    line += token;
  });
  out.push(line);
  return out.join("\r\n");
}

/**
 * A body as `quoted-printable`, its line breaks normalised to CRLF.
 *
 * @param text The body.
 * @returns The encoded body.
 */
export function quotedPrintable(text: string): string {
  const encoder = new TextEncoder();
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => qpLine(encoder.encode(line)))
    .join("\r\n");
}

/**
 * Dot-stuff a DATA payload (RFC 5321 §4.5.2): a line that starts with `.` gets another, so no
 * line of the message can end the transfer early.
 *
 * @param payload The CRLF-separated payload.
 * @returns The stuffed payload.
 */
export function dotStuff(payload: string): string {
  return payload.replace(/(^|\r\n)\./g, "$1..");
}

/** A part's headers and body. */
function part(type: string, body: string): string {
  return `Content-Type: ${type}; charset=utf-8\r\n` +
    "Content-Transfer-Encoding: quoted-printable\r\n\r\n" + quotedPrintable(body);
}

/** Random hex, for the boundary and the Message-ID. */
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => HEX[b >> 4] + HEX[b & 15])
    .join("").toLowerCase();
}

/**
 * The full RFC 5322 message: headers, then a `text/plain` body or a `multipart/alternative`
 * of the text and the HTML. Every header value is checked; the result is CRLF-separated but
 * not yet dot-stuffed.
 *
 * @param from The sender.
 * @param message The message.
 * @param now The `Date` header's time.
 * @returns The message.
 * @throws {SmtpMessageError} On an invalid address or a header value with a line break.
 */
export function buildMessage(from: Mailbox, message: MailMessage, now = new Date()): string {
  const to = validAddress(message.to, "recipient");
  const subject = encodeHeaderText(headerSafe(message.subject, "subject"));
  const domain = from.address.slice(from.address.lastIndexOf("@") + 1);
  const headers = [
    `From: ${formatMailbox(from)}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomHex(16)}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  if (message.replyTo) headers.push(`Reply-To: ${validAddress(message.replyTo, "reply-to")}`);
  if (message.html === undefined) {
    return `${headers.join("\r\n")}\r\n${part("text/plain", message.text)}`;
  }
  const boundary = `=_denext_${randomHex(12)}`;
  return `${headers.join("\r\n")}\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n${part("text/plain", message.text)}\r\n` +
    `--${boundary}\r\n${part("text/html", message.html)}\r\n` +
    `--${boundary}--`;
}
