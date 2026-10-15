import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();
  const user = session?.user as { email?: string; role?: string } | undefined;
  return (
    <main>
      <p id="who">signed in as {user?.email ?? "anonymous"}</p>
      <p id="role">role {user?.role ?? "none"}</p>
    </main>
  );
}
