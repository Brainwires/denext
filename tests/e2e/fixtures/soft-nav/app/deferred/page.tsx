// Two deferred values (as a Remix loader's `defer()` fields) handed to a client component: a
// fast one and a slow one. On a soft navigation the page renders at once, each `<Await>` shows
// its fallback, and each reveals when its own value arrives.
//
// The slow value waits for the test, not a clock: it settles when `/release-slow` is fetched
// (tests/e2e/nav-defer.e2e.test.ts does that once it has seen the fast value revealed), so the
// "fast before slow" order holds however slowly the runner commits the route. A 60 s fallback
// only keeps a page nobody releases from streaming forever.
import { Panels } from "./panels.tsx";
import { waitForSlowRelease } from "../slow-gate.ts";

const after = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

export default function Deferred() {
  return (
    <section data-testid="deferred">
      <Panels fast={after(300, "fast value")} slow={waitForSlowRelease("slow value")} />
    </section>
  );
}
