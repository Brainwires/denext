// A request body as text, capped while it streams: shared by the endpoints that take a small
// JSON body from a page (the dev server's DevTools sink, the Deno Desktop bridge's RPC).

/**
 * The body as text, or `null` once it passes `max` bytes — counted while it streams, so a body
 * without (or lying about) `content-length` is cut off at the cap instead of buffered whole.
 *
 * @param request The request whose body to read.
 * @param max The most bytes accepted.
 * @returns The decoded body (`""` when there is none), or `null` past the cap.
 */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
