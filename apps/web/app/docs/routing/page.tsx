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
      lead="File-convention routing under app/ — the same conventions as the Next.js App Router (deliberate differences are listed in KNOWN-DIFFERENCES, gaps in KNOWN-LIMITATIONS)."
    >
      <h2>Conventions</h2>
      <Code lang="text">
        {`app/
  layout.tsx        root layout (wraps everything)
  template.tsx      like a layout, but re-mounted on every navigation
  page.tsx          /
  loading.tsx       Suspense fallback for the segment
  error.tsx         error boundary (a "use client" component)
  global-error.tsx  root error boundary — replaces the whole tree
  not-found.tsx     404 UI
  forbidden.tsx     403 UI (forbidden())
  unauthorized.tsx  401 UI (unauthorized())
  blog/
    [slug]/page.tsx /blog/:slug
  api/
    hello/route.ts  GET/POST/... returning a Response
middleware.ts       runs before routing (proxy.ts is the same hook)`}
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
        Catch-all (<code>[...all]</code>, <code>params.all</code> is an array), optional catch-all
        {" "}
        (<code>[[...opt]]</code>), route groups (<code>(group)</code>{" "}
        — the folder name is omitted from the URL), parallel routes (<code>@slot</code>{" "}
        — rendered into the layout as a named prop), and intercepting routes (<code>(.)</code>{" "}
        same level, <code>(..)</code> one level up, <code>(...)</code>{" "}
        from the root — matched on soft navigation only) are all supported.
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
import type {} from "./.denext/api.ts"; // path relative to your file (type-only)
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

      <h2 id="navigation">Navigation</h2>
      <p>
        Client navigation is a soft (SPA) transition that reconciles in place; a page with no
        interactivity still ships no JavaScript and navigates via full requests. Everything below is
        exported from <code>denext</code>; the hooks are for <code>"use client"</code> components.
      </p>

      <h3 id="link">
        <code>Link</code>
      </h3>
      <Code lang="tsx">
        {`import { Link } from "denext";

<Link href="/blog/hello">Read</Link>
<Link href={{ pathname: "/search", query: { q: "deno", page: 2 } }}>Search</Link>
<Link href="/settings" replace scroll={false} prefetch={false}>Settings</Link>`}
      </Code>
      <p>
        An <code>&lt;a&gt;</code> that soft-navigates on a plain click (modifier keys,{" "}
        <code>target</code>, <code>download</code> and a user <code>onClick</code> that calls{" "}
        <code>preventDefault()</code> are left to the browser). Props beyond the anchor's own:
      </p>
      <ul>
        <li>
          <code>href</code> — a string, or an object with <code>pathname</code>, <code>query</code>
          {" "}
          (a record; nullish values are dropped) or <code>search</code>, and{" "}
          <code>hash</code>. With typed routes wired (below) the object form is{" "}
          <code>{'{ pathname: "/blog/[slug]", params: { slug } }'}</code>{" "}
          and denext fills the pattern.
        </li>
        <li>
          <code>replace</code> — replace the history entry instead of pushing one.
        </li>
        <li>
          <code>scroll</code> — scroll to the top after navigating (default <code>true</code>).
        </li>
        <li>
          <code>prefetch</code> — <code>null</code>{" "}
          (default) prefetches when the link scrolls into view; <code>true</code>{" "}
          also prefetches on hover; <code>false</code> disables prefetching.
        </li>
        <li>
          <code>legacyBehavior</code>, <code>passHref</code>, <code>shallow</code>,{" "}
          <code>locale</code>{" "}
          — accepted for Next.js compatibility; the last two are no-ops (shallow routing is not a
          denext concept; locales are routed by the <code>i18n</code> config).
        </li>
      </ul>
      <p>
        <code>useLinkStatus()</code> returns <code>{"{ pending }"}</code> for the <em>enclosing</em>
        {" "}
        <code>Link</code>{" "}
        — true from its click until that navigation settles, and always false outside a link — for
        an inline spinner:
      </p>
      <Code lang="tsx">
        {`"use client";
import { Link, useLinkStatus } from "denext";

function Spinner() {
  const { pending } = useLinkStatus();
  return pending ? <span aria-label="loading" class="spinner" /> : null;
}

export function NavItem({ href, children }) {
  return <Link href={href}>{children} <Spinner /></Link>;
}`}
      </Code>

      <h3 id="userouter">
        <code>useRouter</code> — programmatic navigation
      </h3>
      <Code lang="tsx">
        {`"use client";
import { useRouter } from "denext";

export function SaveButton({ id }: { id: string }) {
  const router = useRouter(); // one stable object — safe in effect deps
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch(\`/api/items/\${id}\`, { method: "PUT" });
        router.push(\`/items/\${id}\`);        // push a history entry (soft navigation)
        // router.replace(href, { scroll: false }) — replace it instead
        // router.refresh()                       — re-fetch and re-render the current route
        // router.prefetch(href)                  — warm the cache for a later push
        // router.back() / router.forward()       — history
      }}
    >
      Save
    </button>
  );
}`}
      </Code>
      <p>
        <code>refresh()</code>{" "}
        drops the prefetch cache and re-renders the current URL without a history entry — the way to
        show a Server Component's new data after a mutation you made outside a Server Action. (A
        Server Action that calls <code>revalidatePath</code> / <code>revalidateTag</code>{" "}
        refreshes the route on its own.)
      </p>

      <h3 id="reading-the-url">Reading the URL</h3>
      <Code lang="tsx">
        {`"use client";
import { useParams, usePathname, useSearchParams, useSelectedLayoutSegment } from "denext";

export function Crumbs() {
  const pathname = usePathname();          // "/blog/hello" — re-renders on navigation
  const params = useParams();              // { slug: "hello" } — [x] is a string, [...x] a string[]
  const search = useSearchParams();        // a read-only URLSearchParams; search.get("page")
  const segment = useSelectedLayoutSegment(); // the active child segment below this layout
  return <nav>{pathname} · {String(params.slug)} · {search.get("page") ?? 1} · {segment}</nav>;
}`}
      </Code>
      <p>
        <code>useSearchParams()</code> returns a <code>ReadonlyURLSearchParams</code>{" "}
        — reads and iteration work, the mutators throw (change the URL by navigating). Pass a{" "}
        <strong>Standard Schema</strong>{" "}
        (Zod, Valibot, ArkType) instead to get the query parsed and typed; repeated keys arrive as
        arrays, and an invalid query throws a <code>SearchParamsValidationError</code> (with{" "}
        <code>fieldErrors</code>) that the nearest <code>error.tsx</code> catches:
      </p>
      <Code lang="tsx">
        {`"use client";
import { useSearchParams } from "denext";
import { z } from "zod";

const Query = z.object({ page: z.coerce.number().int().min(1).default(1), tag: z.string().optional() });

export function Pager() {
  const { page, tag } = useSearchParams(Query); // typed: page is a number
  return <p>page {page}{tag ? \` · #\${tag}\` : ""}</p>;
}`}
      </Code>
      <p>
        Keep the schema a module constant so its identity is stable across renders (the hook
        memoizes on it), and keep it synchronous — a hook cannot await an async refinement.
      </p>

      <h3 id="active-links">Active links</h3>
      <Code lang="tsx">
        {`"use client";
import { Link, usePathname } from "denext";

export function NavLink({ href, children }: { href: string; children: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link href={href} aria-current={active ? "page" : undefined} class={active ? "active" : undefined}>
      {children}
    </Link>
  );
}`}
      </Code>
      <p>
        <code>aria-current="page"</code> is both the accessibility signal and a CSS hook (<code>
          a[aria-current="page"]
        </code>). Inside a layout, <code>useSelectedLayoutSegment()</code>{" "}
        gives the same answer per child segment without string-matching the pathname.
      </p>

      <h3 id="navigate-after-a-server-action">
        Navigating after a Server Action
      </h3>
      <p>
        Two options, with different semantics:
      </p>
      <Code lang="tsx">
        {`// 1. redirect() inside the action — works with JavaScript off, ends the action.
"use server";
import { redirect, RedirectType } from "denext";
export async function createPost(formData: FormData) {
  const id = await db.posts.insert({ title: String(formData.get("title")) });
  redirect(\`/posts/\${id}\`);                      // a same-origin 303 for a native post; a full navigation for the client runtime
  // redirect("/posts", RedirectType.replace)    — replace the history entry instead of pushing
}

// 2. router.push() after the action resolves — a soft navigation, from the component.
"use client";
import { idleActionState, useActionState, useEffect, useRouter } from "denext";
import { createPost } from "./actions.ts";
export function NewPost() {
  const router = useRouter();
  const [state, action] = useActionState(createPost, idleActionState<{ id: string }>());
  useEffect(() => {
    if (state.ok) router.push(\`/posts/\${state.data.id}\`);
  }, [state, router]);
  return <form action={action}>…</form>;
}`}
      </Code>
      <p>
        Prefer <code>redirect()</code>{" "}
        when the destination is decided on the server or the form must work without JavaScript.
        Prefer <code>router.push</code>{" "}
        when you want the soft transition (layouts keep their state), or need the action's result
        first — note that a <code>redirect()</code>{" "}
        from an action is a full navigation for the client runtime, not a soft one.
      </p>

      <h3 id="typed-routes">Typed routes</h3>
      <p>
        <code>denext build</code> and <code>denext dev</code> write <code>.denext/routes.ts</code>:
        {" "}
        <code>Routes</code> (every page path, dynamic segments as <code>{"${string}"}</code>),{" "}
        <code>ApiRoutes</code>, <code>RouteParams</code> and{" "}
        <code>ParamsOf&lt;R&gt;</code>. Importing the file once registers the routes with denext,
        and from then on:
      </p>
      <ul>
        <li>
          <code>&lt;Link href&gt;</code>, <code>router.push</code>/<code>replace</code> and{" "}
          <code>redirect()</code> only accept real paths — a typo is a compile error.
        </li>
        <li>
          The object form is checked too:{" "}
          <code>{'{ pathname: "/blog/[slug]", params: { slug } }'}</code>{" "}
          requires the params the pattern needs and fills it for you.
        </li>
        <li>
          <code>useParams&lt;"/blog/[slug]"&gt;()</code> is <code>{"{ slug: string }"}</code>.
        </li>
      </ul>
      <Code lang="tsx">
        {`import "./.denext/routes.ts"; // once, anywhere (e.g. app/layout.tsx) — registers the routes
import type { ParamsOf, Routes } from "./.denext/routes.ts";

const go = (href: Routes) => router.push(href);              // only real paths compile
router.push({ pathname: "/blog/[slug]", params: { slug } });  // → /blog/<slug>
type BlogParams = ParamsOf<"/blog/[slug]">;                    // { slug: string }
const { slug } = useParams<"/blog/[slug]">();                  // typed`}
      </Code>
      <p>
        Nothing changes at runtime; before the import, <code>href</code> is a plain{" "}
        <code>string</code> and the object form is the loose Next.js <code>UrlObject</code>.
      </p>

      <h2>Middleware</h2>
      <Code lang="tsx">
        {`// middleware.ts — runs before routing
import { next, redirectResponse } from "denext/server";
export default function middleware(req, ctx) {
  if (ctx.url.pathname === "/old") return redirectResponse("/new", 308);
  return next();
}`}
      </Code>
      <p>
        The full hook — matchers, rewrites, headers, auth gating — is on the{" "}
        <a href="/docs/middleware">Middleware</a> page.
      </p>
    </DocsShell>
  );
}
