// "Forgot your password?" — a plain form posting to POST /auth/reset. The endpoint mails a
// reset link (to the address's owner only, 3 per address per 15 minutes) and redirects to
// `pages.verifyRequest` with ?sent=1 — the same answer for every address.

export default function ForgotPage() {
  return (
    <section class="auth">
      <h1>Forgot your password?</h1>
      <p>Enter your account's email address and we'll send a link to choose a new password.</p>
      <form method="post" action="/auth/reset" class="stack">
        <label>
          Email
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <button type="submit">Email me a reset link</button>
      </form>
      <p class="hint">
        The link lasts an hour and works once. Setting the new password signs every device out — a
        reset exists for exactly the moment someone else may hold your password.
      </p>
    </section>
  );
}
