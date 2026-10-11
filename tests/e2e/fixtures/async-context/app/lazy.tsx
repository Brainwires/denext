"use client";
// Lazily imported, and instrumented: the async transition below must keep its scope across
// `await gate`, so an unrelated urgent update made while it is pending stays urgent.
import { useEffect, useState, useTransition } from "denext";

// deno-lint-ignore no-explicit-any
const probe = globalThis as any;

export default function Lazy() {
  const [n, setN] = useState(0);
  const [pending, start] = useTransition();
  useEffect(() => {
    let release = () => {};
    probe.__acStart = () => {
      const gate = new Promise<void>((resolve) => (release = resolve));
      start(async () => {
        await gate;
        setN((x) => x + 10);
      });
    };
    // An update made outside any event handler and outside the transition. Read back after
    // one microtask: an urgent (sync-lane) update has committed by then, a transition-lane one
    // (the time-window fallback) waits for its scheduled task.
    probe.__acUrgent = () => {
      setN((x) => x + 1);
      return Promise.resolve().then(() => document.getElementById("ac-count")?.textContent);
    };
    probe.__acRelease = () => release();
    probe.__acReady = true;
  }, []);
  return <p id="ac-count" data-pending={String(pending)}>{n}</p>;
}
