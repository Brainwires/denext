import { auth } from "denext/server";
import { sqliteAuthAdapter } from "@denext/auth";

export const adapter = sqliteAuthAdapter({ path: "auth.db" });

export default async function Page() {
  const session = await auth();
  return <p>{session?.user.name ?? "signed out"}</p>;
}
