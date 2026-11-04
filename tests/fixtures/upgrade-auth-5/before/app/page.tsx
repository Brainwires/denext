import { auth, sqliteAuthAdapter } from "denext/server";

export const adapter = sqliteAuthAdapter({ path: "auth.db" });

export default async function Page() {
  const session = await auth();
  return <p>{session?.user.name ?? "signed out"}</p>;
}
