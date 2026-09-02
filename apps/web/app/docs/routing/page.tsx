import { Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Routing",
  description: "File-convention routing under app/, identical to the Next.js App Router.",
};

export default function Routing() {
  return (
    <DocsShell
      active="routing"
      title="Routing"
      lead="File-convention routing under app/, identical to the Next.js App Router."
    >
      <h2>Conventions</h2>
      <Code lang="text">
        {`app/
  layout.tsx        root layout (wraps everything)
  page.tsx          /
  loading.tsx       Suspense fallback for the segment
  error.tsx         error boundary (a "use client" component)
  not-found.tsx     404 UI
  blog/
    [slug]/page.tsx /blog/:slug
  api/
    hello/route.ts  GET/POST/... returning a Response`}
      </Code>

      <h2>Dynamic segments</h2>
      <Code lang="tsx">
        {`// app/blog/[slug]/page.tsx
export default async function Post({ params }) {
  const post = await getPost(params.slug);
  if (!post) notFound();
  return <article><h1>{post.title}</h1></article>;
}`}
      </Code>
      <p>
        Catch-all (<code>[...all]</code>), optional catch-all (<code>
          [[...opt]]
        </code>), route groups (<code>(group)</code>), parallel routes (<code>
          @slot
        </code>), and intercepting routes (<code>(.)</code>) are all supported.
      </p>

      <h2>Route handlers</h2>
      <Code lang="ts">
        {`// app/api/hello/route.ts
export function GET(_req: Request): Response {
  return Response.json({ ok: true });
}`}
      </Code>

      <h2>Navigation & middleware</h2>
      <Code lang="tsx">
        {`import { Link } from "denext";
<Link href="/blog/hello">Read</Link>;

// middleware.ts — runs before routing
import { next, redirect } from "denext/server";
export default function middleware(req, ctx) {
  if (ctx.url.pathname === "/old") return redirect("/new", 308);
  return next();
}`}
      </Code>
      <p>
        Client navigation is a soft (SPA) transition that reconciles in place; a page with no
        interactivity still ships no JavaScript and navigates via full requests.
      </p>
    </DocsShell>
  );
}
