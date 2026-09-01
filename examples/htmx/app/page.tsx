import { hx } from "@denext/htmx";

// This page uses only htmx attributes — no hooks, no `onClick` — so denext
// classifies it static and ships ZERO KB of denext client JS. htmx does the work.
export default function Home() {
  return (
    <div>
      <h1>denext + htmx</h1>
      <p class="muted">
        This whole page ships 0 KB of denext JavaScript. Every interaction below is htmx swapping
        server-rendered HTML fragments.
      </p>

      <div class="card">
        <h2>Click to load</h2>
        <div class="row">
          {/* Raw hx-* attributes — always work, no import needed. */}
          <button
            type="button"
            hx-post="/clicked"
            hx-target="#clicked-out"
            hx-swap="innerHTML"
          >
            Click me
          </button>
          <span id="clicked-out" class="muted">not clicked yet</span>
        </div>
      </div>

      <div class="card">
        <h2>Active search</h2>
        <p class="muted">Typed authoring via the {`hx()`} helper.</p>
        <input
          type="search"
          name="q"
          placeholder="Search fruit…"
          {...hx({
            post: "/search",
            trigger: "input changed delay:200ms, search",
            target: "#search-out",
            swap: "innerHTML",
          })}
        />
        <div id="search-out">
          <SearchResults items={FRUIT} />
        </div>
      </div>
    </div>
  );
}

export const FRUIT = [
  "Apple",
  "Apricot",
  "Banana",
  "Blackberry",
  "Blueberry",
  "Cherry",
  "Grape",
  "Mango",
  "Orange",
  "Peach",
  "Pear",
  "Pineapple",
];

export function SearchResults({ items }: { items: string[] }) {
  if (items.length === 0) return <p class="muted">No matches.</p>;
  return (
    <ul>
      {items.map((f) => <li key={f}>{f}</li>)}
    </ul>
  );
}
