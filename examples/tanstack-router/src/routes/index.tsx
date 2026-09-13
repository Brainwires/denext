import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <section id="home">
      <h1>TanStack Router on denext</h1>
      <p>
        A stock file-based TanStack Router app running in denext SPA mode: no plugin, no server
        rendering — the router owns the browser, denext owns the bundle and the shell.
      </p>
      <p>
        Try the <Link to="/posts">posts</Link>{" "}
        (a loader + a dynamic segment), then reload a deep URL to see the history-API fallback serve
        the shell.
      </p>
    </section>
  );
}
