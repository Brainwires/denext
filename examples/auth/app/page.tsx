import { auth, type PageProps } from "denext/server";

export default async function Home({ searchParams }: PageProps) {
  const session = await auth();
  const everywhere = searchParams.get("everywhere") === "1";
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
        </code>), and keeps sessions in a <code>node:sqlite</code>{" "}
        store so they can be revoked (<code>sessionStore</code> + <code>revokeAllSessions</code>).
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
