// Two deferred values (as a Remix loader's `defer()` fields) handed to a client component: a
// fast one and a slow one. On a soft navigation the page renders at once, each `<Await>` shows
// its fallback, and each reveals when its own value arrives.
import { Panels } from "./panels.tsx";

const after = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

export default function Deferred() {
  return (
    <section data-testid="deferred">
      <Panels fast={after(300, "fast value")} slow={after(3000, "slow value")} />
    </section>
  );
}
