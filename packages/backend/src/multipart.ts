// A small `multipart/form-data` reader for the Storage API's uploads. supabase-js sends a Blob or
// File as a form whose file part has an EMPTY field name (`name=""`), which the platform's
// `Request.formData()` drops; this reader keeps every part. It works on a body already read
// (and capped) into memory.

import { StorageError } from "./errors.ts";

/** One part of a form. */
export interface FormPart {
  /** The field name (may be `""`). */
  name: string;
  /** The file name, for a file part. */
  filename?: string;
  /** The part's `Content-Type`, when it has one. */
  contentType?: string;
  /** The part's bytes. */
  body: Uint8Array;
}

const CRLF = new Uint8Array([13, 10]);

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** A `Content-Disposition` parameter (`name="x"`), unquoted. */
function param(header: string, key: string): string | undefined {
  const m = header.match(new RegExp(`(?:^|;)\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, "i")) ??
    header.match(new RegExp(`(?:^|;)\\s*${key}=([^;\\s]*)`, "i"));
  return m ? m[1].replace(/\\(.)/g, "$1") : undefined;
}

/**
 * Parse a `multipart/form-data` body.
 *
 * @param bytes The body.
 * @param contentType The request's `Content-Type` (it names the boundary).
 * @returns The parts, in order.
 * @throws {StorageError} `bad_request` for a malformed body.
 */
export function parseMultipart(bytes: Uint8Array, contentType: string): FormPart[] {
  const boundary = param(contentType, "boundary");
  if (!boundary || boundary.length > 200) {
    throw new StorageError("bad_request", "multipart body without a boundary");
  }
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const parts: FormPart[] = [];
  let at = indexOf(bytes, delimiter, 0);
  if (at < 0) throw new StorageError("bad_request", "malformed multipart body");
  for (;;) {
    at += delimiter.length;
    if (bytes[at] === 45 && bytes[at + 1] === 45) return parts; // `--`: the closing delimiter
    if (bytes[at] !== 13 || bytes[at + 1] !== 10) {
      throw new StorageError("bad_request", "malformed multipart body");
    }
    const { part, end } = readPart(bytes, at + 2, delimiter);
    parts.push(part);
    at = end + 2;
  }
}

/** One part starting at `at` (its headers): the part, and where its closing CRLF is. */
function readPart(
  bytes: Uint8Array,
  at: number,
  delimiter: Uint8Array,
): { part: FormPart; end: number } {
  const headerEnd = indexOf(bytes, new TextEncoder().encode("\r\n\r\n"), at);
  if (headerEnd < 0) throw new StorageError("bad_request", "malformed multipart part");
  const end = indexOf(bytes, new Uint8Array([...CRLF, ...delimiter]), headerEnd + 4);
  if (end < 0) throw new StorageError("bad_request", "unterminated multipart part");
  const part: FormPart = { name: "", body: bytes.subarray(headerEnd + 4, end) };
  const headers = new TextDecoder().decode(bytes.subarray(at, headerEnd)).split("\r\n");
  for (const line of headers) applyHeader(part, line);
  return { part, end };
}

/** Record a part header's name, file name or content type. */
function applyHeader(part: FormPart, line: string): void {
  const colon = line.indexOf(":");
  const key = line.slice(0, colon).trim().toLowerCase();
  const value = line.slice(colon + 1).trim();
  if (key === "content-type") part.contentType = value;
  if (key !== "content-disposition") return;
  part.name = param(value, "name") ?? "";
  const filename = param(value, "filename");
  if (filename !== undefined) part.filename = filename;
}
