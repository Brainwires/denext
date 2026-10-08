import { useState } from "denext";
import Chart from "./chart.tsx";
import { Panel } from "./panel.tsx";
import { Wide } from "./wide.tsx";
import { Later } from "./later.tsx";

// Each deferred component's module sets `window.__loaded.<name>` when it is evaluated, so the
// test sees when its chunk loaded, apart from when it mounted.
export function App() {
  const [n, setN] = useState(0);
  return (
    <main>
      <button type="button" data-testid="counter" onClick={() => setN((c) => c + 1)}>
        count {n}
      </button>
      <Later client:idle />
      <Wide client:media="(min-width: 1px)" />
      <Panel
        client:interaction
        client:placeholder={<button type="button" data-testid="open">Open panel</button>}
        title="settings"
      />
      <div style={{ height: "3000px" }} data-testid="spacer" />
      <Chart client:visible label="sales" count={n} />
    </main>
  );
}
