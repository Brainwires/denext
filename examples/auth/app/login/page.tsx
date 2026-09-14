import type { AuthProvider, PageProps } from "denext/server";
import { oauthProviders } from "../../lib/auth-config.ts";
import { safeCallback } from "../../lib/callback.ts";
import { ErrorNote } from "../error-note.tsx";
import { LoginForm } from "./login-form.tsx";

const ERRORS: Record<string, string> = {
  // `requireAuth(request, { role })` sends a signed-in user without the role here.
  forbidden: "That page needs the admin role, and this account doesn't have it.",
  // The adapter refuses to attach a provider login to a local account on an address
  // nobody verified — the safe default (see lib/users.ts).
  account_not_linked: "That address already belongs to a password account. Sign in with it first.",
  oauth_failed: "The provider sign-in did not complete.",
  // A sign-in link that is wrong, already used or expired (the email provider's redeem).
  Verification: "That sign-in link is invalid, already used, or expired — ask for a new one.",
  AccessDenied: "That sign-in was refused.",
};

/** What `?<name>=1` reports: the outcome of the flow that redirected here. */
const DONE: Record<string, string> = {
  registered: "Account created — sign in.",
  changed: "Password changed; every session was signed out. Sign in again.",
  reset: "Password reset; every session was signed out. Sign in with the new password.",
};

/** Sign-in starts at GET /auth/signin/:id — a plain link, so it works without JavaScript. */
function ProviderLink({ provider }: { provider: AuthProvider }) {
  return (
    <a class="provider" href={`/auth/signin/${provider.id}`}>
      Sign in with {provider.id}
    </a>
  );
}

/** What the query string has to say: a refusal code, or the result of the last action. */
function Notices({ params }: { params: PageProps["searchParams"] }) {
  const done = Object.keys(DONE).filter((name) => params[name] === "1");
  return (
    <>
      <ErrorNote messages={ERRORS} params={params} />
      {done.map((name) => <p class="ok" key={name}>{DONE[name]}</p>)}
    </>
  );
}

/**
 * Passwordless sign-in: POST /auth/callback/email mails a single-use link and redirects to
 * `pages.verifyRequest` — the same answer whether or not the address has an account.
 */
function MagicLinkForm({ callbackUrl }: { callbackUrl: string }) {
  return (
    <form method="post" action="/auth/callback/email" class="stack">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <label>
        Email
        <input name="email" type="email" required autoComplete="username" />
      </label>
      <button type="submit">Email me a sign-in link</button>
    </form>
  );
}

export default function LoginPage({ searchParams }: PageProps) {
  const providers = oauthProviders();
  const callbackUrl = safeCallback(searchParams.callbackUrl);
  return (
    <section class="auth">
      <h1>Sign in</h1>
      <Notices params={searchParams} />
      <LoginForm callbackUrl={callbackUrl} />
      <p class="row">
        <a href="/forgot">Forgot your password?</a>
      </p>
      <h2>Or without a password</h2>
      <MagicLinkForm callbackUrl={callbackUrl} />
      {providers.length > 0 && (
        <p class="row">
          {providers.map((provider) => <ProviderLink provider={provider} key={provider.id} />)}
        </p>
      )}
      <p class="hint">
        Demo: <code>demo@denext.dev</code> / <code>password</code>{" "}
        (the first account registered, so it is the{" "}
        <code>admin</code>). Five wrong passwords lock the account for 15 minutes (a generic{" "}
        <code>429</code>).
      </p>
    </section>
  );
}
