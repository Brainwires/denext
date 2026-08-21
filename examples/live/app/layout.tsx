import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · live data & presence",
  description:
    "usePresence + useLive over a WebSocket, secured with an experimental.live policy.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">denext · live</span>
        <code class="flag">experimental.live policy</code>
      </header>
      <main class="content">{children}</main>
    </div>
  );
}
