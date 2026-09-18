"use client";

// With JavaScript: `signIn("credentials", …)` POSTs JSON to the auth endpoint and shows
// the refusal inline — `{ ok: false, error: "invalid_credentials" }` (a 401 that never says
// whether the account exists) or `"throttled"` with `retryAfter` (a 429). Only a network
// failure rejects. Without JavaScript the same <form> posts form-encoded to the endpoint.

import { type CredentialsSignInResult, signIn, useState } from "denext";

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
      const result = await signIn("credentials", {
        callbackUrl,
        credentials: credentialsFrom(data),
      });
      if (result.ok) location.href = callbackUrl;
      else setError(describe(result));
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

/** The line shown for a refusal — routed on the stable code, never the server's text. */
function describe(result: Extract<CredentialsSignInResult, { ok: false }>): string {
  switch (result.error) {
    case "invalid_credentials":
      return "Wrong email or password.";
    case "throttled":
      return `Too many attempts — try again in ${result.retryAfter}s.`;
    case "access_denied":
      return "This account may not sign in here.";
    default:
      return `Sign-in failed (${result.status}).`;
  }
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
