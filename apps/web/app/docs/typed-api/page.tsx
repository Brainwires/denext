import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Typed API, end to end",
  description:
    "defineApi route handlers validated by Standard Schemas, a client typed from the routes themselves, batching and in-process SSR calls, typed live queries and server push — no tRPC, no codegen client, zero npm.",
};

export default function TypedApi() {
  return (
    <DocsShell
      active="typed-api"
      title="Typed API, end to end"
      lead="Declare a route handler's schemas once. Validation, the client's types, its error codes, the live query and the server push all derive from that — no tRPC, no hand-written client, no separate schema language."
    >
      <h2>The idea</h2>
      <p>
        A <code>route.ts</code> handler is a function over{" "}
        <code>Request → Response</code>; its body is whatever <code>req.json()</code>{" "}
        yields and a caller of your own API gets <code>any</code>{" "}
        back. denext closes both gaps in core: <code>defineApi</code>{" "}
        validates the request against Standard Schemas before your code runs, and the generated{" "}
        <code>.denext/api.ts</code> imports each route module's <em>type</em> so{" "}
        <code>createApiClient()</code> and <code>useApi</code>{" "}
        are checked against the routes themselves — path, method, params, query, body, response, and
        the error codes the route declares.
      </p>
      <Callout kind="note">
        Everything here is validator-agnostic: Zod, Valibot, ArkType, TypeBox, or a hand-rolled
        object with a <code>~standard</code>{" "}
        property all work, because denext speaks the Standard Schema interface, not a library.
      </Callout>

      <h2>A validated route handler</h2>
      <Code lang="ts">
        {`// app/api/posts/[id]/route.ts
import { createApi, defineApi, requireSession, rateLimit } from "denext/server";
import { z } from "zod";

export const GET = defineApi({
  params: z.object({ id: z.string() }),
  query: z.object({ expand: z.enum(["author", "none"]).optional() }),
  response: z.object({ id: z.string(), title: z.string() }), // strips undeclared keys — in prod too
  errors: { not_found: 404 },
}, async ({ params, query, fail }) => (await db.posts.get(params.id, query.expand)) ?? fail("not_found"));

const authed = createApi().use(rateLimit({ max: 60, windowMs: 60_000 })).use(requireSession());

export const PATCH = authed.define({
  params: z.object({ id: z.string() }),
  body: z.object({ title: z.string().min(1) }),
  errors: { not_owner: 403 },
}, async ({ params, body, ctx, fail }) => {
  if ((await db.posts.owner(params.id)) !== ctx.session.userId) fail("not_owner");
  return db.posts.update(params.id, body);
});`}
      </Code>
      <p>
        The order per request is body cap → middleware → validate → handler → response check, so
        {" "}
        <code>requireSession</code> and <code>rateLimit</code>{" "}
        reject before any schema runs and an unauthenticated caller learns nothing about the
        endpoint's shape. A mismatch is a structured 400:
      </p>
      <Code lang="json">
        {`{ "error": { "code": "validation", "status": 400, "message": "Validation failed",
             "fieldErrors": { "title": "String must contain at least 1 character(s)" },
             "data": { "source": "body" } } }`}
      </Code>
      <p>
        <code>fail("not_owner")</code> throws the declared 403 as the same envelope;{" "}
        <code>throw new ApiError(409, "conflict", {"{ data }"})</code>{" "}
        works from any handler, plain ones included. An unknown throw in a <code>defineApi</code>
        {" "}
        route is a redacted JSON 500 (<code>internal</code> + a <code>digest</code>{" "}
        that correlates with the server log), exactly like a <code>defineAction</code> error.
      </p>

      <h2>The typed client</h2>
      <Code lang="ts">
        {`import { createApiClient, isApiClientError } from "denext";
import type {} from "./.denext/api.ts"; // registers the schema — type-only, ships nothing

const api = createApiClient(); // typed against THIS app's routes

const post = await api("/api/posts/[id]", "GET", { params: { id: "1" }, query: { expand: "author" } });
//    ^? { id: string; title: string }

try {
  await api("/api/posts/[id]", "PATCH", { params: { id: "1" }, body: { title: "" } });
} catch (err) {
  if (isApiClientError(err)) err.code; // "not_owner" | "validation" | "unauthorized" | … (declared ∪ builtin)
}`}
      </Code>
      <ul>
        <li>
          <strong>Dedupe.</strong>{" "}
          Concurrent equal GET/HEAD calls share one fetch. During SSR the in-flight table is the
          request's own — two users' renders can never share a promise.
        </li>
        <li>
          <strong>Batching.</strong> The GET/HEAD calls a page makes in one tick ride one{" "}
          <code>POST /_denext/api-batch</code>. Same-origin only, a marker header a{" "}
          <code>{"<form>"}</code>{" "}
          cannot set, capped, and every item runs as a sub-request through the full pipeline, so
          middleware applies exactly as to a direct call. Mutations never batch.
        </li>
        <li>
          <strong>In-process on the server.</strong>{" "}
          A call made inside a request never goes over loopback HTTP: it runs through the pipeline
          under the caller's cookies, and with <code>next: {"{ tags }"}</code>{" "}
          it rides the tag-aware cache — <code>revalidateTag</code> purges it.
        </li>
        <li>
          <strong>The wire codec.</strong>{" "}
          A Date, Map, Set or BigInt in a body or response arrives intact; a plain-JSON payload is
          byte-identical to before.
        </li>
      </ul>

      <h2>The hook</h2>
      <Code lang="tsx">
        {`"use client";
import { useApi } from "denext";

export function Post({ id }: { id: string }) {
  const { data, error, pending, refetch } = useApi("/api/posts/[id]", "GET", { params: { id } });
  if (pending) return <p>…</p>;
  if (error) return <p>{error.code === "not_found" ? "Gone" : error.message}</p>;
  return <h1 onClick={() => void refetch()}>{data.title}</h1>;
}

// Suspense mode: the server runs the call in-process inside <Suspense>, records the value under
// the hook's useId(), and the client adopts it — hydration never refetches (Flight routes).
const { data } = useApi("/api/posts/[id]", "GET", { params: { id } }, { suspense: true });

// Refetch when the server revalidates a tag (needs the Live transport):
import { useApiLive } from "denext/live";
const posts = useApiLive("/api/posts", "GET", undefined, { tags: ["posts"] });`}
      </Code>

      <h2>Typed live queries — useSubscription</h2>
      <p>
        A <code>useLive</code>{" "}
        source that validates its input, derives its tags on the server, and gates every recompute:
      </p>
      <Code lang="ts">
        {`// app/live.ts
"use server";
import { defineSubscription } from "denext/server";

export const orderStatus = defineSubscription({
  input: z.object({ id: z.string() }),          // checked on every subscribe → invalid-input
  tags: ({ id }) => [\`order:\${id}\`],           // server-derived; the client's tags are ignored
  authorize: async ({ id }) => (await auth())?.userId === (await db.orders.owner(id)),
  resolve: ({ id }) => db.orders.status(id),    // re-pushed on revalidateTag("order:…")
});

// a client component
import { useSubscription } from "denext/live";
const { data, error, status } = useSubscription(orderStatus, { id }, { initial });`}
      </Code>
      <p>
        Registering a definition is the live opt-in — no <code>liveReadable</code>, no{" "}
        <code>canSubscribe</code>. The ref is also a plain callable (<code>
          await orderStatus({"{ id }"})
        </code>) so a Server Component can compute <code>initial</code>.
      </p>

      <h2>Server push — createChannel</h2>
      <p>
        Everything above is pull-recompute on a tag invalidation. A channel is the push half:
        arbitrary emits from anywhere on the server, no recompute.
      </p>
      <Code lang="ts">
        {`// app/live.ts
"use server";
import { createChannel } from "denext/server";

export const orderEvents = createChannel<{ status: string }>({
  schema: z.object({ status: z.string() }),          // validated at the PUBLISHER
  authorize: async (ctx, key) => key === \`user:\${(await getSession())?.data.userId}\`, // REQUIRED
});

// an action, a webhook, a cron, after() — anywhere:
await orderEvents.publish(\`user:\${userId}\`, { status: "shipped" });

// a client component
import { useChannel } from "denext/live";
const { data: event } = useChannel(orderEvents, \`user:\${userId}\`);`}
      </Code>
      <p>
        <code>authorize</code>{" "}
        is required by construction and runs in the subscriber's session at subscribe time, then
        lazily on traffic once the auth TTL passes (default 300 s); <code>channel.revoke(key)</code>
        {" "}
        ends access immediately, cluster-wide. An unknown channel id is{" "}
        <code>denied</code>, never a distinguishable "unknown". Delivery is at-most-once and
        latest-wins under back-pressure; there is no replay on reconnect (compute a cold-start value
        during SSR). Multi-instance delivery goes through a <code>ChannelTransport</code>:{" "}
        <code>broadcastChannelTransport()</code>{" "}
        for Deno Deploy isolates or workers, or two methods to implement for Redis/NATS.
      </p>

      <h2>What stays plain</h2>
      <p>
        A <code>route.ts</code> that exports a plain <code>GET(req) {"{ … }"}</code>{" "}
        still works, and is still typed when it returns{" "}
        <code>TypedResponse&lt;T&gt;</code>. Two things changed for every route handler:{" "}
        <code>redirect()</code> / <code>notFound()</code> / <code>forbidden()</code> /{" "}
        <code>unauthorized()</code>{" "}
        thrown inside one are now the HTTP responses they name (they used to be a 500), and request
        bodies are capped at 1 MiB (raise or lift with{" "}
        <code>export const maxBodyBytes = N | false</code>).
      </p>
      <p>
        See <code>examples/typed-api</code> for all of it in one runnable app.
      </p>
    </DocsShell>
  );
}
