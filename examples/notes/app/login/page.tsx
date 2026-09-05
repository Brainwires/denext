// Sign-in page. The <form> posts the `login` Server Action — no client JS needed.
// On bad credentials the action redirects back here with ?error=1.

import type { PageProps } from "denext/server";
import { login } from "../actions.ts";

export default function LoginPage({ searchParams }: PageProps) {
  const failed = searchParams.error === "1";
  const next = typeof searchParams.next === "string" ? searchParams.next : "/notes";
  return (
    <section class="auth">
      <h1>Sign in</h1>
      {failed && <p class="err">Incorrect email or password.</p>}
      <form action={login} method="post" class="stack">
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            value="demo@denext.dev"
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            value="password"
          />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p class="hint">
        Demo accounts: <code>demo@denext.dev</code> / <code>alice@denext.dev</code>, password{" "}
        <code>password</code>.
      </p>
    </section>
  );
}
