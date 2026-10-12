// Byte-stream helpers: turn an upload body into a stream, peek its first bytes for sniffing
// without losing them, and cap how many bytes may flow.

import { StorageError } from "./errors.ts";
import type { UploadBody } from "./types.ts";

/**
 * An upload body as a stream, with its size when the body knows it.
 *
 * @param body Bytes, a Blob, text or a stream.
 * @returns The stream and its known size.
 */
export function toStream(body: UploadBody): { stream: ReadableStream<Uint8Array>; size?: number } {
  if (body instanceof ReadableStream) return { stream: body };
  if (body instanceof Blob) return { stream: body.stream(), size: body.size };
  const bytes = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body instanceof Uint8Array
    ? body
    : new Uint8Array(body);
  return {
    stream: new ReadableStream({
      start(controller) {
        if (bytes.byteLength) controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: bytes.byteLength,
  };
}

/**
 * Read at least `n` bytes from the front of `stream` (fewer only when it ends first), and
 * return them with a stream that replays them followed by the rest.
 *
 * @param stream The source.
 * @param n How many bytes to peek.
 * @returns The peeked bytes and the whole stream.
 */
export async function peek(
  stream: ReadableStream<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let done = false;
  while (got < n) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    got += next.value.byteLength;
  }
  const head = concat(chunks, got);
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head: head.subarray(0, n), stream: replay };
}

/**
 * Join chunks into one buffer.
 *
 * @param chunks The chunks.
 * @param total Their total length.
 * @returns The bytes.
 */
export function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Cap a stream: it errors with `too_large` once more than `max` bytes flow, and — when `exact`
 * is given — with `bad_request` when it ends at any other length.
 *
 * @param stream The source.
 * @param max The cap.
 * @param exact The exact length required, if any.
 * @returns The capped stream.
 */
export function limit(
  stream: ReadableStream<Uint8Array>,
  max: number,
  exact?: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) {
          controller.error(new StorageError("too_large", `object exceeds ${max} bytes`));
        } else controller.enqueue(chunk);
      },
      flush(controller) {
        if (exact !== undefined && total !== exact) {
          controller.error(
            new StorageError("bad_request", `body is ${total} bytes, ${exact} were declared`),
          );
        }
      },
    }),
  );
}

/**
 * Read a whole stream into memory, refusing more than `max` bytes.
 *
 * @param stream The source.
 * @param max The cap.
 * @returns The bytes.
 */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of limit(stream, max)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return concat(chunks, total);
}
