import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · islands",
  description:
    "Directive-based islands: each client:* island hydrates on its own schedule — load, idle, visible, interaction, media, or client-only.",
  head: `<link rel="stylesheet" href="/styles.css">` +
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">denext · islands</span>
        <code class="flag">
          client:load | idle | visible | interaction | media | only
        </code>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        Six directives, 6/6 Astro parity · each island ships and hydrates on its own schedule
      </footer>
    </div>
  );
}
