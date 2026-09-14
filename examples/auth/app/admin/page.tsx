import { auth } from "denext/server";
import { listUsers, type UserRow } from "../../lib/db.ts";

// Gated by middleware.ts — `requireAuth(request, { role: "admin" })`. A signed-in account
// without the role never reaches this module: it is redirected to
// /login?error=forbidden&callbackUrl=%2Fadmin. The check below is belt-and-braces, the way
// a page that must never render for the wrong user should be written.

/** The roles column as the adapter stores it: a JSON array of strings. */
function rolesOf(row: UserRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.roles ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** An epoch-seconds column as a date, or a dash. */
function when(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "—";
}

function UserLine({ row }: { row: UserRow }) {
  return (
    <tr>
      <td>{row.email ?? "—"}</td>
      <td>{row.name || "—"}</td>
      <td>
        {rolesOf(row).map((role) => <code class="role" key={role}>{role}</code>)}
      </td>
      <td>{row.email_verified ? "verified" : "unverified"}</td>
      <td>{when(row.created_at)}</td>
    </tr>
  );
}

export default async function Admin() {
  const session = await auth();
  if (!session) return null;
  const users = listUsers();
  return (
    <section class="stack">
      <h1>Users</h1>
      <p>
        You are here because your session carries the <code>admin</code>{" "}
        role. Roles live on the adapter's user record and travel in the session, so{" "}
        <code>requireAuth(request, {'{ role: "admin" }'})</code> in <code>middleware.ts</code>{" "}
        can gate this page without a database read.
      </p>
      <table class="grid">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Roles</th>
            <th>Address</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((row) => <UserLine row={row} key={row.id} />)}
        </tbody>
      </table>
      <p class="hint">
        The adapter is a persistence port, not a query layer — it has no{" "}
        <code>listUsers</code>. A screen that needs a list reads the <code>auth_users</code>{" "}
        table directly (see <code>lib/db.ts</code>).
      </p>
    </section>
  );
}
