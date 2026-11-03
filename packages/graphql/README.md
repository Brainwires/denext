# @denext/graphql

A **GraphQL endpoint** for a [denext](https://denext.dev) app, as a plugin. It mounts a
[GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) server at `/graphql`, bridges
**subscriptions onto denext channels** (the app's push primitive — no second event bus),
serves them over SSE and over WebSocket (`graphql-ws`), reloads the schema on an edit in
`denext dev`, writes the schema SDL at build, and adds a `denext graphql` verb for CI.

```ts
// denext.config.ts
import { graphql } from "@denext/graphql";

export default {
  plugins: [
    graphql({
      schema: "./app/graphql/schema.ts", // its `schema` export; reloads on an edit in dev
      context: ({ signal }) => ({ signal }),
    }),
  ],
};
```

(`context` hands your resolvers the request's abort signal, which a subscription uses to end
on disconnect.) `schema` also takes a `GraphQLSchema` object or a factory for one — every form
reloads in dev. Any `GraphQLSchema` works. [Pothos](https://pothos-graphql.dev) (code-first, fully typed,
**no decorators**) is the recommended builder; `createSchema` (re-exported from Yoga)
covers SDL + resolvers.

## Install

```jsonc
// deno.json
{
  "imports": {
    "@denext/graphql": "jsr:@denext/graphql@^0.7.0",
    "graphql": "npm:graphql@^16.9.0",
    "graphql-yoga": "npm:graphql-yoga@^5.24.6",
    "@pothos/core": "npm:@pothos/core@^4" // if you use Pothos
  }
}
```

GraphQL Yoga and `graphql` are npm-only, so this package depends on them as peers —
the same opt-in-npm principle as `@denext/effect`. denext's own runtime stays zero-npm; the
plugin's code runs on the server only.

## A schema (Pothos)

```ts
// app/graphql/schema.ts
import SchemaBuilder from "@pothos/core";
import { fromChannel } from "@denext/graphql";
import { auth } from "@denext/denext/server";
import { messages } from "./channels.ts"; // "use server" module: createChannel<{ text: string }>({ authorize })

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

export const schema = builder.toSchema();
```

Resolvers run inside denext's request context: `cookies()`, `headers()`, `auth()`,
`getSession()` and the typed API client work in them exactly as in a route handler.

## Subscriptions over channels

`fromChannel(channel, key, { signal, buffer })` resolves to the payloads published to one key
of a `createChannel` as an `AsyncIterable` — what a `subscribe` resolver returns. It ends when
the key is revoked, when `signal` aborts, or when the client disconnects; past the buffer cap
(64) the oldest undelivered payload is dropped — a subscription is a live feed, not a log.

A publisher burst within 16 ms delivers only the last value per key (the hub coalesces
publishes, independent of back-pressure) — a channel carries state, not a log; keep a
list in a Server Action when you need the history. The same `publish` also reaches every
`useChannel` subscriber on the Live socket, and a `ChannelTransport`
(`broadcastChannelTransport`, Redis/NATS) carries it across instances — the GraphQL side
follows automatically.

**Authorization is the channel's.** `fromChannel` runs the channel's `authorize(ctx, key)` for
the subscribing request — the same context (`{ origin, url, cookie, peerId }`) and key the Live
socket passes, inside the request so `auth()` answers for the viewer — and refuses the
subscription with a GraphQL error (`extensions.code: "FORBIDDEN"`) when it says no. So a key
built from an argument is safe to subscribe to:

```ts
// channels.ts ("use server")
export const inbox = createChannel<{ text: string }>({
  authorize: async (_ctx, key) => key === `user:${(await auth())?.user.id}`,
});
// schema.ts
subscribe: (_root, { user }, ctx) => fromChannel(inbox, `user:${user}`, { signal: ctx.signal }),
```

An active subscription is re-checked lazily: the first payload after the channel's
`authTtlSeconds` (default `live.limits.channelAuthTtlSeconds`, 300) waits for `authorize` again,
and the subscription ends when it says no. `channel.revoke(key)` ends every subscription to the
key at once; `channel.revoke(key, { peerId })` ends one connection's (`ctx.peerId` — each SSE
request is a peer, and every operation of one WebSocket is the same peer).

## GraphQL over WebSocket

The endpoint also speaks the [`graphql-ws`](https://the-guild.dev/graphql/ws) protocol
(subprotocol `graphql-transport-ws`) on the same path, so `createClient({ url:
"wss://app.example.com/graphql" })` from `graphql-ws` (or urql / Apollo through it) works
unchanged. It is implemented in the package over Yoga's own pipeline — no extra dependency, and
the depth and cost limits, introspection blocking and error masking apply to every operation.

- **The handshake is same-origin.** As on the Live socket in production, the upgrade needs a
  browser `Origin` on the app's own host (or in `allowedOrigins`, or the app's
  `desktop.app.origin`); anything else is a 403 before the upgrade. A non-browser client sets
  `Origin` itself. `requireSameOrigin: false` lifts the check, for a public, cookie-free API only.
- **Identity** is the upgrade request's cookies and `Authorization`. A browser can't set headers
  on a WebSocket, so a `connection_init` payload token (`connectionParams: { authorization:
  "Bearer …" }` or `{ token }`) becomes the socket's `Authorization` when the upgrade carried
  none. Resolvers and `authorize` run in a copy of that request's context.
- **Limits:** a socket must send `connection_init` within `websocket.connectionInitTimeoutMs`
  (3000) or it is closed (4408); it may run `websocket.maxSubscriptions` operations at once (32;
  past it a `subscribe` gets an `error` frame); a message over `maxBodyBytes` closes it. A slow
  socket back-pressures its subscriptions, which drop their oldest payloads past the buffer cap.
- `websocket: false` turns the transport off (SSE stays).

## Connection caps

Every open WebSocket and every streamed (SSE / multipart) response holds a connection slot, as a
Live socket does: `maxConnections` across all clients and `maxConnectionsPerIp` per client
address. Past either, the request is refused with `429` before the upgrade or the response (a
plain JSON query takes no slot). The per-address cap keys on `clientIpForLimits({ bucket: true
})`, exactly as Live's does: a trusted proxy's last hop or your `rateLimitHeader` address, an IPv6
client's /64, and no per-address cap for a loopback/private peer behind an untrusted proxy (every
visitor would share the proxy's address — set `trustForwardedHeaders`, `rateLimitHeader` or
`rateLimitLocalAddresses`). The defaults are the app's `live.limits.maxConnections` /
`maxConnectionsPerIp`, else Live's own 10 000 / 64 — the budget denext already applies to a
long-lived push connection: a page rarely holds more than a couple, and 64 still leaves room for
a NAT or an office behind one address. A slot is freed however the connection ends: a client
close or disconnect, a protocol error, the `connection_init` timeout, a stream that completes or
fails, a dev schema reload ending it.

