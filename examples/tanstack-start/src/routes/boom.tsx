import { createFileRoute } from "@tanstack/react-router";

// A loader that fails: the route's errorComponent renders in its place, inside the root layout.
export const Route = createFileRoute("/boom")({
  loader: (): string => {
    throw new Error("the loader failed on purpose");
  },
  component: () => <p>never rendered</p>,
  errorComponent: ({ error }) => <p id="route-error">Caught: {(error as Error).message}</p>,
});
