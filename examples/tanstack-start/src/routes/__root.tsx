import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { title: "denext + TanStack Start" }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: () => (
    <section id="not-found">
      <h1>Not found</h1>
      <Link to="/">Back home</Link>
    </section>
  ),
});

/** The document: Start's `shellComponent`, server-rendered, then hydrated as a whole. */
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  return (
    <>
      <nav aria-label="Main">
        <Link to="/" activeOptions={{ exact: true }}>Home</Link> <Link to="/posts">Posts</Link>{" "}
        <Link to="/notes">Notes</Link> <Link to="/deferred">Deferred</Link>{" "}
        <Link to="/about">About</Link>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}
