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
    </DocsShell>
  );
}
