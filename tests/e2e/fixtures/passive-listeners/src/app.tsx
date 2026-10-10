// A ScrollArea-like viewport: its handlers record what they saw, and the wheel handler calls
// `preventDefault()`, which a passive listener ignores (in React too), so the wheel still scrolls.
import { useRef } from "denext";

/** What the handlers saw, read by the test. */
const seen: { touchmove: number; wheel: number; wheelPrevented: boolean[] } = {
  touchmove: 0,
  wheel: 0,
  wheelPrevented: [],
};
(globalThis as unknown as { __seen: typeof seen }).__seen = seen;

export function App() {
  const viewport = useRef<HTMLDivElement>(null);
  return (
    <main>
      <h1 data-ready="1">Passive listeners</h1>
      <div
        ref={viewport}
        data-testid="viewport"
        style={{ height: "240px", width: "320px", overflow: "auto", border: "1px solid #888" }}
        onTouchStart={() => {}}
        onTouchMove={() => void seen.touchmove++}
        onTouchEnd={() => {}}
        onTouchStartCapture={() => {}}
        onTouchMoveCapture={() => {}}
        onWheelCapture={() => {}}
        onWheel={(e) => {
          seen.wheel++;
          e.preventDefault();
          seen.wheelPrevented.push(e.defaultPrevented);
        }}
      >
        {Array.from({ length: 60 }, (_, i) => <p key={i}>Row {i + 1}</p>)}
      </div>
    </main>
  );
}
