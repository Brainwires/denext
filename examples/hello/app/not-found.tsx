// Root not-found UI, rendered on notFound() or an unmatched nested path.

export default function NotFound() {
  return (
    <section>
      <h1>404 — Page not found</h1>
      <p>We couldn't find what you were looking for.</p>
      <p>
        <a href="/">← Back home</a>
      </p>
    </section>
  );
}
