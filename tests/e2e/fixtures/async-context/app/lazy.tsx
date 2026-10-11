"use client";
// Lazily imported, and instrumented: the async transition below must keep its scope across
// `await gate`, so an unrelated urgent update made while it is pending stays urgent.
import { useEffect, useState, useTransition } from "denext";
import { useGatedCounter } from "./counter.ts";

// deno-lint-ignore no-explicit-any
const probe = globalThis as any;

export default function Lazy() {
  const [n, setN] = useState(0);
  const [pending, start] = useTransition();
  // The same transition, awaited inside a plain `.ts` hook (./counter.ts).
  const ts = useGatedCounter();
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
    let releaseTs = () => {};
    probe.__acTsStart = () => ts.run(new Promise<void>((resolve) => (releaseTs = resolve)), 10);
    probe.__acTsUrgent = () => {
      ts.setN((x) => x + 1);
      return Promise.resolve().then(() => document.getElementById("ac-ts-count")?.textContent);
    };
    probe.__acTsRelease = () => releaseTs();
    probe.__acReady = true;
  }, []);
  return (
    <>
      <p id="ac-count" data-pending={String(pending)}>{n}</p>
      <p id="ac-ts-count" data-pending={String(ts.pending)}>{ts.n}</p>
    </>
  );
}
