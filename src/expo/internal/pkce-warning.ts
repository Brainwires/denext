// The expo-web-browser shim's PKCE waiver: denext's own `openAuthSession` requires PKCE S256, while
// `openAuthSessionAsync` (and an `AuthRequest` with `usePKCE: false`) does not, so a URL without
// it keeps working through the shim, with a one-time warning that names the risk.

/** Whether `url` carries a PKCE S256 challenge (`code_challenge` + `code_challenge_method=S256`). */
export function hasPkce(url: string): boolean {
  try {
    const params = new URL(url).searchParams;
    return params.has("code_challenge") && params.get("code_challenge_method") === "S256";
  } catch {
    return false; // openAuthSession reports the malformed URL itself
  }
}

/** Whether the missing-PKCE warning has been shown this page (once is enough). */
let warned = false;

/** Re-arm the once-per-page warning. Test seam. */
export function resetPkceWarningForTesting(): void {
  warned = false;
}

/** Warn ONCE that an auth session runs without PKCE, and what that risks. */
export function warnWithoutPkce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "denext: openAuthSessionAsync is signing in WITHOUT PKCE (an AuthRequest with usePKCE: " +
      "false, or a URL with no code_challenge). Another app that registers the same callback " +
      "scheme can receive the redirect and redeem the authorization code, signing in as the " +
      "user. Use PKCE (usePKCE: true, Expo's default) unless the provider binds the code to " +
      "this client another way.",
  );
}
