import { useState } from "react";
import { Slot } from "@radix-ui/react-slot";

export function App() {
  const [n, setN] = useState(0);
  const mode = import.meta.env.MODE;
  return (
    <main>
      <h1 data-testid="mode">mode:{mode}</h1>
      <Slot>
        <button type="button" data-testid="counter" onClick={() => setN((c) => c + 1)}>
          count {n}
        </button>
      </Slot>
    </main>
  );
}
