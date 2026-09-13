import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <section id="not-found">
      <h1>Not found</h1>
      <p>
        No route matches this URL. <Link to="/">Back home</Link>
      </p>
    </section>
  ),
});

function RootLayout() {
  return (
    <>
      <header>
        <nav aria-label="Main">
          <Link to="/" activeOptions={{ exact: true }}>Home</Link>
          <Link to="/posts">Posts</Link>
          <Link to="/about">About</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
