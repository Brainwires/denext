// A streaming `multipart/form-data` reader for the Storage API's uploads. supabase-js sends a
// Blob or File as a form whose file part has an EMPTY field name (`name=""`), which the
// platform's `Request.formData()` drops, and a form can be as large as the bucket allows — so
// this reader keeps every part and never holds the file: the small fields before the file
// (`cacheControl`, `metadata`) are read, then the file part's bytes are handed on as a stream
// that ends at the next boundary. The caller's size cap applies to that stream as it flows.

import { StorageError } from "./errors.ts";

/** A form's file part, streamed. */
export interface FormFile {
  /** The field name (supabase-js: `""`). */
  name: string;
  /** The file name, when the part has one. */
  filename?: string;
  /** The part's `Content-Type`, when it has one. */
  contentType?: string;
  /** The file's bytes, up to the next boundary. */
  stream: ReadableStream<Uint8Array>;
}

/** What a form carried: its fields before the file, and the file. */
export interface StreamedForm {
  fields: Map<string, string>;
  file: FormFile | null;
}

/** A field's largest size (the file is not a field). */
const MAX_FIELD = 64 * 1024;
/** A part's headers' largest size. */
const MAX_HEADERS = 16 * 1024;
/** Fields before the file. */
const MAX_FIELDS = 64;

const encoder = new TextEncoder();

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  for (
    let i = haystack.indexOf(first, from);
    i >= 0 && i <= haystack.length - needle.length;
    i = haystack.indexOf(first, i + 1)
  ) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** A `Content-Disposition` (or `Content-Type`) parameter, unquoted. */
function param(header: string, key: string): string | undefined {
  const m = header.match(new RegExp(`(?:^|;)\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, "i")) ??
    header.match(new RegExp(`(?:^|;)\\s*${key}=([^;\\s]*)`, "i"));
  return m ? m[1].replace(/\\(.)/g, "$1") : undefined;
}

const malformed = (why: string) =>
  new StorageError("bad_request", `malformed multipart body: ${why}`);

/** A byte buffer over a stream's reader, read as far as a search needs. */
class Buffered {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  buf: Uint8Array = new Uint8Array(0);
  done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Read one more chunk; `false` at the end of the stream. */
  async more(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.#reader.read();
    if (next.done) {
      this.done = true;
      return false;
    }
    const joined = new Uint8Array(this.buf.length + next.value.length);
    joined.set(this.buf);
    joined.set(next.value, this.buf.length);
    this.buf = joined;
    return true;
  }

  /** Where `needle` is, reading on as needed (at most `max` bytes); -1 when it never comes. */
  async find(needle: Uint8Array, max: number): Promise<number> {
    for (;;) {
      const at = indexOf(this.buf, needle);
      if (at >= 0) return at;
      if (this.buf.length > max + needle.length) throw malformed("a part is too large");
      if (!(await this.more())) return -1;
    }
  }

  /** At least `n` bytes buffered (fewer only at the end). */
  async need(n: number): Promise<void> {
    while (this.buf.length < n && await this.more()) { /* read on */ }
  }

  take(n: number): Uint8Array {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  cancel(reason?: unknown): Promise<void> {
    return this.#reader.cancel(reason).catch(() => {});
  }
}

/** A part's headers: its field name, file name and type. */
function partHeaders(text: string): { name: string; filename?: string; contentType?: string } {
  const out: { name: string; filename?: string; contentType?: string } = { name: "" };
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-type") out.contentType = value;
    if (key !== "content-disposition") continue;
    out.name = param(value, "name") ?? "";
    const filename = param(value, "filename");
    if (filename !== undefined) out.filename = filename;
  }
  return out;
}

/**
 * Read a form up to its file part: the fields before it, and the file as a stream. Fields after
 * the file are not read (supabase-js sends them first).
 *
 * @param body The request body.
 * @param contentType The request's `Content-Type` (it names the boundary).
 * @returns The fields and the file (`null` when the form has none).
 * @throws {StorageError} `bad_request` for a malformed form.
 */
export async function streamMultipart(
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<StreamedForm> {
  const boundary = param(contentType, "boundary");
  if (!boundary || boundary.length > 200) throw malformed("no boundary");
  const opening = encoder.encode(`--${boundary}`);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const input = new Buffered(body);
  const fields = new Map<string, string>();
  const at = await input.find(opening, MAX_HEADERS);
  if (at < 0) throw malformed("no boundary in the body");
  input.take(at + opening.length);
  while (await nextPart(input)) {
    const headers = await readHeaders(input);
    if (headers.filename !== undefined || headers.name === "") {
      return { fields, file: { ...headers, stream: fileStream(input, delimiter) } };
    }
    if (fields.size >= MAX_FIELDS) throw malformed("too many fields");
    fields.set(headers.name, await readField(input, delimiter));
  }
  await input.cancel();
  return { fields, file: null };
}

/** After a delimiter: `true` when a part follows (CRLF), `false` at the closing `--`. */
async function nextPart(input: Buffered): Promise<boolean> {
  await input.need(2);
  if (input.buf[0] === 45 && input.buf[1] === 45) return false;
  if (input.buf[0] !== 13 || input.buf[1] !== 10) throw malformed("bad delimiter");
  input.take(2);
  return true;
}

/** A part's headers (up to the blank line). */
async function readHeaders(input: Buffered) {
  const end = await input.find(encoder.encode("\r\n\r\n"), MAX_HEADERS);
  if (end < 0) throw malformed("unterminated part headers");
  const headers = partHeaders(new TextDecoder().decode(input.take(end)));
  input.take(4);
  return headers;
}

/** A (small) field's value, up to the next delimiter. */
async function readField(input: Buffered, delimiter: Uint8Array): Promise<string> {
  const close = await input.find(delimiter, MAX_FIELD);
  if (close < 0) throw malformed("unterminated part");
  const value = new TextDecoder().decode(input.take(close));
  input.take(delimiter.length);
  return value;
}

/** The file part's bytes: everything up to the next delimiter. */
function fileStream(input: Buffered, delimiter: Uint8Array): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return controller.close();
      for (;;) {
        const at = indexOf(input.buf, delimiter);
        if (at >= 0) {
          if (at > 0) controller.enqueue(input.take(at).slice());
          finished = true;
          await input.cancel();
          return controller.close();
        }
        // Everything but a possible partial delimiter at the end can go.
        const safe = input.buf.length - (delimiter.length - 1);
        if (safe > 0) {
          controller.enqueue(input.take(safe).slice());
          return;
        }
        if (!(await input.more())) {
          return controller.error(malformed("unterminated file part"));
        }
      }
    },
    cancel(reason) {
      return input.cancel(reason);
    },
  });
}
