/**
 * The token an `Authorization: Bearer <token>` header carries — the one parser every bearer
 * credential (native tokens, Supabase access tokens) is read with.
 *
 * @module
 */

/**
 * The bearer token of an `Authorization` header (scheme case-insensitive, token trimmed).
 *
 * @param header The header value.
 * @returns The token, or `undefined` for another scheme or an empty token.
 */
export function bearerTokenOf(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") return undefined;
  return header.slice(space + 1).trim() || undefined;
}
