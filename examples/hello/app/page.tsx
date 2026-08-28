// Home page. Uses hooks, so it renders on the server AND hydrates on the client
// into an interactive counter — proving the SSR + hydration round-trip.

import { dynamic, useAsyncEffect, useEffect, useState } from "denext";
import type { PageProps } from "denext/server";

export const metadata = {
  title: "denext — home",
};

// Loaded only in the browser, in its own code-split chunk (never server-rendered).
const Island = dynamic(() => import("./island.tsx"), {
  ssr: false,
  loading: () => <p class="island">loading island…</p>,
});

export default function Home(_props: PageProps) {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  // Runs only in the browser after hydration; stays false in SSR output.
  useEffect(() => setHydrated(true), []);

  useAsyncEffect(async (signal) => {
    if (count % 5 === 0) {
      throw new Error("Count is a multiple of 5!");
    }
    await useAsyncEffect.setTimeout(signal, 1000, () => {
      console.log("Async effect ran!", count);
    });
  }, {
    catch: [Error],
    onError: (error) => {
      console.log("Caught error in async effect:", error.message);
    },
  }, [count]);

  return (
    <section>
      <h1>Hello from denext 👋</h1>
      <p>
        A Next.js-style framework rebuilt on Deno with{" "}
        <strong>zero runtime npm dependencies</strong>{" "}
        — its own JSX runtime, SSR, router, and client reconciler.
      </p>

      <div class="card">
        <p>
          Interactivity status:{" "}
          <span class={hydrated ? "on" : "off"}>
            {hydrated ? "hydrated ✅" : "server-rendered (not yet hydrated)"}
          </span>
        </p>
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          Clicked {count} {count === 1 ? "time" : "times"}
        </button>
      </div>

      <Island />

      <p class="hint">
        View source: the button count and the status above are driven by
        <code>useState</code>/<code>useEffect</code> running in your browser.
      </p>
    </section>
  );
}
