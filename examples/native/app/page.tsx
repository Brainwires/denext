// A denext hook showcase — server-rendered, then hydrated identically on web,
// desktop (`deno desktop`), and mobile (Capacitor). A grid of cards each drives a
// different React-19 hook, one card time-slices a 2,000-row filter with
// useTransition/useDeferredValue, and a cat runs on top of everything chasing the
// pointer. The page owns the cat's state (props → declarative control) and a ref
// (imperative "summon"); see app/cat.tsx and app/demos.tsx.
import { useRef, useState } from "denext";
import type { PageProps } from "denext/server";
import { AccentProvider, Showcase } from "./demos.tsx";
import { Cat, type CatHandle } from "./cat.tsx";

export const metadata = { title: "denext native — hook showcase" };

export default function Home(_props: PageProps) {
  const [enabled, setEnabled] = useState(true);
  const [napping, setNapping] = useState(false);
  const [speed, setSpeed] = useState(4); // gentle default chase (px/frame)
  const [score, setScore] = useState(0);
  const [ignoreMouse, setIgnoreMouse] = useState(true); // default: just chase the rabbits
  const catRef = useRef<CatHandle>(null);

  return (
    <AccentProvider>
      {enabled && (
        <div class="scoreboard" aria-live="polite">
          <img src="/cat.png" alt="cat" width={22} height={22} />
          <span class="sb-score" key={score}>{score}</span>
          <span class="sb-hint">
            {score === 0
              ? "corner a rabbit!"
              : score === 1
              ? "rabbit cornered"
              : "rabbits cornered"}
          </span>
        </div>
      )}
      <header>
        <h1>
          denext, <span class="accent">everywhere</span>.
        </h1>
        <p class="muted">
          One codebase — web, desktop, and mobile. A pile of React hooks, a
          time-sliced 2,000-row list, and a cat that hunts the rabbits hopping
          around the page (and chases your pointer, if you let it).
        </p>
        <p class="small muted">
          <code>deno task dev</code> · <code>deno task desktop</code> ·{" "}
          <code>deno task mobile:sync</code>
        </p>
      </header>

      <Showcase
        enabled={enabled}
        napping={napping}
        speed={speed}
        ignoreMouse={ignoreMouse}
        onEnabled={setEnabled}
        onNap={setNapping}
        onSpeed={setSpeed}
        onIgnoreMouse={setIgnoreMouse}
        catRef={catRef}
      />

      <Cat
        enabled={enabled}
        napping={napping}
        speed={speed}
        ignoreMouse={ignoreMouse}
        onCapture={() => setScore((s) => s + 1)}
        ref={catRef}
      />
    </AccentProvider>
  );
}
