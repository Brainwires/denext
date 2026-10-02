// A protected Server Component: the middleware already refused signed-out visitors, and
// `auth.protect()` here checks again (Clerk recommends the check at the resource itself).
import { auth, currentUser } from "@clerk/nextjs/server";

export const dynamic = "force-dynamic";

export default async function Protected() {
  const { userId, sessionId } = await auth.protect();
  const user = await currentUser();
  return (
    <main>
      <h1>Protected page</h1>
      <div class="card">
        <p>
          Rendered on the server for <strong>{user?.primaryEmailAddress?.emailAddress}</strong>.
        </p>
        <p>
          User id: <code id="user-id">{userId}</code>
        </p>
        <p>
          Session id: <code id="session-id">{sessionId}</code>
        </p>
      </div>
    </main>
  );
}
