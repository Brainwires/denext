import { Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "GraphQL",
  description:
    "A GraphQL endpoint for a denext app via the @denext/graphql plugin: GraphQL Yoga at /graphql, subscriptions that ride denext channels behind their authorize, over SSE or WebSocket (graphql-ws), a schema that reloads in dev, the SDL written at build, and a denext graphql CI verb.",
};

export default function GraphQL() {
  return (
    <DocsShell
      active="graphql"
      title="GraphQL"
      lead="@denext/graphql mounts a GraphQL Yoga server at /graphql through the plugin contract, bridges subscriptions onto denext channels — the app's push primitive, so there is no second event bus — and serves them over SSE and over WebSocket (graphql-ws) on the same path. The schema reloads on an edit in denext dev, the SDL is written at build, and a denext graphql verb serves CI. Any GraphQLSchema works; Pothos (code-first, typed, no decorators) is the recommended builder."
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
    "@denext/graphql": "jsr:@denext/graphql@^0.6.0",
    "graphql": "npm:graphql@^16.9.0",
    "graphql-yoga": "npm:graphql-yoga@^5.10.0",
    "@pothos/core": "npm:@pothos/core@^4"
  }
}`}
      </Code>
      <Code lang="ts">
        {`// denext.config.ts
import { graphql } from "@denext/graphql";

export default {
  plugins: [
    graphql({
      // The module that exports \`schema\` — named by path, it reloads on an edit in dev.
      schema: "./app/graphql/schema.ts",
      // context hands resolvers the request's abort signal (a subscription ends on disconnect).
      context: ({ signal }) => ({ signal }),
    }),
  ],
};`}
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
    viewer: t.string({ nullable: true, resolve: async () => (await auth())?.user.id ?? null }),
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
        <code>fromChannel(channel, key)</code> resolves to the payloads published to one key of a
        {" "}
        <a href="/docs/live">
          <code>createChannel</code>
        </a>{" "}
        as an <code>AsyncIterable</code> — what a <code>subscribe</code> resolver returns. The same
        {" "}
        <code>publish</code> reaches every <code>useChannel</code>{" "}
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
      <h3>Authorization is the channel's</h3>
      <p>
        <code>fromChannel</code> runs the channel's <code>authorize(ctx, key)</code>{" "}
        for the subscribing request — the context (<code>
          {"{ origin, url, cookie, peerId }"}
        </code>) and key the Live socket passes, inside the request so <code>auth()</code>{" "}
        answers for the viewer — and refuses the subscription with a GraphQL error (<code>
          extensions.code: "FORBIDDEN"
        </code>) when it says no. A key built from a client argument is therefore checked:
      </p>
      <Code lang="ts">
        {`// channels.ts ("use server")
