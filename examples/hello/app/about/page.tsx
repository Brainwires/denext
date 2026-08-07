import type { PageProps } from "denext/server";

export const metadata = {
  title: "denext — about",
  description: "What denext is and how it works",
};

export default function About(_props: PageProps) {
  const features = [
    "File-based App Router (pages, layouts, dynamic + catch-all segments)",
    "Server-side rendering with a self-contained JSX runtime",
    "Client hydration with a small virtual-DOM reconciler",
    "API routes with method-based handlers",
    "Static file serving from public/",
    "Standard-library-only: no runtime npm dependencies",
  ];
  return (
    <section>
      <h1>About denext</h1>
      <p>denext reimplements the core of Next.js as native Deno code.</p>
      <ul>
        {features.map((f) => <li key={f}>{f}</li>)}
      </ul>
    </section>
  );
}
