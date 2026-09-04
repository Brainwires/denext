import type { PageProps } from "denext/server";
import { LoginForm } from "./login-form.tsx";

/** Only a same-origin path may be used as the post-login target. */
function safeCallback(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}

export default function LoginPage({ searchParams }: PageProps) {
  return (
    <section class="auth">
      <h1>Sign in</h1>
      {searchParams.get("registered") === "1" && <p class="ok">Account created — sign in.</p>}
      {searchParams.get("changed") === "1" && (
        <p class="ok">
          Password changed; every session was signed out. Sign in again.
        </p>
      )}
      <LoginForm callbackUrl={safeCallback(searchParams.get("callbackUrl"))} />
      <p class="hint">
        Demo: <code>demo@denext.dev</code> /{" "}
        <code>password</code>. Five wrong passwords lock the account for 15 minutes (a generic{" "}
        <code>429</code>).
      </p>
    </section>
  );
}
