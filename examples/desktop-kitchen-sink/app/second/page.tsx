// A second exported page: the window test's navigation phase (`app/navigation.tsx`) clicks a plain
// link here from Home and back, and loads it in full, asserting this page's marker each time. A
// desktop handler that served the root `index.html` for every route rendered Home here instead.
export default function Second() {
  return (
    <section>
      <h1 data-kitchen-page="second">Second page</h1>
      <p>
        A second page of the static export, reached by a plain link.{" "}
        <a href="/" id="kitchen-to-home">Back to the kitchen sink</a>
      </p>
    </section>
  );
}
