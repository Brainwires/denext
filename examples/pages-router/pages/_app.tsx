// Custom `_app` — wraps every page. The `.shell` node is shared across routes,
// so a correct soft navigation reconciles it in place (never remounts it).

import "../styles/globals.css";

// deno-lint-ignore no-explicit-any
export default function App({ Component, pageProps }: { Component: any; pageProps: any }) {
  return (
    <div>
      <header className="shell">pages-router shell</header>
      <Component {...pageProps} />
    </div>
  );
}
