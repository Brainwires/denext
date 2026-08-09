// Home page. Uses a hook, so it server-renders AND hydrates — the same app runs
// on the web, in a `deno desktop` window, and inside a Capacitor mobile shell.
import { useState } from "denext";
import type { PageProps } from "denext/server";

export const metadata = { title: "denext native — home" };

export default function Home(_props: PageProps) {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>denext, everywhere.</h1>
      <p class="muted">One codebase. Web, desktop, and mobile.</p>
      <p>
        Run <code>deno task desktop</code> for a native window.
      </p>
      <p>
        Run <code>deno task mobile:sync</code> for iOS/Android.
      </p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>
    </main>
  );
}
