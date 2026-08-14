// Root error boundary — mirrors examples/hello/app/error.tsx. Error boundaries
// are Client Components in Next's App Router.
"use client";

export default function ErrorPage(
  { error, reset }: { error: Error & { digest?: string }; reset: () => void },
) {
  return (
    <section>
      <h1>Something went wrong</h1>
      <p className="slug">{error.message}</p>
      <button type="button" onClick={() => reset()}>Try again</button>
    </section>
  );
}
