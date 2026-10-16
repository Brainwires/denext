import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/")({
  loader: () => ({
    renderedOn: typeof document === "undefined" ? "server" : "browser",
  }),
  component: Home,
});

function Home() {
  const { renderedOn } = Route.useLoaderData();
  const [n, setN] = useState(0);
  return (
    <section id="home">
      <h1>TanStack Start on denext</h1>
      <p id="rendered-on">loader ran on the {renderedOn}</p>
      <button type="button" id="count" onClick={() => setN(n + 1)}>
        clicked {n}
      </button>
    </section>
  );
}
