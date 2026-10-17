import { getServerSession } from "next-auth/next";
import { authOptions } from "../lib/auth";

export default async function Home() {
  const session = await getServerSession(authOptions) as
    | { user?: { email?: string }; role?: string }
    | null;
  return (
    <main>
      <p id="who">signed in as {session?.user?.email ?? "anonymous"}</p>
      <p id="role">role {session?.role ?? "none"}</p>
    </main>
  );
}
