// Bounded request-body reading, shared by every server entry point that buffers a body
// (Server Actions, the soft-navigation POST echo, plugin API routes).

/** Sentinel returned by {@linkcode readCappedBody} when the body exceeds the cap. */
export const TOO_LARGE = Symbol("too_large");
/** Sentinel returned by {@linkcode readCappedBody} when the body stalls (idle). */
export const STALLED = Symbol("stalled");

/**
 * Max time (ms) a single body chunk may take to arrive before the read is aborted.
 * Defends against a trickled / never-closed body pinning a handler under the size
 * cap ("denial of wallet", CVE-2024-56332). A legitimate client streams
 * continuously; this bounds only pathological inactivity.
 */
const DEFAULT_BODY_IDLE_TIMEOUT = 30_000;

/**
 * Read a request body into memory, refusing anything over `maxBytes` (hard-caps
 * even a chunked body with no Content-Length) and aborting a body that stalls for
 * longer than `idleMs`. Returns the bytes, {@linkcode TOO_LARGE}, or
 * {@linkcode STALLED}.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number,
  idleMs: number = DEFAULT_BODY_IDLE_TIMEOUT,
): Promise<Uint8Array | typeof TOO_LARGE | typeof STALLED> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof STALLED>((resolve) => {
      timer = setTimeout(() => resolve(STALLED), idleMs);
    });
    const step = await Promise.race([reader.read(), idle]);
    clearTimeout(timer);
    if (step === STALLED) {
      await reader.cancel().catch(() => {});
      return STALLED;
    }
    const { done, value } = step;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Rebuild a request from already-buffered body bytes (headers/method preserved). */
export function bufferedRequest(request: Request, body: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: body.byteLength > 0 ? (body as BodyInit) : undefined,
  });
}

/**
 * `request` with its body wrapped so that reading past `maxBytes` errors the stream (the
 * consumer — `formData()`, `json()`, a multipart parser — then throws). For streaming
 * consumers that cannot use {@linkcode readCappedBody}; a declared `content-length` over the
 * cap is refused up front.
 */
export function cappedBody(request: Request, maxBytes: number): Request {
  if (!request.body) return request;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new BodyTooLarge(maxBytes);
  let total = 0;
  const limited = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) controller.error(new BodyTooLarge(maxBytes));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: limited,
    // @ts-ignore duplex is required by the spec for streaming bodies (Deno accepts it)
    duplex: "half",
  });
}

/** Thrown (as a stream error) by {@linkcode cappedBody} when a body exceeds its cap. */
class BodyTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLarge";
  }
}
