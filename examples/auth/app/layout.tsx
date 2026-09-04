import { SessionProvider } from "denext";
import { auth, type LayoutProps } from "denext/server";
import { UserMenu } from "./user-menu.tsx";

export const metadata = {
  title: "denext · auth",
  description:
    "A runnable denextAuth app: scrypt password hashing, brute-force protection, and opt-in revocable sessions.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default async function RootLayout({ children }: LayoutProps) {
  // Read the session on the server and seed the client provider with it.
  const session = await auth();
  return (
    <div class="app">
      <header class="topbar">
        <a class="brand" href="/">denext · auth</a>
        <nav class="nav">
          <SessionProvider session={session?.user ?? null}>
            <UserMenu />
          </SessionProvider>
        </nav>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        denextAuth · scrypt passwords · rate-limited login · revocable sqlite sessions
      </footer>
    </div>
  );
}
