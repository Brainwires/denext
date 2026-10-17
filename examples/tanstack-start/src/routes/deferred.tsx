import { Await, createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";

// A loader that returns an unawaited promise: the page streams with the fallback, and the value
// streams in when the promise settles.
export const Route = createFileRoute("/deferred")({
  loader: () => ({
    now: "ready at once",
    later: new Promise<string>((resolve) => setTimeout(() => resolve("streamed in later"), 400)),
  }),
  component: Deferred,
});

function Deferred() {
  const { now, later } = Route.useLoaderData();
  return (
    <section id="deferred">
      <h1>Deferred</h1>
      <p id="now">{now}</p>
      <Suspense fallback={<p id="later-pending">waiting…</p>}>
        <Await promise={later}>{(value) => <p id="later">{value}</p>}</Await>
      </Suspense>
    </section>
  );
}
