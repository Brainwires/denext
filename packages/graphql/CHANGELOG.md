# Changelog

## Unreleased

- **Query cost budget (`maxCost`).** An opt-in complexity guard against the _multiplicative_
  DoS a depth limit misses — `users(first: 1000) { posts(first: 1000) { … } }` is shallow but
  fans out to a million resolver calls. Cost is estimated over the AST (no schema access, no
  resolver run, no second `graphql` realm): each field costs `1` and a field carrying a
  pagination argument (`first`/`last`/`limit`) multiplies its subtree cost by that integer. Off
  by default (`maxDepth` stays the on-by-default guard); set `maxCost: 1000` to enable, and tune
  the field weight / multiplier args via `costOptions`. A size passed as a variable uses the
  default multiplier, since variable values aren't known at validation time. New exported type
  `CostOptions`.

## 0.1.0

Initial release. A GraphQL endpoint for a denext app as a plugin. Requires the denext that
ships `tapChannel` in `@denext/denext/plugin-kit` (the release after 2.1.0-rc.1; the
`deno.json` pin is bumped with each denext release).

- `graphql({ schema })` plugin — mounts a GraphQL Yoga server at `/graphql` through the
  plugin request-handler seam (core routes always win), GraphiQL on a browser `GET` in dev,
  a `context` factory over the request, and Yoga passthrough options (`plugins`,
  `maskedErrors`, `cors`, `batching`, …). Resolvers run inside denext's request context.
- `fromChannel(channel, key)` — GraphQL subscriptions over denext channels: the payloads
  published to one key of a `createChannel`, as the `AsyncIterable` a `subscribe` resolver
  returns (bounded buffer, ends on revoke / abort / client disconnect). Delivered by Yoga as
  GraphQL over SSE — no second pub/sub, no separate WebSocket server.
- Build step writes `schema.graphql` (sorted SDL) into the output directory.
- `denext graphql sdl [--out <file>]` / `denext graphql diff <file>` for CI.
- `createSchema` re-exported from Yoga for SDL-first schemas; Pothos recommended for
  code-first.
