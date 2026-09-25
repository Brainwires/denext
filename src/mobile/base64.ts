/**
 * Internal byte helpers the `denext/mobile` file capabilities share (filesystem, pickers):
 * base64 in both directions and the "did the user dismiss it" test for plugin rejections.
 * Not re-exported from `denext/mobile`.
 *
 * @module
 */

/** Standard (padded) base64 of `bytes`, encoded in chunks so large files do not overflow. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The bytes of standard base64 (a `data:` URL prefix, if any, is dropped). */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/^data:[^,]*,/, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64 of a `Blob`'s bytes. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * Whether a plugin rejection is the user dismissing its UI: a message that says "cancel"
 * (`User cancelled photos app`, `pickFiles canceled.`) or one of the `codes` given.
 */
export function isDismissal(err: unknown, codes: readonly string[] = []): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { message, code } = err as { message?: unknown; code?: unknown };
  return (typeof code === "string" && codes.includes(code)) ||
    (typeof message === "string" && /cancel/i.test(message));
}
