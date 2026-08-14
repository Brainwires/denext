// Home page — mirrors examples/hello/app/page.tsx. Interactive (useState +
// useEffect hydration flag + a code-split ssr:false island), so it is a client
// component that ships JS and hydrates — the same boundary denext's home has.
"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

// Loaded only in the browser, in its own code-split chunk (never server-rendered).
const Island = dynamic(() => import("./island"), {
  ssr: false,
  loading: () => <p className="island">loading island…</p>,
});

export default function Home() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  return (
    <section>
      <h1>Hello from denext 👋</h1>
      <p>
        A Next.js-style framework rebuilt on Deno with{" "}
        <strong>zero runtime npm dependencies</strong>{" "}
        — its own JSX runtime, SSR, router, and client reconciler.
      </p>

      <div className="card">
        <p>
          Interactivity status:{" "}
          <span className={hydrated ? "on" : "off"}>
            {hydrated ? "hydrated ✅" : "server-rendered (not yet hydrated)"}
          </span>
        </p>
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          Clicked {count} {count === 1 ? "time" : "times"}
        </button>
      </div>

      <Island />

      <p className="hint">
        View source: the button count and the status above are driven by{" "}
        <code>useState</code>/<code>useEffect</code> running in your browser.
      </p>
    </section>
  );
}
