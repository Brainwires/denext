import { useState } from "denext";
import { Widget } from "./widget.tsx";

export default function Page() {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h1 data-testid="title">TITLE_V1</h1>
      <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
        count: {count}
      </button>
      <Widget />
    </section>
  );
}
