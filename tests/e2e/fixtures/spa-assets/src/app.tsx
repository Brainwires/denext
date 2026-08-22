import { useEffect, useState } from "react";
import dataUrl from "./data.bin?url";
import DoublerWorker from "./worker.ts?worker";

export function App() {
  const [doubled, setDoubled] = useState<number | null>(null);
  useEffect(() => {
    const w = new DoublerWorker();
    w.onmessage = (e: MessageEvent) => setDoubled(e.data as number);
    w.postMessage(21);
    return () => w.terminate();
  }, []);
  return (
    <main>
      <p data-testid="asset-url">url:{dataUrl}</p>
      <p data-testid="worker-result">
        {doubled === null ? "pending" : `doubled:${doubled}`}
      </p>
    </main>
  );
}
