import { CounterIsland } from "./counter-island.tsx";
import { CounterElement } from "./counter-element.tsx";
import { CounterView } from "./counter-view.ts";
import { TickerPanel } from "./ticker.tsx";

export default function Page() {
  return (
    <div>
      <h1>Lustre in denext</h1>
      <section id="island">
        <h2>An island</h2>
        <CounterIsland start={3} client:visible />
      </section>
      <section id="element">
        <h2>A custom element</h2>
        <CounterElement start="5" />
      </section>
      <section id="server">
        <h2>A server component over Live</h2>
        <CounterView start={7} />
      </section>
      <section id="ticker">
        <h2>An island that stops</h2>
        <TickerPanel every={200} />
      </section>
    </div>
  );
}
