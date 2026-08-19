import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export default function Auth() {
  return (
    <DocsShell
      active="auth"
      title="Auth"
      lead="First-party OAuth 2.0 / OIDC and Credentials auth — zero-npm, secure by default — plus the low-level signed-cookie sessions it's built on."
    >
      <h2>First-party auth — denextAuth</h2>
      <p>
        <code>denextAuth</code>{" "}
        adds sign-in with Google, GitHub, any OIDC provider, and email/password — with no npm
        dependency. Add it as a plugin in <code>denext.config.ts</code> and the <code>/auth/*</code>
        {" "}
        endpoints mount automatically (nothing to write under <code>app/</code>).
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import { denextAuth, google, credentials } from "@denext/denext/server";

export default {
  plugins: [
    denextAuth({
      secret: Deno.env.get("AUTH_SECRET")!,   // HMAC secret (string | string[] to rotate)
      canonicalOrigin: "https://example.com", // required in prod (stable redirect_uri)
      providers: [
        google({ clientId: G_ID, clientSecret: G_SECRET }),
        credentials({
          authorize: async ({ email, password }) => {
            const user = await lookup(email, password); // constant-time compare
            return user ? { id: user.id, name: user.name, email } : null;
          },
        }),
      ],
    }),
  ],
};`}
      </Code>
      <p>
        Read the session in any Server Component, <code>route.ts</code>, or middleware with{" "}
        <code>auth()</code>, and gate routes with <code>requireAuth()</code>:
      </p>
      <Code lang="tsx">
        {`import { auth, requireAuth } from "@denext/denext/server";

// A Server Component
export default async function Account() {
  const session = await auth();
  if (!session) return <a href="/auth/signin/google">Sign in</a>;
  return <p>Hello {session.user.name}</p>;
}

// middleware.ts — redirect anonymous users to sign-in
export async function middleware(request: Request) {
  return await requireAuth(request); // Response (redirect) or null to continue
}
export const config = { matcher: ["/dashboard/:path*"] };`}
      </Code>
      <p>On the client, the familiar NextAuth-style surface:</p>
      <Code lang="tsx">
        {`"use client";
import { SessionProvider, useSession, signIn, signOut } from "@denext/denext";

function UserMenu() {
  const { user, status } = useSession();
  if (status === "loading") return null;
  return user
    ? <button onClick={() => signOut()}>Sign out {user.name}</button>
    : <button onClick={() => signIn("google")}>Sign in</button>;
}`}
      </Code>
      <Callout kind="note">
        Secure by default: the session cookie is signed and{" "}
        <code>__Host-</code>-prefixed (never stores tokens), OIDC{" "}
        <code>id_token</code>s are verified against the provider's JWKS (RS256 +{" "}
        <code>iss</code>/<code>aud</code>/<code>exp</code>/<code>nonce</code>), the OAuth flow uses
        PKCE + a CSRF <code>state</code>, provider calls go through the SSRF-safe{" "}
        <code>safeFetch</code>, and the <code>redirect_uri</code> is pinned to{" "}
        <code>canonicalOrigin</code> so a spoofed Host header can't steal the code.
      </Callout>

      <h2>Sessions</h2>
      <p>
        <code>getSession</code>{" "}
        gives you a signed (HMAC-SHA256) cookie session. Store an id in it and load the user per
        request:
      </p>
      <Code lang="ts">
        {`import { getSession } from "denext/server";

const session = await getSession<{ userId: number }>({
  secret: Deno.env.get("SESSION_SECRET")!, // string | string[] (rotation)
});

session.data;                 // { userId } | null (null if absent/forged/expired)
await session.set({ userId }); // sign in
session.clear();               // sign out`}
      </Code>

      <h2>Sign in with a Server Action</h2>
      <Code lang="ts">
        {`// app/actions.ts
"use server";
import { redirect } from "denext";
import { getSession } from "denext/server";

export async function login(formData: FormData) {
  const user = await verify(formData.get("email"), formData.get("password"));
  if (!user) redirect("/login?error=1");
  await (await getSession({ secret: SECRET })).set({ userId: user.id });
  redirect("/");
}`}
      </Code>
      <p>
        The <code>{"<form action={login}>"}</code>{" "}
        works with JavaScript disabled — denext renders a same-origin, CSRF-checked endpoint into
        the form and redirects back after the action runs.
      </p>

      <h2>Gate routes with middleware</h2>
      <Code lang="ts">
        {`// middleware.ts
import { next, redirect } from "denext/server";
import { getSession } from "denext/server";

export default async function middleware(_req, ctx) {
  if (ctx.url.pathname.startsWith("/app")) {
    const s = await getSession({ secret: SECRET });
    if (!s.data) return redirect("/login", 307);
  }
  return next();
}`}
      </Code>

      <Callout kind="note">
        Cookies default to <code>HttpOnly</code> + <code>SameSite=Lax</code> + <code>Secure</code>
        {" "}
        (over HTTPS). Pass <code>{"{ httpOnly: false }"}</code>{" "}
        to opt out for a client-readable cookie.
      </Callout>

      <h2>Cross-tab token refresh with withWebLock</h2>
      <p>
        If your client holds a short-lived access token and refreshes it against a{" "}
        <strong>one-time-use</strong>{" "}
        refresh cookie, multiple open tabs can race the refresh — one tab rotates the cookie and the
        others get logged out. <code>withWebLock</code>{" "}
        (a thin wrapper over the standard Web Locks API, exported from <code>denext</code>){" "}
        single-flights that refresh across every tab of the origin.
      </p>
      <Code lang="ts">
        {`import { withWebLock } from "denext";

function refresh(): Promise<string> {
  // Only one tab runs this at a time; the others wait here.
  return withWebLock("auth:refresh", async () => {
    if (tokenIsFresh()) return getToken();   // a tab ahead of us already refreshed
    const res = await fetch("/api/refresh", { method: "POST" });
    if (!res.ok) throw new Error("session expired");
    return storeToken(await res.json());
  });
}`}
      </Code>
      <p>
        The lock is same-origin and auto-releases when the callback settles (or the tab closes), so
        it can't deadlock. It also degrades gracefully: during SSR, or in a browser without the API,
        the callback simply runs uncoordinated.{" "}
        <code>
          {'withWebLock(name, fn, { mode: "shared", ifAvailable, signal })'}
        </code>{" "}
        covers the other options.
      </p>

      <Callout kind="note">
        The same primitive fits any "only one tab should do this" job — a one-time client migration,
        or electing a single leader tab for a shared connection.
      </Callout>
    </DocsShell>
  );
}