## Schema reload in `denext dev`

With `schema` given as a module path, an edit to a script or `.graphql` file in that module's
directory (or below) loads the schema again for the next request — no restart. Subscriptions
on the old schema complete (over SSE and WebSocket), so a client resubscribes against the new
one. `watch: ["app/graphql/**/*.ts", "lib/resolvers/**/*.ts"]` names the files yourself. A schema
object or factory imported into `denext.config.ts` reloads too: the plugin follows the config's
relative imports to the module that exports it and re-imports that module after an edit. One it
cannot trace (built in the config itself, or imported through an alias) needs a restart, and a dev
notice says so.

Each reload logs one line naming the edited files (`[@denext/graphql] schema reloaded after an edit
to app/graphql/schema.ts`). A reload that fails (a syntax error, a schema that no longer builds)
logs the error with the same files and shows it in the dev error overlay; requests answer with that
error until the next edit.

## Options

| Option                | Default                | What                                                                               |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `schema`              | required               | A module path, a `GraphQLSchema`, or a factory resolved once (all reload in dev)   |
| `path`                | `/graphql`             | Mount point (prefixed with `basePath`)                                             |
| `graphiql`            | dev only               | Serve GraphiQL on a browser `GET`                                                  |
| `context`             | `{}`                   | `({ request, signal }) => object` — your resolvers' context                        |
| `introspection`       | dev only               | Answer introspection queries                                                       |
| `maxBodyBytes`        | 1 MiB                  | Request body cap; over it `413` (a WebSocket message over it closes the socket)    |
| `requireSameOrigin`   | `true`                 | Same-origin proof on non-`GET` requests and the WebSocket handshake                |
| `allowedOrigins`      | —                      | Extra origins allowed past `requireSameOrigin`                                     |
| `maxDepth`            | `12`                   | Reject a query nested deeper than this; `false` disables it                        |
| `maxCost`             | `false` (off)          | Reject a query (or a whole batch) over this estimated cost; opt-in                 |
| `costOptions`         | —                      | Tune `maxCost`: `fieldCost`, `listMultiplierArgs`, `defaultMultiplier`             |
| `yoga`                | —                      | Passthrough: `plugins`, `maskedErrors`, `cors`, `batching`, `logging`              |
| `outFile`             | `schema.graphql`       | The SDL `denext build` writes into the output dir; `false` skips it                |
| `websocket`           | `{}` (on)              | GraphQL over WebSocket: `connectionInitTimeoutMs`, `maxSubscriptions`; `false` off |
| `watch`               | schema's dir           | Dev: globs whose edit reloads the schema                                           |
| `maxConnections`      | `live.limits` / 10 000 | Open WebSockets + streamed responses, all clients; past it `429`                   |
| `maxConnectionsPerIp` | `live.limits` / 64     | The same, per client address (`clientIpForLimits`)                                 |

