import type { AuthProvider, PageProps } from "denext/server";
import { oauthProviders } from "../../lib/auth-config.ts";
import { LoginForm } from "./login-form.tsx";

const ERRORS: Record<string, string> = {
  // `requireAuth(request, { role })` sends a signed-in user without the role here.
  forbidden: "That page needs the admin role, and this account doesn't have it.",
  // The adapter refuses to attach a provider login to a local account on an address
  // nobody verified — the safe default (see lib/users.ts).
  account_not_linked: "That address already belongs to a password account. Sign in with it first.",
  oauth_failed: "The provider sign-in did not complete.",
};

/** Only a same-origin path may be used as the post-login target. */
function safeCallback(raw: string | string[] | undefined): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
    ? raw
    : "/dashboard";
}

/** Sign-in starts at GET /auth/signin/:id — a plain link, so it works without JavaScript. */
function ProviderLink({ provider }: { provider: AuthProvider }) {
  return (
    <a class="provider" href={`/auth/signin/${provider.id}`}>
      Sign in with {provider.id}
    </a>
  );
}

/** The message for an `?error=` code, or `""` when there is nothing to explain. */
function errorMessage(params: PageProps["searchParams"]): string {
  return ERRORS[String(params.error ?? "")] ?? "";
}

/** What the query string has to say: a refusal code, or the result of the last action. */
function Notices({ params }: { params: PageProps["searchParams"] }) {
  const error = errorMessage(params);
  return (
    <>
      {error && <p class="err">{error}</p>}
      {params.registered === "1" && <p class="ok">Account created — sign in.</p>}
      {params.changed === "1" && (
        <p class="ok">
          Password changed; every session was signed out. Sign in again.
        </p>
      )}
    </>
  );
}

export default function LoginPage({ searchParams }: PageProps) {
  const providers = oauthProviders();
  return (
    <section class="auth">
      <h1>Sign in</h1>
      <Notices params={searchParams} />
      <LoginForm callbackUrl={safeCallback(searchParams.callbackUrl)} />
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
