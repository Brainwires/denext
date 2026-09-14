import type { PageProps } from "denext/server";
import { isProduction } from "../../lib/env.ts";
import { ErrorNote } from "../error-note.tsx";

// `pages.verifyRequest`: where a reset or magic-link request lands (?sent=1), and where the
// verification link reports back (?verified=1 — or ?error=invalid_token for a bad link).

const ERRORS: Record<string, string> = {
  invalid_token: "That link is invalid, already used, or expired. Ask for a new one.",
};

/** In development, point at the captured mail. */
function OutboxHint() {
  if (isProduction()) return null;
  return (
    <p class="hint">
      Running locally? Nothing is really sent — open the <a href="/dev/outbox">dev outbox</a>{" "}
      to click the link.
    </p>
  );
}

export default function CheckEmail({ searchParams }: PageProps) {
  if (searchParams.verified === "1") {
    return (
      <section class="auth">
        <h1>Address verified</h1>
        <p class="ok">Your email address is verified.</p>
        <p>
          <a href="/dashboard">Back to the dashboard</a>
        </p>
      </section>
    );
  }
  return (
    <section class="auth">
      <h1>Check your email</h1>
      <ErrorNote messages={ERRORS} params={searchParams} />
      {searchParams.sent === "1" && (
        <p>
          If an account uses that address, a link is on its way. It works once: a sign-in link for
          ten minutes, a password-reset link for an hour.
        </p>
      )}
      <p class="hint">
        The answer is the same for every address — whether it has an account is exactly what this
        page must not reveal.
      </p>
      <OutboxHint />
    </section>
  );
}
