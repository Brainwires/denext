import { auth, type AuthSession, type PageProps } from "denext/server";
import { changePassword, signOutEverywhere } from "../actions.ts";

const ERRORS: Record<string, string> = {
  current: "The current password is wrong.",
  weak: "The new password must be at least 8 characters.",
};

/** The roles the session carries — what `requireAuth({ role })` matches, any-of. */
function Roles({ roles }: { roles: string[] }) {
  if (roles.length === 0) return <em>none</em>;
  return <>{roles.map((role) => <code class="role" key={role}>{role}</code>)}</>;
}

/** Who the session says you are, and where that identity can take you. */
function Identity({ session }: { session: AuthSession }) {
  const roles = session.user.roles ?? [];
  return (
    <>
      <p>
        Signed in as <strong>{session.user.email}</strong> via{" "}
        <code>{session.provider}</code>. Session id: <code>{session.sessionId}</code>
      </p>
      <p>
        User id <code>{session.user.id}</code> — the adapter's, not the provider's — with roles{" "}
        <Roles roles={roles} />.
      </p>
      <p class="row">
        <a href="/account/tokens">API tokens</a>
        {roles.includes("admin") && <a href="/admin">Admin</a>}
      </p>
    </>
  );
}

// Gated by middleware.ts (requireAuth) — a signed-out request never reaches this page.
export default async function Dashboard({ searchParams }: PageProps) {
  const session = await auth();
  if (!session) return null;
  const error = ERRORS[String(searchParams.error ?? "")];
  return (
    <section class="stack">
      <h1>Dashboard</h1>
      <Identity session={session} />

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
        authenticating immediately. The session record lives in the adapter's <code>sessions</code>
        {" "}
        table (<code>session.strategy: "database"</code>).
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
