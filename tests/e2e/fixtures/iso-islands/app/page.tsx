// An isomorphic route (the page calls a hook, so the whole route is one client tree, no Flight)
// with two `client:*` islands: one hydrates on its first interaction, one when it scrolls into
// view. Until then each keeps its server DOM, inert.
import { useState } from "denext";
import { Counter } from "./counter.tsx";

export default function Page() {
  const [n, setN] = useState(0);
  return (
    <main>
      <button type="button" data-testid="page" onClick={() => setN(n + 1)}>page {n}</button>
      <Counter client:interaction label="tap" />
      <div style={{ height: "4000px" }} />
      <Counter client:visible label="far" />
    </main>
  );
}
