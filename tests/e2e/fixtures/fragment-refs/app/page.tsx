import { Hydrated } from "./hydrated.tsx";

// The server renders a `<Fragment ref>` (the ref is ignored there); hydration attaches it, then
// the client runs React's Fragment-ref cases against the real DOM (suite.tsx).
export default function Home() {
  return (
    <main>
      <Hydrated />
    </main>
  );
}
