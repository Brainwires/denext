import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Effect",
  description:
    "First-class Effect on denext via @denext/effect: run an Effect from a Server Component, route handler, or Server Action and get typed errors, Layer-based dependency injection, structured concurrency, and client-disconnect cancellation — wired into denext's per-request context.",
};

export default function Effect() {
  return (
    <DocsShell
      active="effect"
      title="Effect"
      lead="@denext/effect bridges the Effect library into denext's per-request context. Run an Effect from a Server Component, route handler, or Server Action and get typed errors, dependency injection (services from a Layer), structured concurrency, and client-disconnect cancellation. Effect is npm-only, so the package depends on npm:effect as a peer — there is no runtime to serve; it's a set of bridges, not an asset."
    >
      <h2>Install</h2>
      <p>
        Effect is distributed on npm (deliberately not published to JSR), so add both{" "}
        <code>@denext/effect</code> and <code>effect</code> to your import map:
      </p>
      <Code lang="jsonc">
        {`// deno.json
{
  "imports": {
    "@denext/effect": "jsr:@denext/effect@^0.1.0",
    "effect": "npm:effect@^3.22.0"
  }
}`}
      </Code>
      <Callout kind="note">
        Unlike <a href="/docs/htmx">@denext/htmx</a>, this package serves <strong>nothing</strong>
        {" "}
        — it ships no runtime and adds no bytes to a page that doesn't use it.{" "}
        <code>npm:effect</code> is pulled only into code that imports{" "}
        <code>@denext/effect</code>. denext's own runtime stays zero-npm.
      </Callout>

      <h2>Run an Effect in a Server Component</h2>
      <p>
        Any async Server Component can <code>await runEffect(...)</code>. The{" "}
        <code>DenextRequest</code>{" "}
        service resolves the live request from denext's per-request context — no prop-drilling:
      </p>
      <Code lang="tsx">
        {`// app/page.tsx
import { Effect } from "effect";
import { DenextRequest, runEffect } from "@denext/effect";

export default async function Page() {
  const auth = await runEffect(
    Effect.map(DenextRequest, (req) => req.request.headers.get("authorization")),
  );
  return <p>auth: {auth ?? "anonymous"}</p>;
}`}
      </Code>

      <h2>Typed errors, mapped to output</h2>
      <p>
        Use <code>runEffectExit</code> to branch on a <strong>typed failure</strong>{" "}
        instead of catching a throw — the natural fit for turning an error channel into rendered
        output, a response, or form state:
      </p>
      <Code lang="tsx">
        {`import { Effect, Exit } from "effect";
import { DenextRequest, runEffectExit } from "@denext/effect";

const program = Effect.gen(function* () {
  const req = yield* DenextRequest;
  if (!req.request.headers.get("x-auth")) {
    return yield* Effect.fail({ _tag: "Unauthorized" } as const); // typed error
  }
  return "secret";
});

export default async function Page() {
  const exit = await runEffectExit(program);
  if (Exit.isSuccess(exit)) return <p>{exit.value}</p>;
  return <p>Denied.</p>;
}`}
      </Code>

      <h2>Dependency injection (services + layers)</h2>
      <p>
        Provide app-wide services once, then <code>yield*</code>{" "}
        them anywhere. Define a service and its <code>Layer</code>:
      </p>
      <Code lang="ts">
        {`// services.ts
import { Context, Effect, Layer } from "effect";

export class Db extends Context.Tag("app/Db")<Db, {
  userName: (id: string) => Effect.Effect<string>;
}>() {}

export const AppLayer = Layer.succeed(Db, {
  userName: (id) => Effect.succeed(\`user#\${id}\`),
});`}
      </Code>

      <h3>Option A — the effect() plugin (ambient)</h3>
      <p>
        Register the layer in <code>denext.config.ts</code>. It's built <strong>once</strong>{" "}
        (a memoized runtime — a database pool is constructed a single time, not per request) and
        disposed on shutdown, running every <code>Layer</code>/<code>acquireRelease</code>{" "}
        finalizer:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import { effect } from "@denext/effect";
import { AppLayer } from "./services.ts";

export default { plugins: [effect({ layer: AppLayer })] };`}
      </Code>
      <p>
        The ambient <code>runEffect</code> then resolves those services at run time.
      </p>

      <h3>Option B — createEffectRuntime (fully typed)</h3>
      <p>
        For the compiler to <strong>check</strong>{" "}
        that every service your Effects require is provided, build a typed runner instead of relying
        on the ambient global:
      </p>
      <Code lang="ts">
        {`// effect-runtime.ts
import { createEffectRuntime } from "@denext/effect";
import { AppLayer } from "./services.ts";

export const { runEffect, runEffectExit } = createEffectRuntime(AppLayer);`}
      </Code>
      <p>
        These <code>runEffect</code>/<code>runEffectExit</code>{" "}
        accept only Effects whose requirements are satisfied by the layer,{" "}
        <code>DenextRequest</code>, or <code>Scope</code> — a missing service is a{" "}
        <strong>compile error</strong>.
      </p>
      <Callout kind="note">
        The ambient <code>runEffect</code> (Option A) accepts any Effect requiring only{" "}
        <code>DenextRequest</code>/<code>Scope</code>{" "}
        at the type level; app services from the plugin's layer are present at run time but not
        reflected in the type. Reach for <code>createEffectRuntime</code>{" "}
        when you want the requirements type-checked.
      </Callout>

      <h2>Route handlers and Server Actions</h2>
      <p>
        <code>effectHandler</code> adapts an{" "}
        <code>Effect</code>-returning function into a route handler (success <code>Response</code>
        {" "}
        passthrough, typed failure → <code>onError</code>, defect → 500):
      </p>
      <Code lang="ts">
        {`// app/api/user/route.ts
import { Effect } from "effect";
import { effectHandler } from "@denext/effect";

export const GET = effectHandler(
  () => Effect.succeed(Response.json({ ok: true })),
  { onError: (e) => Response.json({ error: e }, { status: 400 }) },
);`}
      </Code>
      <p>
        <code>effectAction</code> adapts one into a <a href="/docs/server-actions">Server Action</a>
        {" "}
        that resolves to a serializable result — the direct fit for <code>useActionState</code>:
      </p>
      <Code lang="ts">
        {`// app/actions.ts
"use server";
import { Effect } from "effect";
import { effectAction } from "@denext/effect";

// Resolves to { ok: true, value } | { ok: false, error }.
export const subscribe = effectAction((email: string) =>
  email.includes("@")
    ? Effect.succeed({ email })
    : Effect.fail({ _tag: "InvalidEmail" as const })
);`}
      </Code>

      <h2>How it works</h2>
      <ul>
        <li>
          <strong>The request is provided per run, never memoized.</strong> A{" "}
          <code>ManagedRuntime</code> memoizes its layers, so <code>DenextRequest</code>{" "}
          is layered on <em>each run</em> via <code>Effect.provideService</code>{" "}
          (read from the ambient context) — putting it in the runtime's layer would capture one
          request and serve it to every later run. The memoized runtime holds only the app layer.
        </li>
        <li>
          <strong>The request's abort signal interrupts the run.</strong>{" "}
          On client disconnect or timeout the fiber is interrupted; thread the same{" "}
          <code>signal</code> into your own <code>fetch()</code>es for cooperative cancellation.
        </li>
        <li>
          <strong>
            Every run is <code>Effect.scoped</code>.
          </strong>{" "}
          Resources acquired with <code>acquireRelease</code>{" "}
          inside an Effect are released when that run completes.
        </li>
      </ul>

      <h2>Where it fits</h2>
      <p>
        Effect is a general TypeScript library for typed errors, dependency injection, and
        structured concurrency. On denext it slots into the async seams —{" "}
        <a href="/docs/data">data fetching</a>, <a href="/docs/server-actions">Server Actions</a>,
        {" "}
        and route handlers — where its typed error channel and <code>Layer</code>{" "}
        DI replace thrown exceptions and prop-drilled dependencies. Reach for it when you want
        composable, type-safe effects across a request; skip it for a page that just renders.
      </p>
    </DocsShell>
  );
}
