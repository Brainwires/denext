import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <section id="about">
      <h1>About</h1>
      <p>
        <code>denext migrate</code> turns a Vite + TanStack Router app into exactly this shape:{" "}
        <code>mode: "spa"</code>, <code>compatibilityMode: true</code>, the
        <code>react</code> imports aliased to denext, and the Vite-only plugins dropped.
      </p>
    </section>
  );
}