export const inbox = createChannel<{ text: string }>({
  authorize: async (_ctx, key) => key === \`user:\${(await auth())?.user.id}\`,
});
// schema.ts — bob can't subscribe to alice's inbox by passing user: "alice"
subscribe: (_root, { user }, ctx) => fromChannel(inbox, \`user:\${user}\`, { signal: ctx.signal }),`}
      </Code>
      <p>
        An active subscription is re-checked lazily: the first payload after the channel's{" "}
        <code>authTtlSeconds</code> (default <code>live.limits.channelAuthTtlSeconds</code>){" "}
        waits for <code>authorize</code> again, and the subscription ends when it says no.{" "}
        <code>channel.revoke(key)</code> ends every subscription to the key at once;{" "}
        <code>channel.revoke(key, {"{ peerId }"})</code>{" "}
        ends one connection's (each SSE request is a peer; every operation of one WebSocket is the
        same peer).
      </p>

      <h2>GraphQL over WebSocket</h2>
      <p>
        The endpoint also speaks the <code>graphql-ws</code> protocol (subprotocol{" "}
        <code>graphql-transport-ws</code>) on the same path, so a <code>graphql-ws</code>{" "}
        client (or urql / Apollo through it) connects to <code>wss://…/graphql</code>{" "}
        unchanged. It runs over Yoga's own pipeline, so the depth and cost limits, introspection
        blocking and error masking apply to every operation — and it adds no dependency.
      </p>
      <ul>
        <li>
          The handshake is same-origin, as on the Live socket in production: a browser{" "}
          <code>Origin</code> on the app's own host (or in <code>allowedOrigins</code>, or the app's
          {" "}
          <code>desktop.app.origin</code>); anything else is a 403.
        </li>
        <li>
          Identity is the upgrade request's cookies and <code>Authorization</code>, or a{" "}
          <code>connection_init</code> payload token (<code>
            {'{ authorization: "Bearer …" }'}
          </code>{" "}
          or <code>{"{ token }"}</code>) when the upgrade carried none.
        </li>
        <li>
          <code>connection_init</code> must arrive within{" "}
          <code>websocket.connectionInitTimeoutMs</code> (3000); a socket runs at most{" "}
          <code>websocket.maxSubscriptions</code> operations at once (32); a message over{" "}
          <code>maxBodyBytes</code> closes it. <code>websocket: false</code>{" "}
          turns the transport off.
        </li>
      </ul>

      <h2>Connection caps</h2>
      <p>
        Every open WebSocket and every streamed (SSE / multipart) response holds a slot, as a Live
        socket does: <code>maxConnections</code> across all clients and{" "}
        <code>maxConnectionsPerIp</code> per client address, refused with <code>429</code>{" "}
        before the upgrade or the response. The address is{" "}
        <code>clientIpForLimits()</code>'s, so a trusted proxy's hop or your{" "}
        <code>rateLimitHeader</code>{" "}
        counts, and a loopback/private peer behind an untrusted proxy only counts against the total.
        Defaults: the app's{" "}
        <code>live.limits</code>, else Live's 10 000 / 64. A slot is freed however the connection
        ends — a close, a disconnect, a protocol error, the <code>connection_init</code>{" "}
        timeout, a completed stream or a schema reload.
      </p>

      <h2>Schema reload in dev</h2>
      <p>
        With <code>schema</code> given as a module path, an edit to a script or{" "}
        <code>.graphql</code>{" "}
        file in that module's directory loads the schema again for the next request — no restart.
        Subscriptions on the old schema complete (SSE and WebSocket alike), so clients resubscribe
        against the new one. <code>watch</code>{" "}
        takes your own globs. A schema object (or factory) imported into{" "}
        <code>denext.config.ts</code>{" "}
        reloads the same way: the plugin follows the config's relative imports to the module that
        exports it and re-imports that module after an edit. One it cannot trace (built in the
        config itself, or imported through an alias) needs a restart, and a dev notice says so.
      </p>

      <h2>CI</h2>
      <Code lang="sh">
        {`denext graphql sdl --out schema.graphql   # regenerate the committed SDL (sorted, stable)
denext graphql diff schema.graphql        # exit 1 when the schema changed
denext graphql client --lang go --out client.go   # a typed client: python | go | swift | kotlin`}
      </Code>
      <p>
        <code>denext graphql client</code>{" "}
        writes the schema&apos;s types (object and interface types with every field optional — what
        a response holds depends on the selection —, input types with their required fields, enums)
        and a small client whose <code>execute(query, variables)</code>{" "}
        posts one operation and raises the response&apos;s <code>errors</code>{" "}
        — one file, the language&apos;s standard library only, through the same emitters as{" "}
        <code>denext openapi client</code>.
      </p>
      <p>
        <code>denext build</code> writes the same <code>schema.graphql</code>{" "}
        into the output directory. Feed it to <code>graphql-codegen</code> or any client generator.
      </p>

      <h2>Security posture</h2>
      <ul>
        <li>
          Yoga's defaults apply on top: errors are masked in production and mutations over{" "}
          <code>GET</code> are refused. Introspection is off in production unless{" "}
          <code>introspection: true</code>.
        </li>
        <li>
          Non-<code>GET</code>{" "}
          requests need the same same-origin proof denext applies to Server Actions (<code>
            requireSameOrigin
          </code>, default on), CORS is off unless you configure{" "}
          <code>yoga.cors</code>, and the body is capped (<code>maxBodyBytes</code>, default 1 MiB).
          The endpoint runs inside denext's pipeline, so <code>middleware.ts</code>{" "}
          applies too — but <code>defineApi</code>'s <code>rateLimit</code>{" "}
          is a route-handler middleware; rate-limit GraphQL in <code>middleware.ts</code>{" "}
          or a Yoga plugin.
        </li>
        <li>
          Query shape is bounded: <code>maxDepth</code> (default 12; <code>false</code>{" "}
          turns it off) refuses a deeply nested query, and <code>maxCost</code>{" "}
          (off by default; a budget of about 1000 suits most apps) refuses one whose estimated cost
          — each field 1, multiplied by a <code>first</code> / <code>last</code> /{" "}
          <code>limit</code>{" "}
          argument, counted at a variable's actual value — is over budget (<code>costOptions</code>
          {" "}
          tunes the weights). With Yoga <code>batching</code>{" "}
          on, the budget covers the whole batch: the operations' costs are summed when the request
          is parsed, and a batch over it is refused with <code>400</code> before any operation runs.
        </li>
        <li>
          GraphiQL is off in production; gate it yourself if you turn it on.
        </li>
        <li>
          Subscriptions pass the channel's <code>authorize</code>{" "}
          and the WebSocket handshake requires the app's own <code>Origin</code>.
        </li>
      </ul>
      <p>
        See <code>examples/graphql</code> — a Pothos schema with a channel-backed subscription.
      </p>
    </DocsShell>
  );
}
