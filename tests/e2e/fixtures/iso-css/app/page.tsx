// Home page — interactive (useState/onClick) but with no "use client" boundary,
// so it is an ISOMORPHIC route: it hydrates and, on a soft nav, is served the
// compact iso payload rather than a full HTML document. Its per-route stylesheet
// (index.css, distinct `.probe` color) is supplied by the E2E test as a built
// artifact — see iso-css.e2e.test.ts for why it isn't a `.css` import here.

import { useState } from "denext";
import type { PageProps } from "denext/server";

export default function HomePage(_props: PageProps) {
  const [n, setN] = useState(0);
  return (
    <section>
      <p class="probe" data-testid="probe">home</p>
      <button type="button" data-testid="counter" onClick={() => setN((c) => c + 1)}>
        count {n}
      </button>
    </section>
  );
}
