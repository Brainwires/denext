import { useState } from "denext";

// A tiny client-owned "router" (hashless, state-driven) stands in for TanStack
// Router — the point is the SPA owns routing/state; denext never touches it.
export function App() {
  const [n, setN] = useState(0);
  const [view, setView] = useState<"home" | "about">("home");
  return (
    <main>
      <nav>
        <button type="button" data-testid="to-home" onClick={() => setView("home")}>Home</button>
        <button type="button" data-testid="to-about" onClick={() => setView("about")}>About</button>
      </nav>
      <h1 data-testid="view">{view === "home" ? "Home view" : "About view"}</h1>
      <button type="button" data-testid="counter" onClick={() => setN((c) => c + 1)}>
        count {n}
      </button>
    </main>
  );
}
