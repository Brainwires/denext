import type { LayoutProps } from "@denext/denext/server";
import { Htmx } from "@denext/htmx";

export const metadata = {
  title: "denext + htmx",
  description: "An htmx app on denext via @denext/htmx — 0 KB of denext client JS",
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>denext + htmx</title>
        <style>{CSS}</style>
      </head>
      <body>
        <main>{children}</main>
        {/* Loads /_denext/htmx/htmx.min.js from this origin — served by the plugin. */}
        <Htmx />
      </body>
    </html>
  );
}

const CSS = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; }
  main { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.6rem; }
  button, input { font: inherit; padding: 0.5rem 0.75rem; border-radius: 0.4rem; border: 1px solid #8888; }
  button { cursor: pointer; }
  .row { display: flex; gap: 0.5rem; align-items: center; margin: 1rem 0; }
  .card { border: 1px solid #8884; border-radius: 0.6rem; padding: 1rem 1.25rem; margin: 1.5rem 0; }
  ul { margin: 0.5rem 0 0; padding-left: 1.2rem; }
  .muted { opacity: 0.7; font-size: 0.9rem; }
`;
