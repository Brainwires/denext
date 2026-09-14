import { redirect } from "denext";
import { auth, type PageProps, pendingMfaSession } from "denext/server";
import { safeCallback } from "../../lib/callback.ts";
import { ErrorNote } from "../error-note.tsx";

// `pages.mfa`: a sign-in by a user with a confirmed TOTP factor stops here. The first
// factor (a password, a magic link) minted a PENDING session — `auth()` reads it as signed
// out, so middleware and every page still refuse it — and only `pendingMfaSession()` sees
// it. The code posts to POST /auth/mfa, which swaps the pending session for a fresh,
// complete one and redirects to `callbackUrl`; a wrong code comes back with
// ?error=CredentialsSignin. Deliberately NOT in the middleware matcher: `requireAuth`
// would bounce the pending session straight back to /login.

const ERRORS: Record<string, string> = {
  CredentialsSignin:
    "That code didn't work. A code changes every 30 seconds, and each one — like each backup code — works once.",
};

export default async function MfaPage({ searchParams }: PageProps) {
  const callbackUrl = safeCallback(searchParams.callbackUrl);
  const pending = await pendingMfaSession();
  if (!pending) redirect((await auth()) ? callbackUrl : "/login");
  return (
    <section class="auth">
      <h1>Two-factor authentication</h1>
      <p>
        Signed in as <strong>{pending.user.email}</strong>{" "}
        — one more step. Enter the 6-digit code from your authenticator app, or one of your backup
        codes.
      </p>
      <ErrorNote messages={ERRORS} params={searchParams} />
      <form method="post" action="/auth/mfa" class="stack">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <label>
          Code
          <input name="code" type="text" required autoComplete="one-time-code" />
        </label>
        <button type="submit">Verify</button>
      </form>
      <form method="post" action="/auth/signout?callbackUrl=/login">
        <button type="submit" class="linkbtn">Cancel and sign out</button>
      </form>
      <p class="hint">
        Five attempts per five minutes — right or wrong, every one counts.
      </p>
    </section>
  );
}
