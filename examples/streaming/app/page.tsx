import { Link } from "denext";

export default function Home() {
  return (
    <section>
      <h1>Streaming &amp; Suspense</h1>
      <p class="lede">Two flavours of asynchronous rendering:</p>
      <ul class="cards">
        <li>
          <Link href="/dashboard">
            <strong>Dashboard →</strong>
            <span>
              Async Server Components, each in its own{" "}
              <code>&lt;Suspense&gt;</code>{" "}
              boundary. Page rendering awaits them (buffered SSR), so the
              delivered HTML already holds the resolved data. A{" "}
              <code>loading.tsx</code>{" "}
              is the route-level fallback shown during a client navigation.
            </span>
          </Link>
        </li>
        <li>
          <a href="/stream">
            <strong>Streamed SSR →</strong>
            <span>
              True out-of-order streaming via{" "}
              <code>renderToReadableStream</code>: the shell (with fallbacks)
              flushes immediately, then each <code>&lt;Suspense&gt;</code>{" "}
              boundary is swapped in as its data resolves.
            </span>
          </a>
        </li>
      </ul>
    </section>
  );
}
