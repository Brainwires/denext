import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export default function Auth() {
  return (
    <DocsShell
      active="auth"
      title="Auth"
      lead="Signed-cookie sessions built in — HMAC-verified, secure by default, no dependency."
    >
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
        <code>{'withWebLock(name, fn, { mode: "shared", ifAvailable, signal })'}</code>{" "}
        covers the other options.
      </p>

      <Callout kind="note">
        The same primitive fits any "only one tab should do this" job — a one-time client migration,
        or electing a single leader tab for a shared connection.
      </Callout>
    </DocsShell>
  );
}
