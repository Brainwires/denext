import { useLoaderData } from "react-router";

export function loader() {
  return { greeting: "hello from a loader" };
}

// Loader data arrives BOTH as a component prop (React Router v7's `Route.ComponentProps`) and
// through `useLoaderData` — both work on denext.
export default function Home({ loaderData }: { loaderData: { greeting: string } }) {
  const viaHook = useLoaderData<typeof loader>();
  return (
    <main>
      <h1 id="home">{loaderData.greeting}</h1>
      <p>Same value via the hook: {viaHook.greeting}</p>
      <ul>
        <li>
          <a href="/about">/about</a>
        </li>
        <li>
          <a href="/teams">/teams</a> → <a href="/teams/42">/teams/42</a>
        </li>
        <li>
          <a href="/api/health">/api/health</a> (resource route)
        </li>
        <li>
          <a href="/boom">/boom</a> (throws → ErrorBoundary)
        </li>
      </ul>
    </main>
  );
}
