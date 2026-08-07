// Root error boundary UI. Receives the caught error and a reset() callback.

import type { ErrorFallbackProps } from "denext";

export default function ErrorPage({ error, reset }: ErrorFallbackProps) {
  return (
    <section>
      <h1>Something went wrong</h1>
      <p class="slug">{error.message}</p>
      <button type="button" onClick={() => reset()}>Try again</button>
    </section>
  );
}
