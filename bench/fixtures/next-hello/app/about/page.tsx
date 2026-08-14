// About — mirrors examples/hello/app/about/page.tsx. Pure static server
// component: no hooks, no interactivity, so it should ship ZERO client JS
// (the denext equivalent is a detected static route that ships nothing).

export const metadata = {
  title: "denext — about",
  description: "What denext is and how it works",
};

export default function About() {
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
