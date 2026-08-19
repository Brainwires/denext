export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <p>
        This page is served at <code>/</code> and also at <code>/home</code>{" "}
        — the alias is contributed by <code>aliasesPlugin</code>{" "}
        via the route-synthesizer seam, no file duplicated.
      </p>
      <p>
        <a href="/about">/about</a> · <a href="/about-us">/about-us</a>
      </p>
    </main>
  );
}
