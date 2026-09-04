"use client";

// With JavaScript: `signIn("credentials", …)` POSTs JSON to the auth endpoint and shows
// the generic error (401 "invalid credentials" or 429 "too many attempts") inline.
// Without JavaScript the same <form> posts form-encoded to the endpoint directly.

import { signIn, useState } from "denext";

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(
    event: { preventDefault(): void; currentTarget: HTMLFormElement },
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await signIn("credentials", {
        callbackUrl,
        credentials: credentialsFrom(data),
      });
      location.href = callbackUrl;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      method="post"
      action="/auth/callback/credentials"
      onSubmit={submit}
      class="stack"
    >
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      {error && <p class="err">{error}</p>}
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="username"
        value="demo@denext.dev"
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        value="password"
      />
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function credentialsFrom(data: FormData): { email: string; password: string } {
  return {
    email: String(data.get("email")),
    password: String(data.get("password")),
  };
}

function Field(
  props: {
    label: string;
    name: string;
    type: string;
    autoComplete: string;
    value: string;
  },
) {
  const { label, ...input } = props;
  return (
    <label>
      {label}
      <input {...input} required />
    </label>
  );
}
