// A request body read with a ceiling. `request.formData()` reads whatever arrives — a chunked
// upload has no `Content-Length` to refuse up front — so every body the UI and the dashboard
// decode goes through here first: past `max` bytes the read stops and the request is refused.

/** The most a mutation's body may carry: an upload (10 MiB) and its form around it. */
export const UI_MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * The request with its body read whole — or `null` when it carried more than `max` bytes (a
 * `Content-Length` over it is refused before a byte is read).
 *
 * @param request The request.
 * @param max The ceiling, in bytes.
 * @returns A request holding the same headers and the bytes, or `null`.
 */
export async function boundedRequest(request: Request, max: number): Promise<Request | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    await request.body?.cancel().catch(() => {});
    return null;
  }
  if (!request.body) return request;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
}
