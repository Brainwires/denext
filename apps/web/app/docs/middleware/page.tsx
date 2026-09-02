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
        Export a default function from <code>middleware.ts</code> (or <code>proxy.ts</code>){" "}
        at the project root. It runs before routing and can short-circuit with a response, redirect,
        rewrite the URL used for matching, or continue.
      </p>
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
        <code>:param</code> (one segment), <code>:param*</code> (any depth), and{" "}
        <code>*</code>. Omit it to run on every request.
      </p>
      <Code lang="ts">
        {`export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*", "/account"],
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
        short-circuits the chain, and a rewrite threads its URL into later entries.
      </p>

      <Callout kind="warn">
        Middleware runs on the full Deno runtime (not a constrained edge isolate). A thrown error is
        reported to <code>instrumentation.ts</code>'s <code>onRequestError</code> with{" "}
        <code>routeType: "proxy"</code>.
      </Callout>
    </DocsShell>
  );
}
