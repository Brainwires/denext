import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <section id="about">
      <h1>About</h1>
      <p>
        <code>@denext/tanstack-start</code>{" "}
        runs a TanStack Start app's routes through TanStack Router's own server rendering, on
        denext's React.
      </p>
    </section>
  );
}
