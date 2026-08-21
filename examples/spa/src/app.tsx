// A tiny client-only app. It owns its own routing (a minimal hashchange router)
// and state — denext never touches either. Swap this file's guts for TanStack
// Router, Redux, an Effect runtime, a WebSocket client, etc.: in SPA mode denext
// only bundles this graph and mounts it, exactly like Vite would.

import { useEffect, useState } from "denext";
import "./styles.css";

function useHashRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || "/");
  useEffect(() => {
    const onHash = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (to: string) => {
    location.hash = to;
  };
  return [route, navigate];
}

function Counter() {
  const [n, setN] = useState(0);
  return (
    <button
      type="button"
      data-testid="counter"
      onClick={() => setN((c) => c + 1)}
    >
      Clicked {n} times
    </button>
  );
}

export function App() {
  const [route, navigate] = useHashRoute();
  const tab = (to: string, label: string) => (
    <button
      type="button"
      aria-current={route === to}
      onClick={() => navigate(to)}
    >
      <span>{label}</span>
    </button>
  );
  return (
    <div class="card">
      <nav>
        {tab("/", "Home")}
        {tab("/about", "About")}
      </nav>
      {route === "/about"
        ? (
          <p data-testid="view">
            A zero-npm SPA, bundled and packaged by denext.
          </p>
        )
        : (
          <>
            <h1 data-testid="view">Hello from a denext SPA</h1>
            <Counter />
          </>
        )}
    </div>
  );
}
