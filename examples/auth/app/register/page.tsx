import type { PageProps } from "denext/server";
import { register } from "../actions.ts";

const ERRORS: Record<string, string> = {
  invalid: "Enter a valid email and a password of at least 8 characters.",
  taken: "That email already has an account.",
};

export default function RegisterPage({ searchParams }: PageProps) {
  const error = ERRORS[String(searchParams.error ?? "")];
  return (
    <section class="auth">
      <h1>Create an account</h1>
      {error && <p class="err">{error}</p>}
      <form action={register} method="post" class="stack">
        <label>
          Name
          <input name="name" type="text" autoComplete="name" />
        </label>
        <label>
          Email
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <button type="submit">Register</button>
      </form>
      <p class="hint">
        The password is stored as a salted scrypt hash — see lib/db.ts.
      </p>
    </section>
  );
}
