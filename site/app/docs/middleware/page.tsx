import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Middleware",
  description:
    "Run code before a request is routed — redirect, rewrite, gate access, or attach headers — from one middleware.ts at the project root.",
};

export default function Middleware() {
  return (
    <DocsShell
      active="middleware"
      title="Middleware"
      lead="Run code before a request is routed — redirect, rewrite, gate access, or attach headers. One middleware.ts at the project root."
    >
      <h2>middleware.ts</h2>
      <p>
        Export a function from <code>middleware.ts</code>, or from <code>proxy.ts</code>{" "}
        (Next.js 16's name for the same file), at the project root — in <code>src/</code> with the
        {" "}
        <code>src/app</code> layout. Export it as the default export or by name: <code>proxy</code>
        {" "}
        (Next 16) or <code>middleware</code>{" "}
        are both read, from either file. It runs before routing and can short-circuit with a
        response, redirect, rewrite the URL used for matching, or continue. Any of Next's extensions
        works (<code>.ts</code>, <code>.tsx</code>, <code>.js</code>, <code>.jsx</code>), and{" "}
        <code>.mts</code> / <code>.mjs</code> too.
      </p>
      <Callout kind="warn">
        Middleware fails closed. An app with more than one such file (<code>middleware.ts</code> and
        {" "}
        <code>proxy.ts</code>, or <code>middleware.ts</code> and{" "}
        <code>middleware.js</code>) does not start, and neither does one whose file exports no
        function as <code>proxy</code>, <code>middleware</code> or the default (a{" "}
        <code>config</code>{" "}
        alone, say). Both name the file, so a gate is never skipped without notice.
      </Callout>
      <Code lang="tsx">
        {`// middleware.ts
import { NextResponse } from "denext/next/server";
import type { NextRequest } from "denext/next/server";

export function middleware(request: NextRequest) {
  const session = request.cookies.get("session");
  if (!session && request.nextUrl.pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };`}
      </Code>

      <h2>The four outcomes</h2>
      <ul>
        <li>
          <code>NextResponse.next()</code>{" "}
          — continue to routing (optionally attach response headers or override request headers).
        </li>
        <li>
          <code>NextResponse.redirect(url)</code> — send the client elsewhere (307 by default).
        </li>
        <li>
          <code>NextResponse.rewrite(url)</code>{" "}
          — route as if the request were for another path, with no client-visible redirect.
        </li>
        <li>
          Return any <code>Response</code> — short-circuit immediately (e.g. a 401).
        </li>
      </ul>

      <h2>Matchers</h2>
      <p>
        Gate which paths run middleware with <code>config.matcher</code>. Patterns support{" "}
        <code>:param</code> (one segment), <code>:param*</code> (zero or more —{" "}
        <code>/dashboard/:path*</code> also matches <code>/dashboard</code>), <code>:param+</code>
        {" "}
        (one or more), <code>:param?</code> (optional), a custom pattern{" "}
        <code>:id(\\d+)</code>, a regex group like Next's{" "}
        <code>/((?!api|_next/static|favicon.ico).*)</code>, and{" "}
        <code>*</code>. A trailing slash is always optional. Omit it to run on every request.
      </p>
      <Code lang="ts">
        {`export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*", "/account"],
};`}
      </Code>
      <p>
        An object entry (<code>{"{ source, has, missing }"}</code>) also gates on the request, as in
        Next.js: every <code>has</code> condition must hold and no <code>missing</code>{" "}
        condition may. A condition names a <code>header</code>, <code>cookie</code>,{" "}
        <code>query</code> parameter (each with a <code>key</code>) or the{" "}
        <code>host</code>; without <code>value</code> it tests presence, and a <code>value</code>
        {" "}
        is an exact match, or a full-match regular expression when it contains regex syntax.
      </p>
      <Code lang="ts">
        {`export const config = {
  matcher: [{
    source: "/api/:path*",
    has: [{ type: "header", key: "authorization" }],
    missing: [{ type: "cookie", key: "preview", value: "1|true" }],
  }],
};`}
      </Code>

      <Callout kind="note">
        The handler receives a <code>NextRequest</code> with <code>nextUrl</code> and{" "}
        <code>cookies</code>. Set cookies on the response via <code>res.cookies.set(...)</code>{" "}
        — multiple <code>Set-Cookie</code> headers are preserved.
      </Callout>

      <h2>Attaching headers &amp; chains</h2>
      <p>
        Continue while adding response headers, or override the request headers the route sees:
      </p>
      <Code lang="tsx">
        {`export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", crypto.randomUUID());
  return NextResponse.next({ request: { headers } });
}`}
      </Code>
      <p>
        You can also export an array of handlers; they run in order, a returned{" "}
        <code>Response</code>{" "}
        short-circuits the chain, and a rewrite threads its URL into later entries. An entry may be
        {" "}
        <code>{"{ handler, config }"}</code>{" "}
        to give that handler its own matcher, inside the module's <code>config</code>.
      </p>

      <h2>Without the Next.js wrappers</h2>
      <p>
        <code>NextRequest</code> / <code>NextResponse</code>{" "}
        come from the compat layer. denext's own form takes a plain <code>Request</code>{" "}
        and a context, and returns a <code>Response</code> or one of the commands from{" "}
        <code>denext/server</code>: <code>next({"{ headers }"})</code> to continue,{" "}
        <code>rewrite(url)</code>, or <code>redirectResponse(location, status)</code>{" "}
        (307 by default). A thrown <code>redirect()</code> / <code>permanentRedirect()</code>{" "}
        becomes that 307 / 308 response. <code>ctx.waitUntil(promise)</code>{" "}
        keeps work running after the response, like <code>after()</code>.
      </p>
      <Code lang="ts">
        {`// middleware.ts
import { type MiddlewareContext, next, redirectResponse } from "denext/server";

export default function middleware(_request: Request, ctx: MiddlewareContext) {
  if (ctx.url.pathname === "/old") return redirectResponse("/new", 308);
  return next({ headers: { "x-served-by": "denext" } });
}`}
      </Code>
      <p>
        With the <code>denextAuth()</code> plugin, <code>requireAuth(request, {"{ role }"})</code>
        {" "}
        from <code>denext/server</code> returns the redirect for a visitor without that session, or
        {" "}
        <code>null</code> to continue — see <a href="/docs/auth">Auth</a>.
      </p>

      <Callout kind="warn">
        Middleware runs on the full Deno runtime (not a constrained edge isolate). A thrown error is
        reported to <code>instrumentation.ts</code>'s <code>onRequestError</code> with{" "}
        <code>routeType: "proxy"</code>.
      </Callout>
    </DocsShell>
  );
}
