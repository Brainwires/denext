import { Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Routing",
  description:
    "File-convention routing under app/, the same conventions as the Next.js App Router.",
};

export default function Routing() {
  return (
    <DocsShell
      active="routing"
      title="Routing"
      lead="File-convention routing under app/ — the same conventions as the Next.js App Router (divergences are listed in KNOWN-LIMITATIONS)."
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
      <p>
        Parallel-route slots follow Next.js's two rules: on a hard load a slot the URL does not
        match renders its{" "}
        <code>default.tsx</code>, and on a soft (client) navigation it keeps whatever it was showing
        — including the <code>children</code>{" "}
        page when the new URL only addresses a slot. The server records which URL each slot last
        matched and the client echoes that on its soft-nav fetches (the{" "}
        <code>x-denext-slot-state</code>{" "}
        header), so the behavior needs no client-side state of your own.
      </p>
      <p>
        <code>notFound()</code>, <code>forbidden()</code> and <code>unauthorized()</code>{" "}
        are caught per segment, exactly as in Next.js: each level's <code>not-found.tsx</code> (or
        {" "}
        <code>forbidden.tsx</code> /{" "}
        <code>unauthorized.tsx</code>) is a boundary around that level's page and children, nested
        inside the level's own layout. So a throw from a page renders the nearest such file inside
        its layouts, while a throw from a <em>layout</em>{" "}
        escalates to the parent level (the throwing layout is not rendered). With no file anywhere,
        the framework's built-in UI renders inside the root layout. The response status is
        404/403/401 when the signal fires before the shell flushes; inside a streamed Suspense hole
        the UI still swaps in, at 200.
      </p>

      <h2>Route handlers</h2>
      <Code lang="ts">
        {`// app/api/hello/route.ts
export function GET(_req: Request): Response {
  return Response.json({ ok: true });
}`}
      </Code>
      <p>
        Return <code>TypedResponse&lt;T&gt;</code> (and take a{" "}
        <code>TypedRequest&lt;B&gt;</code>) from <code>denext/server</code> and{" "}
        <code>denext dev</code>/<code>build</code> generate <code>.denext/api.ts</code>;{" "}
        <code>createApiClient</code>{" "}
        then type-checks every call to your own API — a wrong path, method, param or body is a
        compile error, with no tRPC.
      </p>
      <Code lang="ts">
        {`// app/api/user/[id]/route.ts
import { json, type TypedResponse } from "denext/server";
export function GET(): TypedResponse<{ id: string; name: string }> {
  return json({ id: "1", name: "Ada" }); // json() === Response.json() at runtime
}

// anywhere (a component, a test)
import { createApiClient } from "denext";
import type {} from "./.denext/api.ts"; // registers the schema (type-only)
const api = createApiClient();
const user = await api("/api/user/[id]", "GET", { params: { id: "1" } }); // typed`}
      </Code>
      <p>
        To validate the request too, declare the schemas with{" "}
        <code>defineApi</code>: the handler receives parsed, typed input and a mismatch is a
        structured 400 before it runs. The generated schema infers the endpoint's body, query,
        response and error codes from it.
      </p>
      <Code lang="ts">
        {`import { defineApi } from "denext/server";
export const POST = defineApi({
  body: z.object({ name: z.string().min(1) }),
  errors: { duplicate: 409 },
}, async ({ body, fail }) => {
  if (await db.users.exists(body.name)) fail("duplicate");
  return db.users.create(body);
});`}
      </Code>
      <p>
        Every route handler, plain or defined: <code>redirect()</code>, <code>notFound()</code>,
        {" "}
        <code>forbidden()</code> and <code>unauthorized()</code>{" "}
        thrown inside one are the HTTP responses they name; a thrown{" "}
        <code>ApiError(status, code)</code>{" "}
        is a typed JSON error envelope; request bodies are capped at 1 MiB (<code>
          export const maxBodyBytes = N | false
        </code>{" "}
        per route). The full tour — the client, batching, in-process SSR calls, live queries and
        server push — is on the <a href="/docs/typed-api">Typed API</a> page.
      </p>

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
