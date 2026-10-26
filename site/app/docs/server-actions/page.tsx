import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Server Actions",
  description:
    "Server-side functions you can call straight from a form or a client event — no API route, no fetch boilerplate. CSRF-defended and progressively enhanced.",
};

export default function ServerActions() {
  return (
    <DocsShell
      active="server-actions"
      title="Server Actions"
      lead="Server-side functions you can call straight from a form or a client event — no API route, no fetch boilerplate. CSRF-defended and progressively enhanced."
    >
      <h2>Write an action</h2>
      <p>
        Mark a module (or a single function) with <code>"use server"</code>{" "}
        and export an async function. It runs only on the server; the client gets a typed stub that
        posts to a generated same-origin endpoint.
      </p>
      <Callout kind="note">
        The stub replaces the module in every client bundle and in the dev server, however the
        import is spelled — relative, an import-map alias (<code>@/app/actions.ts</code>,{" "}
        <code>#actions</code>), a re-export or a barrel — so the module's source and any secret in
        it stay on the server. A client bundle that would still ship a <code>"use server"</code>
        {" "}
        module fails the build, naming the module and the imports that reached it. A SPA has no
        server to call, so a SPA that imports one is refused.
      </Callout>
      <Code lang="tsx">
        {`// app/actions.ts
"use server";
import { revalidatePath } from "denext/server";

export async function createNote(formData: FormData) {
  const title = String(formData.get("title") ?? "");
  await db.notes.insert({ title });
  revalidatePath("/notes"); // re-render the list on the next load
}`}
      </Code>

      <h2>Use it from a form</h2>
      <p>
        Pass the action to a{" "}
        <code>{"<form action={...}>"}</code>. With JavaScript it posts in the background;{" "}
        <strong>with JavaScript disabled it still works</strong>{" "}
        — the form posts normally and the page reloads.
      </p>
      <Code lang="tsx">
        {`import { createNote } from "./actions.ts";

export default function NewNote() {
  return (
    <form action={createNote}>
      <input name="title" required />
      <button>Add note</button>
    </form>
  );
}`}
      </Code>

      <h2>Inline actions and bound values</h2>
      <p>
        A Server Component may declare the action inside itself, with <code>"use server"</code>{" "}
        opening the function's body. The server render hoists it to a registered action, so its form
        renders the endpoint and works with or without JavaScript. When it reads the component's
        values (a prop, a local), they are bound to it: sealed with AES-GCM into the form's action,
        so the browser can neither read nor change them, and handed back to the action when the form
        posts. <code>action.bind(null, value)</code>{" "}
        on an imported action binds values the same way.
      </p>
      <Code lang="tsx">
        {`import { deleteNote } from "./actions.ts";

export default async function Note({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  async function rename(formData: FormData) {
    "use server";
    await db.notes.rename(id, String(formData.get("title"))); // \`id\` is bound
  }
  return (
    <>
      <form action={rename}><input name="title" /><button>Rename</button></form>
      <form action={deleteNote.bind(null, id)}><button>Delete</button></form>
    </>
  );
}`}
      </Code>
      <p>
        Bound values must be JSON-like (strings, numbers, arrays, plain objects, <code>Date</code>,
        {" "}
        <code>Map</code>, <code>Set</code>, <code>BigInt</code>,{" "}
        <code>URL</code>); a function or class instance fails the render naming the action. The key
        is new per <code>denext build</code>; replicas built separately share one through{" "}
        <code>DENEXT_SERVER_ACTIONS_ENCRYPTION_KEY</code> (base64 of 16, 24 or 32 bytes; Next.js's
        {" "}
        <code>NEXT_SERVER_ACTIONS_ENCRYPTION_KEY</code>{" "}
        is read too). A token is sealed for its own action: it never opens for another one. An
        inline action can't be declared in a <code>"use client"</code>{" "}
        module (the build fails with Next.js's error), and anyone who has the page can still post
        its form again — check who is calling inside the action.
      </p>

      <Callout kind="note">
        Every action request is verified same-origin (Origin/Referer) before it runs, so an action
        can't be triggered cross-site — CSRF defense is built in. Actions are POST-only.
      </Callout>

      <h2>Action ids and which actions are exposed</h2>
      <p>
        As in Next.js 15, an action's id is not derived from your source alone: it is an HMAC of the
        module and export name under a secret <code>denext build</code>{" "}
        generates (recorded in the server-only{" "}
        <code>.denext/manifest.json</code>), so a new build gets new ids and an open-source app's
        ids can't be computed. Replicas started from one build agree. When one deploy builds more
        than once (an image per replica, a build per region, a <code>denext export</code>{" "}
        served next to a separate <code>denext build</code>), set{" "}
        <code>DENEXT_ACTION_ID_SECRET</code> (at least 16 characters;{" "}
        <code>openssl rand -base64 32</code>) to the same value for every build and every instance —
        where <code>denext build</code>{" "}
        runs, not only at runtime: the build's secret is the one the client bundle carries ids for,
        so a server started with the variable set to another value ignores it with a warning (and
        reports <code>action-ids: "down"</code> on{" "}
        <code>/_denext/health</code>) when the build generated its own, and refuses to start when
        the build used the variable and the server has another value or none. Inline actions are
        keyed by their module's project-relative path, so builds of one source at different paths
        agree. A page rendered by an older build posts ids the new one does not know: the request
        answers <code>409</code> with{" "}
        <code>x-denext-action: unknown</code>, and the page reloads itself once to pick the new ids
        up (never in a loop: a page whose actions stay unknown after the reload just fails the
        call), as an expired Next.js action makes the page reload.
      </p>
      <p>
        Only the exports your app's modules import are callable: imported into a client component,
        imported by a Server Component that renders it as a <code>{"<form action>"}</code> /{" "}
        <code>formAction</code> or passes it down, bound with{" "}
        <code>.bind</code>, or reached through a re-export (
        <code>export {"{ save } from"}</code>,{" "}
        <code>export *</code>). Inline actions are always registered. An export no module imports
        answers exactly as a random id does (404). Whatever the build can't follow by name (<code>
          import * as actions
        </code>, a literal <code>import()</code>) exposes every export of that module.{" "}
        <code>denext build</code> lists the exports it left out, and <code>denext dev</code>{" "}
        keeps them callable but warns the first time one is called.
      </p>
      <p>
        Neither replaces authorization: an exposed action is a public endpoint anyone who can load
        the page may call with any arguments. Check the session and validate the input inside every
        action.
      </p>

      <h2>Return values &amp; redirects</h2>
      <p>
        Call an action from a client component and <code>await</code> its return value, or{" "}
        <code>redirect()</code> from inside it (forced to a safe same-origin 303 for no-JS posts).
      </p>
      <Code lang="tsx">
        {`"use server";
import { redirect } from "denext";

export async function signIn(formData: FormData) {
  const user = await authenticate(formData);
  if (!user) return { error: "Invalid credentials" };
  redirect("/dashboard");
}`}
      </Code>

      <h2>Typed actions — defineAction</h2>
      <p>
        A bare action takes raw <code>FormData</code> and returns whatever.{" "}
        <code>defineAction</code>{" "}
        validates the fields into a typed input — a parser function or any Standard Schema (Zod,
        Valibot, ArkType, …) — and its result type flows into{" "}
        <code>useActionState</code>. Validation errors reach the form verbatim (they are authored
        for the user); any other throw is redacted in production to a generic message plus a{" "}
        <code>digest</code>.
      </p>
      <Code lang="ts">
        {`// app/actions.ts
"use server";
import { ActionValidationError, defineAction } from "denext/server";
export const createPost = defineAction({
  input: z.object({ title: z.string().min(1) }),           // or (f) => ({ title: String(f.title) })
  handler: async ({ title }) => {
    if (await db.posts.exists(title)) throw new ActionValidationError("Taken", { title: "Taken" });
    return { id: await db.posts.insert({ title }) };       // Out inferred: { id: string }
  },
});

// app/new-post.tsx
"use client";
import { idleActionState, useActionState } from "denext";
import { createPost } from "./actions.ts";
const [state, action] = useActionState(createPost, idleActionState<{ id: string }>());
// state.ok ? state.data.id : state.fieldErrors?.title   — both typed`}
      </Code>
      <p>
        The handler may also <em>return</em> the failure:{" "}
        <code>return err("Taken", {'{ fieldErrors: { title: "Taken" } }'})</code> (<code>err</code>
        {" "}
        from <code>denext/result</code>) resolves to the same failed <code>ActionResult</code>{" "}
        as the thrown <code>ActionValidationError</code>, unredacted, and the success type{" "}
        <code>useActionState</code>{" "}
        sees excludes it. The message must be a string and the details may carry only{" "}
        <code>fieldErrors</code> (the <code>ActionErr</code> type from{" "}
        <code>denext/server</code>); anything else is a compile error. See{" "}
        <a href="/docs/errors-as-values">Errors as values</a>.
      </p>

      <h2>Refreshing cached data</h2>
      <p>
        After a write, tell the framework what to invalidate. All are importable from{" "}
        <code>denext/server</code>:
      </p>
      <ul>
        <li>
          <code>revalidatePath(path)</code> / <code>revalidateTag(tag)</code>{" "}
          — purge cached renders or tagged data.
        </li>
        <li>
          <code>updateTag(tag)</code>{" "}
          — read-your-writes: the same request recomputes so the response reflects the write.
        </li>
        <li>
          <code>refresh()</code>{" "}
          — re-fetch the current route's uncached data without touching the cache.
        </li>
      </ul>

      <Callout kind="warn">
        Actions receive the visitor's cookies. Treat every argument as untrusted input — validate on
        the server, and never trust a hidden form field for authorization.
      </Callout>
    </DocsShell>
  );
}
