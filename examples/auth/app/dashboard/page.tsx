import { auth, type PageProps } from "denext/server";
import { changePassword, signOutEverywhere } from "../actions.ts";

const ERRORS: Record<string, string> = {
  current: "The current password is wrong.",
  weak: "The new password must be at least 8 characters.",
};

// Gated by middleware.ts (requireAuth) — a signed-out request never reaches this page.
export default async function Dashboard({ searchParams }: PageProps) {
  const session = await auth();
  if (!session) return null;
  const error = ERRORS[searchParams.get("error") ?? ""];
  return (
    <section class="stack">
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{session.user.email}</strong> via{" "}
        <code>{session.provider}</code>. Session id: <code>{session.sessionId}</code>
      </p>

      <h2>Sessions</h2>
      <div class="row">
        <form method="post" action="/auth/signout?callbackUrl=/">
          <button type="submit">Sign out (this device)</button>
        </form>
        <form action={signOutEverywhere}>
          <button type="submit" class="danger">Sign out everywhere</button>
        </form>
      </div>
      <p class="hint">
        "Everywhere" calls{" "}
        <code>revokeAllSessions</code>: every cookie for this user — on every device — stops
        authenticating immediately.
      </p>

      <h2>Change password</h2>
      {error && <p class="err">{error}</p>}
      <form action={changePassword} method="post" class="stack">
        <label>
          Current password
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        <label>
          New password
          <input
            name="next"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <button type="submit">Change password and sign out everywhere</button>
      </form>
    </section>
  );
}
