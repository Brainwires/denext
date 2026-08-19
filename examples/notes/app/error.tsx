"use client";

// Error boundary. When a route below it throws during render — e.g. opening the
// edit page for a note you don't own — this UI is shown instead of a broken page.
// `reset()` re-attempts the render.

import type { ErrorFallbackProps } from "denext";

export default function Error({ error, reset }: ErrorFallbackProps) {
  return (
    <section class="boundary">
      <h1>Something went wrong</h1>
      <p class="slug">{error.message}</p>
      {error.digest ? <p class="digest">Reference: {error.digest}</p> : null}
      <div class="row">
        <button type="button" onClick={() => reset()}>Try again</button>
        <a href="/notes" class="linkbtn">Back to my notes</a>
      </div>
    </section>
  );
}
