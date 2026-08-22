import { Code } from "../components/ui.tsx";

const SAMPLE = `// app/page.tsx — an async Server Component
export default async function Home() {
  const posts = await getPosts();
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}`;

const FEATURES: { title: string; body: string }[] = [
  {
    title: "App Router, faithfully",
    body:
      "layout/page/loading/error, server components, streaming Suspense, parallel & intercepting routes, metadata — the conventions you already know.",
  },
  {
    title: "Zero-npm runtime",
    body:
      "The framework ships no npm at runtime — its own React 19-compatible core. Web standards all the way down: Request, Response, fetch, crypto.subtle.",
  },
  {
    title: "0 KB JS by default",
    body:
      'A page with no interactivity ships pure server-rendered HTML — no hydration bundle. Add "use client" only where you need it.',
  },
  {
    title: "Server Actions",
    body:
      "Progressive-enhancement forms that work with JavaScript disabled, CSRF-defended, with a generated same-origin endpoint.",
  },
  {
    title: "Batteries included",
    body:
      "Signed-cookie sessions, next/image optimization, next/font, next/og, ISR & Cache Components, i18n — first-party.",
  },
  {
    title: "SPA mode",
    body:
      'mode: "spa" runs an existing client-only React SPA — including unmodified npm-React libraries via the next-compat pipeline — on denext\'s toolchain, packaged with deno desktop.',
  },
  {
    title: "Live Server Components",
    body:
      "Server components that push updates over a WebSocket, plus Resumability and first-party auth (denextAuth) — the 1.1 flagships.",
  },
  {
    title: "Runs on Deno",
    body:
      "One toolchain, no node_modules. deno task dev / build / start. Deploy to Deno Deploy, a container, or any host.",
  },
];

export default function Landing() {
  return (
    <>
      <section class="hero">
        <span class="badge">This page ships 0 KB of JavaScript</span>
        <h1>
          Next.js's App Router,<br />reimplemented for <span class="accent">Deno</span>.
        </h1>
        <p class="tagline">
          If you know Next.js, you already know denext — the same file conventions, hooks, and
          `app/` router, with a zero-npm runtime and its own small React.
        </p>
        <div class="cta">
          <a class="btn primary" href="/docs/getting-started">Get started</a>
          <a class="btn" href="/docs/routing">Read the docs</a>
        </div>
        <Code lang="tsx">{SAMPLE}</Code>
      </section>

      <section class="features">
        {FEATURES.map((f) => (
          <div key={f.title} class="feature">
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section class="closing">
        <h2>You're standing in it</h2>
        <p>
          This docs site is a denext app, static-exported. Every page you read here is pure HTML —
          view source and you'll find no framework runtime, because these pages have no
          interactivity to hydrate. That's the default, not a mode you opt into.
        </p>
        <a class="btn primary" href="/docs/getting-started">Start building →</a>
      </section>
    </>
  );
}