## CI

```sh
denext graphql sdl --out schema.graphql   # regenerate the committed SDL (sorted, stable)
denext graphql diff schema.graphql        # exit 1 when the schema changed
denext graphql client --lang go --out client.go   # a typed client: python | go | swift | kotlin
```

`denext graphql client` writes the schema's types (object and interface types with every field
optional, input types with their required fields, enums) and a client whose
`execute(query, variables, operationName)` posts one operation and raises the response's `errors`
— one file, the language's standard library only, through `@denext/openapi`'s emitters.

Feed the SDL to `graphql-codegen` or any client generator; `denext build` writes the same
file into the output directory.

## Security notes

- **Same-origin by default.** Every non-`GET` request must carry the same-origin proof denext
  applies to Server Actions and the typed-API batch (`verifyOrigin`: an `Origin`/`Referer`
  matching the host, or one in `allowedOrigins`); a cross-site `<form>` or fetch gets a 403
  before Yoga parses it. `requireSameOrigin: false` turns this off — only for a public,
  cookie-free API, because resolvers run in the viewer's session.
- **The WebSocket handshake needs the app's own `Origin`** (or an allowed one) — the Live
  socket's production rule, since a WebSocket is not covered by CORS.
- **Subscriptions are authorized by the channel.** `fromChannel` runs the channel's
  `authorize` for the subscribing viewer, re-checks it lazily, and ends on `revoke`.
- **CORS is off** unless you set `yoga.cors` (Yoga's own default would reflect any `Origin`
  with credentials).
- **Bodies are capped** at `maxBodyBytes` (default 1 MiB, like a route handler) → 413.
- **Introspection is off in production** (`introspection: true` to allow); GraphiQL is dev-only
  unless `graphiql: true` — gate it yourself then.
- Yoga's defaults apply on top: errors are masked in production, mutations over `GET` are
  refused.
- The endpoint runs inside denext's pipeline, so `middleware.ts` applies to it. What does
  **not**: `defineApi`'s `rateLimit` middleware and the route-handler body cap are route
  features — rate-limit GraphQL in `middleware.ts` or with a Yoga plugin.
- **Query depth and cost are built in.** `maxDepth` (default 12) is on out of the box; `maxCost`
  is an opt-in cost budget for the multiplicative fan-out a depth limit misses. Both are
  estimated in linear time (fragment costs memoized) and `maxCost` reads the request's real
  variable values, so `first: $n` can't smuggle a large page past it. With Yoga `batching` on,
  `maxCost` budgets the whole batch (summed at parse time; over it, `400` before any operation
  runs). Enable `maxCost` for a public API; a schema-level max page size remains good practice.

## Package surface

- `@denext/graphql` — `graphql()`, `fromChannel`, `createSchema` (from Yoga), `schemaSdl`,
  `diffSdl`, `createGraphqlCommand`; types `GraphqlOptions`, `WebSocketOptions`, `CostOptions`.
- `@denext/graphql/subscriptions` — `fromChannel` alone (for a schema module that should not
  import the plugin).
- `@denext/graphql/command` — the CLI verb builder.

Requires the denext release after 4.0.0 (`tapChannelAuthorized` in `@denext/denext/plugin-kit`;
pinned in this package's `deno.json`).

## License

MIT
