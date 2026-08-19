import type { LayoutProps } from "denext/server";
import { currentUser } from "../lib/auth.ts";
import { logout } from "./actions.ts";

export const metadata = {
  title: "denext · notes",
  description:
    "A small, real denext app: cookie-session auth, SQLite (node:sqlite), CRUD, ISR, and an error boundary — every flow works with JavaScript disabled.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default async function RootLayout({ children }: LayoutProps) {
  const user = await currentUser();
  return (
    <div class="app">
      <header class="topbar">
        <a class="brand" href="/">denext · notes</a>
        <nav class="nav">
          <a href="/">Home</a>
          {user
            ? (
              <>
                <a href="/notes">My notes</a>
                <span class="who">{user.email}</span>
                <form action={logout} class="inline">
                  <button type="submit" class="linkbtn">Sign out</button>
                </form>
              </>
            )
            : <a href="/login">Sign in</a>}
        </nav>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        node:sqlite · signed-cookie sessions · Server Actions · works with JS disabled
      </footer>
    </div>
  );
}
