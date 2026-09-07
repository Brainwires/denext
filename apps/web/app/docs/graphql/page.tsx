import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "GraphQL",
  description:
    "A GraphQL endpoint for a denext app via the @denext/graphql plugin: GraphQL Yoga at /graphql, subscriptions that ride denext channels (no second event bus), the SDL written at build, and a denext graphql CI verb.",
};

export default function GraphQL() {
  return (
    <DocsShell
      active="graphql"
      title="GraphQL"
      lead="@denext/graphql mounts a GraphQL Yoga server at /graphql through the plugin contract, bridges subscriptions onto denext channels — the app's push primitive, so there is no second event bus and no separate WebSocket server — writes the schema SDL at build, and adds a denext graphql verb for CI. Any GraphQLSchema works; Pothos (code-first, typed, no decorators) is the recommended builder."
    >
      <h2>Install</h2>
      <p>
        GraphQL Yoga and <code>graphql</code>{" "}
        are npm-only, so the package depends on them as peers — the same opt-in-npm principle as
        {" "}
        <a href="/docs/effect">@denext/effect</a>. denext's own runtime stays zero-npm.
      </p>
      <Code lang="jsonc">
        {`// deno.json
{
  "imports": {
    "@denext/graphql": "jsr:@denext/graphql@^0.1.0",
    "graphql": "npm:graphql@^16.9.0",
    "graphql-yoga": "npm:graphql-yoga@^5.10.0",
    "@pothos/core": "npm:@pothos/core@^4"
  }
}`}
      </Code>
      <Code lang="ts">
        {`// denext.config.ts
import { graphql } from "@denext/graphql";
import { schema } from "./app/graphql/schema.ts";

export default { plugins: [graphql({ schema })] };`}
      </Code>
      <p>
        The endpoint is a plugin request handler, so a page at <code>/graphql</code>{" "}
        would always win — the plugin never shadows an app route. GraphiQL answers a browser{" "}
        <code>GET</code> in dev only.
      </p>

      <h2>A schema with Pothos</h2>
      <Code lang="ts">
        {`// app/graphql/schema.ts
import SchemaBuilder from "@pothos/core";
import { fromChannel } from "@denext/graphql";
import { auth } from "denext/server";
import { messages } from "./channels.ts"; // createChannel<{ text: string }>({ authorize })

const builder = new SchemaBuilder<{ Context: { signal: AbortSignal } }>({});
const Message = builder.objectRef<{ text: string }>("Message").implement({
  fields: (t) => ({ text: t.exposeString("text") }),
});

builder.queryType({
  fields: (t) => ({
    viewer: t.string({ nullable: true, resolve: async () => (await auth())?.userId ?? null }),
  }),
});
builder.mutationType({
  fields: (t) => ({
    post: t.boolean({
      args: { room: t.arg.string({ required: true }), text: t.arg.string({ required: true }) },
      resolve: async (_root, { room, text }) => {
        await messages.publish(room, { text }); // → every GraphQL subscriber AND every useChannel
        return true;
      },
    }),
  }),
});
builder.subscriptionType({
  fields: (t) => ({
    messages: t.field({
      type: Message,
      args: { room: t.arg.string({ required: true }) },
      subscribe: (_root, { room }, ctx) => fromChannel(messages, room, { signal: ctx.signal }),
      resolve: (payload) => payload,
    }),
  }),
});

export const schema = builder.toSchema();`}
      </Code>
      <p>
        Resolvers run inside denext's request context: <code>cookies()</code>,{" "}
        <code>headers()</code>, <code>auth()</code>, <code>getSession()</code>{" "}
        and the typed API client work in them exactly as in a route handler. The{" "}
        <code>context</code> option builds your resolvers' context from the request:{" "}
        <code>graphql({"{ schema, context: ({ request, signal }) => ({ signal }) }"})</code>.
      </p>

      <h2>Subscriptions over channels</h2>
      <p>
        <code>fromChannel(channel, key)</code> returns the payloads published to one key of a{" "}
        <a href="/docs/live">
          <code>createChannel</code>
        </a>{" "}
        as an <code>AsyncIterable</code> — what a <code>subscribe</code>{" "}
        resolver returns. Yoga streams it as GraphQL over SSE, which every GraphQL client supports.
        The same <code>publish</code> reaches every <code>useChannel</code>{" "}
        subscriber on the Live socket, and a <code>ChannelTransport</code>{" "}
        carries it across instances — the GraphQL side follows automatically.
      </p>
      <ul>
        <li>
          Ends when the key is revoked, when <code>signal</code>{" "}
          aborts, or when the client disconnects.
        </li>
        <li>
          Bounded: past the buffer cap (64) the oldest undelivered payload is dropped — a
          subscription is a live feed, not a log.
        </li>
      </ul>
      <Callout kind="warn">
        Authorization is yours. A channel's <code>authorize</code>{" "}
        gates Live-socket subscribers; a server-side subscription sees every publish to the key.
        Check the viewer in the resolver before returning <code>fromChannel(...)</code>.
      </Callout>

      <h2>CI</h2>
      <Code lang="sh">
        {`denext graphql sdl --out schema.graphql   # regenerate the committed SDL (sorted, stable)
denext graphql diff schema.graphql        # exit 1 when the schema changed`}
      </Code>
      <p>
        <code>denext build</code> writes the same <code>schema.graphql</code>{" "}
        into the output directory. Feed it to <code>graphql-codegen</code> or any client generator.
      </p>

      <h2>Security posture</h2>
      <ul>
        <li>
          Yoga's defaults apply: errors are masked in production, mutations over <code>GET</code>
          {" "}
          are refused, and a <code>POST</code> needs a JSON content type a plain{" "}
          <code>{"<form>"}</code> cannot send.
        </li>
        <li>
          The endpoint runs inside denext's pipeline, so <code>middleware.ts</code>{" "}
          and the request body cap apply to it too.
        </li>
        <li>
          GraphiQL is off in production; gate it yourself if you turn it on.
        </li>
      </ul>
      <p>
        See <code>examples/graphql</code> — a Pothos schema with a channel-backed subscription.
      </p>
    </DocsShell>
  );
}
