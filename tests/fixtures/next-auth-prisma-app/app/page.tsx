import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();
  return <p id="who">signed in as {session?.user?.email ?? "anonymous"}</p>;
}
