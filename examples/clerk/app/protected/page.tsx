// The protected page. On the web the middleware already refuses signed-out visitors
// (`auth.protect()` in middleware.ts). The content runs in the browser so the page also exists in
// the static export the Capacitor shell and the Deno Desktop window load: it sends a signed-out
// user to sign in, and asks the server to verify the session through `GET /api/me`.
import { ProtectedContent } from "../account-panel.tsx";

export default function Protected() {
  return (
    <main>
      <h1>Protected page</h1>
      <ProtectedContent />
    </main>
  );
}
