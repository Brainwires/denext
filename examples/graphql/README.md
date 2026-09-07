# examples/graphql

`@denext/graphql` in one app: a Pothos (code-first, no decorators) schema served by GraphQL
Yoga at `/graphql`, with a **subscription that rides a denext channel** — a `post` mutation
publishes to `createChannel`, and both the GraphQL `subscription { messages }` (SSE) and the
page's `useChannel` (Live socket) receive it.

```sh
deno task dev          # http://localhost:8000 — GraphiQL at /graphql
```

```sh
# subscribe (GraphQL over SSE) in one terminal…
curl -N localhost:8000/graphql -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"query":"subscription { messages(room: \"lobby\") { text at } }"}'
# …and post from another
curl -s localhost:8000/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { post(room: \"lobby\", text: \"hello\") { text } }"}'
```

`denext graphql sdl` prints the schema; `denext build` writes `.denext/schema.graphql`.
Yoga, `graphql` and Pothos are npm packages the example opts into (`deno.json` imports) —
denext's own runtime stays zero-npm.
