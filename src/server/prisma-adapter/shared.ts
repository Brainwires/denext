/**
 * Helpers both drivers of the Prisma adapter share: date formatting, base64, error fields.
 *
 * @module
 */

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `YYYY-MM-DD` of a date in UTC. */
export function formatUtcDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `HH:MM:SS[.mmm]` of a date in UTC. */
export function formatUtcTime(d: Date): string {
  const ms = d.getUTCMilliseconds();
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return ms ? `${hms}.${pad(ms, 3)}` : hms;
}

/** `YYYY-MM-DD HH:MM:SS[.mmm]` of a date in UTC. */
export function formatUtcDateTime(d: Date): string {
  return `${formatUtcDate(d)} ${formatUtcTime(d)}`;
}

/** The bytes of a base64 string (how Prisma sends a `Bytes` argument). */
export function base64Bytes(text: string): Uint8Array {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A database error's object, `code` and message, or null when `error` has no string code. */
export function errorFields(
  error: unknown,
): { e: Record<string, unknown>; code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as Record<string, unknown>;
  if (typeof e.code !== "string") return null;
  return { e, code: e.code, message: typeof e.message === "string" ? e.message : String(e.code) };
}
