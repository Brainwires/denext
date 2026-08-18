// Rendered (with a 404 status) when a page calls `notFound()` — e.g. opening a
// note id that doesn't exist.

export default function NotFound() {
  return (
    <section class="boundary">
      <h1>Not found</h1>
      <p class="slug">That note doesn't exist.</p>
      <a href="/notes" class="linkbtn">Back to my notes</a>
    </section>
  );
}
