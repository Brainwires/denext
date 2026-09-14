import { auth, type PageProps } from "denext/server";

export default async function Home({ searchParams }: PageProps) {
  const session = await auth();
  const everywhere = searchParams.everywhere === "1";
  return (
    <section class="stack">
      <h1>First-party auth, production-ready</h1>
      {everywhere && <p class="ok">Signed out everywhere — every session was revoked.</p>}
      <p>
        This app signs users in with a <strong>Credentials</strong>{" "}
        provider whose passwords are stored as scrypt hashes (<code>
          hashPassword
        </code>{" "}
        / <code>verifyPassword</code>), locks the login endpoint after repeated failures (<code>
          rateLimit
        </code>), and keeps every durable record — users, linked accounts, credentials, API tokens
        and sessions — in one <code>node:sqlite</code> file behind <code>sqliteAuthAdapter</code>.
      </p>
      <p>
        Sessions are database-backed (revocable, with a sliding expiry), the user record carries
        {" "}
        <code>roles</code> that gate <code>/admin</code>, every sign-in and refusal goes through
        {" "}
        <code>events</code>, and a signed-in user can mint <code>Bearer</code>{" "}
        API tokens for scripts.
      </p>
      <p>
        The emailed flows ride the same adapter: email verification, a password reset, and a magic
        sign-in link — captured by a development mailer at <a href="/dev/outbox">/dev/outbox</a>
        {" "}
        instead of sent. And a TOTP second factor (with single-use backup codes) can be turned on at
        {" "}
        <code>/account/security</code>.
      </p>
      {session
        ? (
          <p>
            You are signed in as <strong>{session.user.email}</strong>.{" "}
            <a href="/dashboard">Open the dashboard</a>.
          </p>
        )
        : (
          <p>
            <a href="/login">Sign in</a> with <code>demo@denext.dev</code> /{" "}
            <code>password</code>, or <a href="/register">create an account</a>.
          </p>
        )}
    </section>
  );
}
