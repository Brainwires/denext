import { PlainCounter } from "./counter.tsx";

// A page with no Fragment ref: it must hydrate WITHOUT fetching the fragment-instance chunk.
export default function Plain() {
  return (
    <main>
      <PlainCounter />
    </main>
  );
}
