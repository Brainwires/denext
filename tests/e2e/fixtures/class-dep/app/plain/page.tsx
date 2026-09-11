import { PlainCounter } from "./counter.tsx";

// A function-only page: it must hydrate WITHOUT fetching the class-runtime chunk.
export default function Plain() {
  return (
    <main>
      <PlainCounter />
    </main>
  );
}
