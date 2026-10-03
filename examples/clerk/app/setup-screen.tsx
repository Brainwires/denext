/** Shown instead of the app while the Clerk keys are missing (see README → Setup). */
export function SetupScreen() {
  return (
    <main id="clerk-setup">
      <h1>Set up Clerk</h1>
      <p>
        This example needs a Clerk application. The keys are read from the environment or from a
        git-ignored <code>.env</code> / <code>.env.local</code> in <code>examples/clerk</code>.
      </p>
      <ol>
        <li>
          Create an application at <a href="https://dashboard.clerk.com">dashboard.clerk.com</a>
          {" "}
          (a development instance is fine).
        </li>
        <li>
          Copy <code>.env.example</code> to <code>.env.local</code> and paste its{" "}
          <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and <code>CLERK_SECRET_KEY</code>{" "}
          (API keys page).
        </li>
        <li>
          Restart <code>deno task dev</code>.
        </li>
      </ol>
      <p class="muted">
        The secret key stays on the server; only the publishable key reaches the page.
      </p>
    </main>
  );
}
