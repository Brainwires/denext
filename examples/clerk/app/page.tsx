import { AccountPanel } from "./account-panel.tsx";
import { DesktopPanel } from "./desktop-panel.tsx";
import { DesktopE2E } from "./desktop-e2e.tsx";

export default function Home() {
  return (
    <main>
      <h1>denext + Clerk</h1>
      <p class="muted">
        One app, written once: the web, a Deno Desktop window and a Capacitor shell sign in through
        the same <code>&lt;ClerkProvider&gt;</code>. The server reads the session with{" "}
        <code>auth()</code> in middleware, Server Components and route handlers.
      </p>
      <AccountPanel />
      <DesktopPanel />
      <DesktopE2E />
    </main>
  );
}
