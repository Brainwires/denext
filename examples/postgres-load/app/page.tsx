import { getStats } from "../lib/db.ts";
import { hit } from "./actions.ts";

// A dynamic Server Component: it reads Postgres on every request (no caching),
// so the count you see is always live. Writes go through the Server Action and
// the /api/hit endpoint the load harness targets.
export const dynamic = "force-dynamic";

export default async function Home() {
  const { total, recent } = await getStats();
  return (
    <>
      <h1>Postgres under load</h1>
      <p class="lede">
        A networked Postgres pool, driven by denext. This page reads the database on every request;
        the load harness hammers <code>/api/hit</code>{" "}
        to prove the connection pool holds up when concurrency far exceeds the pool size.
      </p>

      <div class="counter">
        <span class="n">{total.toLocaleString()}</span>
        <span class="label">visits recorded</span>
      </div>

      <form action={hit} method="post">
        <button type="submit">Record a visit</button>
      </form>

      <h2>Recent</h2>
      <ul class="recent">
        {recent.length === 0
          ? (
            <li class="empty">
              No visits yet — click the button or run the load test.
            </li>
          )
          : recent.map((v, i) => (
            <li key={i}>
              <code>{v.path}</code> <time>{v.at}</time>
            </li>
          ))}
      </ul>

      <h2>Run the load test</h2>
      <pre>{`# terminal 1 — start the server\ndeno task start\n\n# terminal 2 — 5000 requests, 100 concurrent\nCONCURRENCY=100 REQUESTS=5000 deno run -A load.ts`}</pre>
    </>
  );
}
