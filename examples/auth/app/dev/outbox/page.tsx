import { notFound } from "denext";
import { isProduction } from "../../../lib/env.ts";
import { listMail, type Mail, subjectOf } from "../../../lib/outbox.ts";

// DEVELOPMENT ONLY: every message the app "sent" in this process, so you can click the
// links without a mail server. In production this page is a 404 and the mailer refuses to
// capture anything (see lib/outbox.ts) — a reset link on a public page is a live credential.

// Rendered per request: the list is in-process state, never a build-time snapshot.
export const dynamic = "force-dynamic";

/** Epoch ms as a wall-clock time. */
function time(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function MailLine({ mail }: { mail: Mail }) {
  return (
    <tr>
      <td>{time(mail.sentAt)}</td>
      <td>{mail.identifier}</td>
      <td>{subjectOf(mail)}</td>
      <td>
        <a href={mail.url}>Open the link</a>
      </td>
    </tr>
  );
}

export default function Outbox() {
  if (isProduction()) notFound();
  const mail = listMail();
  return (
    <section class="stack">
      <h1>Dev outbox</h1>
      <p>
        denext ships no mailer: every emailed token goes to <code>sendVerificationRequest</code>
        {" "}
        — here, <code>devMailer</code> in{" "}
        <code>lib/outbox.ts</code>, which keeps the message and prints its link. Newest first; a
        link works once.
      </p>
      {mail.length === 0 ? <p class="hint">Nothing sent yet.</p> : (
        <table class="grid">
          <thead>
            <tr>
              <th>Sent</th>
              <th>To</th>
              <th>Subject</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mail.map((m) => <MailLine mail={m} key={`${m.sentAt}-${m.url}`} />)}
          </tbody>
        </table>
      )}
    </section>
  );
}
