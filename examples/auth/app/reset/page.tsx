import type { PageProps } from "denext/server";
import { ErrorNote } from "../error-note.tsx";

// The page the reset email links to (`email.resetPath: "/reset"` in lib/auth-config.ts).
// The link carries `?token=…&email=…`; this form posts them with the new password to
// POST /auth/reset/confirm, which sets it (through the adapter, with the configured hasher),
// revokes every session and redirects to /login?reset=1. Rendering this page spends
// nothing — the token is redeemed only on submit.

const ERRORS: Record<string, string> = {
  // A refused password comes back here with the link intact: the token was not spent.
  invalid_password: "Choose a password of at least 8 characters.",
};

/** One query value as a string ("" when absent or repeated). */
function param(params: PageProps["searchParams"], name: string): string {
  const value = params[name];
  return typeof value === "string" ? value : "";
}

export default function ResetPage({ searchParams }: PageProps) {
  const email = param(searchParams, "email");
  const token = param(searchParams, "token");
  if (!email || !token) {
    return (
      <section class="auth">
        <h1>Reset your password</h1>
        <p class="err">This page opens from the link in a reset email.</p>
        <p>
          <a href="/forgot">Request a new link</a>
        </p>
      </section>
    );
  }
  return (
    <section class="auth">
      <h1>Choose a new password</h1>
      <p>
        For <strong>{email}</strong>.
      </p>
      <ErrorNote messages={ERRORS} params={searchParams} />
      <form method="post" action="/auth/reset/confirm" class="stack">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="token" value={token} />
        <label>
          New password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <button type="submit">Set the new password</button>
      </form>
    </section>
  );
}
