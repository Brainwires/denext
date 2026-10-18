// An isomorphic, cacheable route (no "use client" boundary; `revalidate` makes it cacheable, so
// with `cacheComponents` it is served from a cached static shell). Its `useApi` call suspends
// on the server; the shell carries the result, so the client must hydrate with it and never
// call `/api/hello` on mount. The counter proves the page hydrated.

import { Suspense, useApi, useState } from "denext";
import type { PageProps } from "denext/server";

export const revalidate = 60;

function Greeting() {
  const { data } = useApi("/api/hello" as never, "GET" as never, undefined, { suspense: true });
  return <p data-testid="greeting">{(data as unknown as { hello: string }).hello}</p>;
}

export default function HomePage(_props: PageProps) {
  const [n, setN] = useState(0);
  return (
    <section>
      <Suspense fallback={<p data-testid="greeting">loading…</p>}>
        <Greeting />
      </Suspense>
      <button type="button" data-testid="counter" onClick={() => setN((c) => c + 1)}>
        count {n}
      </button>
    </section>
  );
}
