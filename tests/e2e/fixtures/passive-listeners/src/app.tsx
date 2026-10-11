// A ScrollArea-like viewport: its handlers record what they saw, and the wheel handler calls
// `preventDefault()`, which a passive listener ignores (in React too), so the wheel still scrolls.
// As React's synthetic event does, the handler's event reads prevented for the rest of that
// dispatch while the native event keeps the browser's own flag. The wheel handler also calls
// `stopPropagation()`: the native listener on <main> (below the root container) still runs, the
// document's does not, as with React's root listener.
import { useEffect, useRef } from "denext";

/** What the handlers saw, read by the test. */
const seen = {
  touchstart: 0,
  touchend: 0,
  touchmove: 0,
  wheel: 0,
  wheelPrevented: [] as boolean[],
  wheelIsPrevented: [] as boolean[],
  /** `defaultPrevented` of the same event once the dispatch is over (the native flag). */
  wheelPreventedAfter: [] as boolean[],
  mainNative: 0,
  documentNative: 0,
};
(globalThis as unknown as { __seen: typeof seen }).__seen = seen;

export function App() {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const onMain = () => void seen.mainNative++;
    const onDocument = () => void seen.documentNative++;
    main.current!.addEventListener("wheel", onMain, { passive: true });
    document.addEventListener("wheel", onDocument, { passive: true });
    return () => {
      main.current?.removeEventListener("wheel", onMain);
      document.removeEventListener("wheel", onDocument);
    };
  }, []);
  return (
    <main ref={main}>
      <h1 data-ready="1">Passive listeners</h1>
      <div
        data-testid="viewport"
        style={{ height: "240px", width: "320px", overflow: "auto", border: "1px solid #888" }}
        onTouchStart={() => void seen.touchstart++}
        onTouchMove={() => void seen.touchmove++}
        onTouchEnd={() => void seen.touchend++}
        onTouchStartCapture={() => {}}
        onTouchMoveCapture={() => {}}
        onWheelCapture={() => {}}
        onWheel={(e) => {
          seen.wheel++;
          e.preventDefault();
          e.stopPropagation();
          seen.wheelPrevented.push(e.defaultPrevented);
          seen.wheelIsPrevented.push(e.isDefaultPrevented());
          setTimeout(() => seen.wheelPreventedAfter.push(e.defaultPrevented));
        }}
      >
        {Array.from({ length: 60 }, (_, i) => <p key={i}>Row {i + 1}</p>)}
      </div>
    </main>
  );
}
