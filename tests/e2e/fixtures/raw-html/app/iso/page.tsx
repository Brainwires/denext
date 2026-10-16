// An isomorphic route: the page calls a hook, so the whole route is one client tree (no Flight).
import { useState } from "denext";
import { RAW } from "../raw.ts";

export default function Page() {
  const [n, setN] = useState(0);
  const bump = () => setN((v) => v + 1);
  return (
    <article data-n={String(n)}>
      <p dangerouslySetInnerHTML={{ __html: RAW }} id="raw" />
      <button onClick={bump} type="button" data-testid="count">
        count: {n}
      </button>
    </article>
  );
}
