// An isomorphic route (the page calls a hook, so the whole route is one client tree, no Flight)
// with two `client:*` islands: one hydrates on its first interaction, one when it scrolls into
// view. Each component is imported only for its island, so the build splits it into a chunk of
// its own: until its trigger neither module loads and its server DOM stays inert. The page's
// context and the element's props reach both.
import { useState } from "denext";
import { Counter } from "./counter.tsx";
import { Far } from "./far.tsx";
import { Theme } from "./theme.ts";

export default function Page() {
  const [n, setN] = useState(0);
  return (
    <Theme.Provider value="dark">
      <main>
        <button type="button" data-testid="page" onClick={() => setN(n + 1)}>page {n}</button>
        <Counter client:interaction label="tap" />
        <div style={{ height: "4000px" }} />
        <Far client:visible label="far" start={5} />
      </main>
    </Theme.Provider>
  );
}
