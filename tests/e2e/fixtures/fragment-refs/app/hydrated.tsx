"use client";
import { Fragment, useEffect, useLayoutEffect, useRef } from "denext";
import type { FragmentInstance } from "denext";
import { runSuite } from "./suite.tsx";

/** What the e2e test reads back. */
const results = globalThis as {
  __hydrated?: { attached: boolean; handle: boolean; serverNodes: number };
  __fragSuite?: { done: boolean; passed: string[]; failures: string[] };
};

// Server-rendered, then hydrated: the ref must be attached by the time layout effects run, on the
// server's own nodes. Once hydrated, run the ported React cases.
export function Hydrated() {
  const ref = useRef<FragmentInstance | null>(null);
  useLayoutEffect(() => {
    const a = document.getElementById("h-a") as
      | (Element & { reactFragments?: Set<unknown> })
      | null;
    results.__hydrated = {
      attached: ref.current !== null,
      handle: a?.reactFragments?.has(ref.current) === true,
      serverNodes: document.querySelectorAll("#h-a").length,
    };
  }, []);
  useEffect(() => {
    setTimeout(() => {
      results.__fragSuite = runSuite();
    }, 0);
  }, []);
  return (
    <section id="hydrated">
      <Fragment ref={ref}>
        <span id="h-a">a</span>
        <span id="h-b">b</span>
      </Fragment>
    </section>
  );
}
