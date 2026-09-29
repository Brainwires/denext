import { IslandCounter } from "../island-counter.tsx";

export default function Islands() {
  return (
    <section data-testid="islands">
      <IslandCounter client:load />
    </section>
  );
}
