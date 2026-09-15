import {
  auth,
  type AuthSession,
  type MfaStatus,
  mfaStatus,
  type PageProps,
  type TotpEnrollment,
} from "denext/server";
import { authConfig } from "../../../lib/auth-config.ts";
import { onceKey, takeOnce } from "../../../lib/once.ts";
import { ErrorNote } from "../../error-note.tsx";
import { confirmEnrolment, disableTwoFactor, startEnrolment } from "./actions.ts";

const ERRORS: Record<string, string> = {
  enrolled: "Two-factor authentication is already on — turn it off before enrolling again.",
  confirm: "That code didn't match. Start again: a new secret replaces the unconfirmed one.",
  code: "That code didn't verify. Enter the current code from your app, or an unused backup code.",
  throttled: "Too many attempts — wait a few minutes and try again.",
};

/** A one-time value, taken out of its slot and parsed; `undefined` when there is none. */
function takeParsed<T>(key: string): T | undefined {
  const raw = takeOnce(key);
  return raw === undefined ? undefined : JSON.parse(raw) as T;
}

/**
 * What this render may show exactly once: the secret of the enrolment just started, or the
 * backup codes just minted. Single-use — a reload shows the state, never these again.
 */
function takeOneTime(session: AuthSession, params: PageProps["searchParams"]) {
  return {
    enrolment: params.step === "confirm"
      ? takeParsed<TotpEnrollment>(onceKey(session, "totp"))
      : undefined,
    codes: params.confirmed === "1" ? takeParsed<string[]>(onceKey(session, "backup")) : undefined,
  };
}

/** Step 2 of enrolling: the secret (shown this once) and the confirm form. */
function Enrolment({ enrolment }: { enrolment: TotpEnrollment }) {
  return (
    <>
      <p>
        Add this account to an authenticator app. Type the secret in by hand, or render the{" "}
        <code>otpauth://</code>{" "}
        URI as a QR code (denext ships no QR renderer — any library will do):
      </p>
      <p>
        <code class="token">{enrolment.secret}</code>
      </p>
      <p>
        <code class="token">{enrolment.uri}</code>
      </p>
      <form action={confirmEnrolment} method="post" class="stack">
        <label>
          The 6-digit code the app shows
          <input name="code" type="text" required autoComplete="one-time-code" />
        </label>
        <button type="submit">Confirm and turn on</button>
      </form>
    </>
  );
}

/** The backup codes, rendered the only time they will ever exist in plaintext. */
function BackupCodes({ codes }: { codes?: string[] }) {
  if (!codes) return null;
  return (
    <div class="ok">
      <p>
        Save these backup codes. Each signs you in once if you lose your device; they are stored
        only as hashes and will never be shown again:
      </p>
      <ul class="codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A confirmed factor: its state, and the form that removes it. */
function Enabled({ status }: { status: MfaStatus }) {
  return (
    <>
      <p>
        Two-factor authentication is{" "}
        <strong>on</strong>: every sign-in asks for a code after the password. Backup codes left:
        {" "}
        <strong>{status.backupCodesRemaining}</strong>.
      </p>
      <h2>Turn it off</h2>
      <form action={disableTwoFactor} method="post" class="stack">
        <label>
          A current code, or a backup code
          <input name="code" type="text" required autoComplete="one-time-code" />
        </label>
        <button type="submit" class="danger">Turn off two-factor authentication</button>
      </form>
    </>
  );
}

/** No confirmed factor: step 1 of enrolling. */
function Disabled({ status }: { status: MfaStatus }) {
  return (
    <>
      <p>
        Two-factor authentication is <strong>off</strong>. {status.pendingConfirmation &&
          "An enrolment was started but never confirmed — start again."}
      </p>
      <form action={startEnrolment} method="post">
        <button type="submit">Set up an authenticator app</button>
      </form>
    </>
  );
}

/** The factor's state: on (with the off switch), part-way through enrolling, or off. */
function Factor({ status, enrolment }: { status: MfaStatus; enrolment?: TotpEnrollment }) {
  if (status.enrolled) return <Enabled status={status} />;
  return enrolment ? <Enrolment enrolment={enrolment} /> : <Disabled status={status} />;
}

/** The outcome of the last action. */
function Notices({ params }: { params: PageProps["searchParams"] }) {
  return (
    <>
      <ErrorNote messages={ERRORS} params={params} />
      {params.disabled === "1" && <p class="ok">Two-factor authentication is off.</p>}
    </>
  );
}

// Gated by middleware.ts (requireAuth) — only a COMPLETE session reaches this page.
export default async function Security({ searchParams }: PageProps) {
  const session = await auth();
  if (!session) return null;
  const status = await mfaStatus(authConfig, session.user.id);
  const { enrolment, codes } = takeOneTime(session, searchParams);
  return (
    <section class="stack">
      <h1>Two-factor authentication</h1>
      <Notices params={searchParams} />
      <BackupCodes codes={codes} />
      <Factor status={status} enrolment={enrolment} />
      <p class="hint">
        TOTP (RFC 6238): a 30-second code from a secret only your app and the adapter hold. A code
        is accepted once — its time step is claimed atomically — and each backup code is spent the
        moment it is used.
      </p>
    </section>
  );
}
