# @denext/graphql

A **GraphQL endpoint** for a [denext](https://denext.dev) app, as a plugin. It mounts a
[GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) server at `/graphql`, bridges
**subscriptions onto denext channels** (the app's push primitive — no second event bus,
no separate WebSocket server), writes the schema SDL at build, and adds a
`denext graphql` verb for CI.

```ts
// denext.config.ts
import { graphql } from "@denext/graphql";
import { schema } from "./app/graphql/schema.ts";

export default { plugins: [graphql({ schema })] };
```

Any `GraphQLSchema` works. [Pothos](https://pothos-graphql.dev) (code-first, fully typed,
**no decorators**) is the recommended builder; `createSchema` (re-exported from Yoga)
covers SDL + resolvers.

## Install

```jsonc
// deno.json
{
  "imports": {
    "@denext/graphql": "jsr:@denext/graphql@^0.1.0",
    "graphql": "npm:graphql@^16.9.0",
    "graphql-yoga": "npm:graphql-yoga@^5.10.0",
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

export const schema = builder.toSchema();
```

Resolvers run inside denext's request context: `cookies()`, `headers()`, `auth()`,
`getSession()` and the typed API client work in them exactly as in a route handler.

## Subscriptions over channels

`fromChannel(channel, key, { signal, buffer })` returns the payloads published to one key
of a `createChannel` as an `AsyncIterable` — what a `subscribe` resolver returns. Yoga
streams it to the client as GraphQL over SSE (`accept: text/event-stream`), which every
GraphQL client supports. It ends when the key is revoked, when `signal` aborts, or when
the client disconnects; past the buffer cap (64) the oldest undelivered payload is dropped
— a subscription is a live feed, not a log.

The same `publish` also reaches every `useChannel` subscriber on the Live socket, and a
`ChannelTransport` (`broadcastChannelTransport`, Redis/NATS) carries it across instances
— the GraphQL side follows automatically.

**Authorization is yours.** A channel's `authorize` gates Live-socket subscribers; a
server-side subscription sees every publish to the key. Check the viewer in the resolver
(`auth()`, the context) before returning `fromChannel(...)`.

## Options

| Option     | Default          | What                                                                  |
| ---------- | ---------------- | --------------------------------------------------------------------- |
| `schema`   | required         | A `GraphQLSchema`, or a factory resolved once on first use            |
| `path`     | `/graphql`       | Mount point (prefixed with `basePath`)                                |
| `graphiql` | dev only         | Serve GraphiQL on a browser `GET`                                     |
| `context`  | `{}`             | `({ request, signal }) => object` — your resolvers' context           |
| `yoga`     | —                | Passthrough: `plugins`, `maskedErrors`, `cors`, `batching`, `logging` |
| `outFile`  | `schema.graphql` | The SDL `denext build` writes into the output dir; `false` skips it   |

## CI

```sh
denext graphql sdl --out schema.graphql   # regenerate the committed SDL (sorted, stable)
denext graphql diff schema.graphql        # exit 1 when the schema changed
```

Feed the SDL to `graphql-codegen` or any client generator; `denext build` writes the same
file into the output directory.

## Security notes

- Yoga's defaults apply: errors are masked in production (`maskedErrors`), mutations over
  `GET` are refused, and a `POST` needs a JSON content type a plain `<form>` cannot send.
- Gate GraphiQL yourself if you enable it in production (`graphiql: true`); it is off there
  by default.
- The endpoint runs inside denext's pipeline, so `middleware.ts`, rate limiting and the
  request body cap that apply to the rest of the app apply here too.

## License

MIT
