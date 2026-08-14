import { Link } from "denext";

export default function Home() {
  return (
    <section>
      <h1>Caching &amp; revalidation</h1>
      <p class="lede">
        denext ships the Next.js data-cache and ISR primitives. Two demos:
      </p>
      <ul class="cards">
        <li>
          <Link href="/data">
            <strong>Data cache →</strong>
            <span>
              <code>unstable_cache</code>{" "}
              memoizes an expensive "fetch" across requests with a TTL and a
              tag; <code>revalidateTag</code> purges it on demand.
            </span>
          </Link>
        </li>
        <li>
          <Link href="/isr">
            <strong>ISR →</strong>
            <span>
              <code>export const revalidate</code>{" "}
              caches a whole rendered page and regenerates it in the background
              (stale-while-revalidate).
            </span>
          </Link>
        </li>
      </ul>
    </section>
  );
}
