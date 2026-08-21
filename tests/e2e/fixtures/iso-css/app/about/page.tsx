// About page — another isomorphic route. Its per-route stylesheet (about.css)
// sets the same `.probe` selector to a different color than Home's, so a soft nav
// between them is observable via getComputedStyle only if the per-route
// stylesheet is actually swapped. The artifact is written by the E2E test.

import { useState } from "denext";
import type { PageProps } from "denext/server";

export default function AboutPage(_props: PageProps) {
  const [n, setN] = useState(0);
  return (
    <section>
      <p class="probe" data-testid="probe">about</p>
      <button type="button" data-testid="counter" onClick={() => setN((c) => c + 1)}>
        count {n}
      </button>
    </section>
  );
}
