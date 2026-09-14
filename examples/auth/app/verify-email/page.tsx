import { auth, type PageProps } from "denext/server";
import { findUser } from "../../lib/users.ts";
import { sendVerificationEmail } from "../actions.ts";
import { ErrorNote } from "../error-note.tsx";

// Email verification for the signed-in user. The Server Action calls
// `requestEmailVerification`; the mailed link opens GET /auth/verify, which marks the
// address verified (`emailVerified` on the adapter user) and redirects to
// `pages.verifyRequest` with ?verified=1. Gated by middleware.ts.

const ERRORS: Record<string, string> = {
  throttled: "Too many emails to this address — wait a few minutes before asking again.",
};

/** When the account's address was verified (epoch seconds), or `undefined`. */
async function verifiedAt(email: string | undefined): Promise<number | undefined> {
  const user = await findUser(email ?? "");
  return user?.emailVerified;
}

/** The request form — or, once it has been used, what happens next. */
function RequestLink({ sent }: { sent: boolean }) {
  return (
    <>
      {sent && (
        <p class="ok">
          A verification link is on its way. It works once, for 24 hours.
        </p>
      )}
      <form action={sendVerificationEmail} method="post">
        <button type="submit">{sent ? "Send it again" : "Email me a verification link"}</button>
      </form>
    </>
  );
}

/** Verified (and when), or not yet — with the form that sends the link. */
function AddressState(
  { email, verified, sent }: { email?: string; verified?: number; sent: boolean },
) {
  if (verified) {
    const day = new Date(verified * 1000).toISOString().slice(0, 10);
    return (
      <p>
        <strong>{email}</strong> <span class="ok">verified on {day}</span>
      </p>
    );
  }
  return (
    <>
      <p>
        <strong>{email}</strong> is not verified yet.
      </p>
      <RequestLink sent={sent} />
    </>
  );
}

export default async function VerifyEmail({ searchParams }: PageProps) {
  const session = await auth();
  if (!session) return null;
  return (
    <section class="stack">
      <h1>Email verification</h1>
      <ErrorNote messages={ERRORS} params={searchParams} />
      <AddressState
        email={session.user.email}
        verified={await verifiedAt(session.user.email)}
        sent={searchParams.sent === "1"}
      />
      <p class="hint">
        Why it matters: denext never links a provider login (OIDC, a magic link) to an account on an
        address nobody proved. And a first email sign-in into an UNVERIFIED account retires that
        account's password, API tokens and sessions before signing the mailbox's owner in — so
        whoever registered the address without owning it loses the account, not the owner.
      </p>
    </section>
  );
}
