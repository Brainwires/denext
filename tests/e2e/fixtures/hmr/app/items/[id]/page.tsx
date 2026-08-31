import { useState } from "denext";

// A DYNAMIC route (`/items/[id]`): proves the unbundled loop hydrates a param route
// and preserves child state across a nested-layout edit.
export default function ItemPage({ params }: { params: { id: string } }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2 data-testid="item-id">id: {params.id}</h2>
      <button type="button" data-testid="item-counter" onClick={() => setN((c) => c + 1)}>
        n: {n}
      </button>
    </section>
  );
}
