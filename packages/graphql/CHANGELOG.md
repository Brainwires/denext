# Changelog

## 0.7.0

### Security

- **`graphql-yoga` is required at `^5.24.6`** (was `^5.10.0`). Yoga 5.24.4 and later depend on
  `@graphql-tools/utils@^12.0.3`, which fixes two prototype-pollution advisories:
  [GHSA-7mx3-vvmw-hjmv](https://github.com/advisories/GHSA-7mx3-vvmw-hjmv) (`mergeDeep`, through
  12.0.0) and [GHSA-c4qx-w738-7hr3](https://github.com/advisories/GHSA-c4qx-w738-7hr3)
  (`mergeIncrementalResult`, 10.10.1 to 12.0.1). Yoga 5.22 to 5.24.3 pinned the vulnerable
  `@graphql-tools/utils@^11`. The old range already admitted the fixed releases, so an app that
  updates its lockfile was covered; the new floor keeps a stale lock from resolving an older Yoga.
  Yoga 6 is not adopted here: it removes `createGraphQLError`, which the plugin uses and
  re-exports alongside Yoga's options.

### Added

- **A dev schema reload says what it did.** Each reload logs one line naming the edited files
  (`[@denext/graphql] schema reloaded after an edit to app/graphql/schema.ts`). A reload that fails
  logs the error with the same files and shows it in the dev error overlay (through the plugin
  kit's `reportDevError`, denext 4.9); requests answer with that error until the next edit. On an
  older denext the overlay part is skipped.

### Fixed

- **`@denext/openapi` is required at `^0.7.0`**, the version the workspace builds against: the
  `^0.6.0` range did not match it, so a plain `deno test` in the repository rewrote `deno.lock`.

## 0.6.0

### Added

- **`denext graphql client --lang python|go|swift|kotlin`** (`--out`, `--package`): the schema's
  types — object and interface types with every field optional, input types required where
  non-null without a default, enums, the built-in scalars typed and the rest JSON — plus a client
  whose `execute(query, variables, operationName)` posts one operation and raises the response's
  `errors`. One file, standard library only, through `@denext/openapi`'s emitters (a new
  dependency, `jsr:@denext/openapi@^0.6.0`, loaded only when the verb runs). `modelFromSdl(sdl,
  path)` from `@denext/graphql/client`.

## 0.5.0 - 2026-10-16

### Added

- **`maxCost` budgets a whole batch.** With Yoga `batching` on, a plugin hook sums the estimated
  cost of every operation in the batch when the request is parsed (variables at their values;
  an operation that does not parse, or a persisted-document id, adds nothing there) and refuses
  a batch over the budget with `400` and `extensions.code: "BATCH_TOO_EXPENSIVE"` before any
  operation runs. Each operation is still checked on its own at execute time.
- **A schema object reloads in `denext dev`.** A `GraphQLSchema` or factory imported into
  `denext.config.ts` is traced to the project module that exports it — the config's static
  relative imports followed breadth-first, each module read from Deno's cache by its plain URL
  and its exports compared by identity — and that module is re-imported through the dev loader
  after an edit under `watch` (default: its directory). One that cannot be traced logs a dev
  notice and needs a restart, as before.

## 0.4.0 - 2026-10-15

Requires the denext release after 4.0.0 (`tapChannelAuthorized` in `@denext/denext/plugin-kit`).

### Breaking

- **`fromChannel(channel, key)` runs the channel's `authorize`.** It used to subscribe any caller
  to any key — a server-side tap that skipped the channel's policy — so a key built from a
  client-supplied argument (``fromChannel(inbox, `user:${args.user}`)``) let a viewer read
  another user's channel unless the resolver checked it. Now it applies the Live socket's gate:
  an unknown channel, a malformed key, or an `authorize(ctx, key)` that says no (or throws)
  refuses the subscription with a GraphQL error (`extensions.code: "FORBIDDEN"`, kept through
  error masking). `ctx` is `{ origin, url, cookie, peerId }` from the subscribing request, as on
  the Live socket. An active subscription is re-checked lazily after the channel's
  `authTtlSeconds` (default `live.limits.channelAuthTtlSeconds`) and ends when that check fails;
  a `channel.revoke(key)`, or one naming the subscription's peer, ends it at once.
- **`fromChannel` returns a promise** (`Promise<AsyncIterableIterator<T>>`). A `subscribe`
  resolver may return it as is (`subscribe: (_r, args, ctx) => fromChannel(...)`); code that
  called `.next()` on the result directly awaits it first.

### Added

- **GraphQL over WebSocket.** The `graphql-ws` protocol (subprotocol `graphql-transport-ws`) on
  the same path as GraphQL over SSE, implemented in the package (no new dependency) over Yoga's
  own pipeline, so the depth and cost limits, introspection blocking and error masking apply to
  every operation. The handshake needs a browser `Origin` on the app's own host, in
  `allowedOrigins`, or the app's `desktop.app.origin` (Live's production rule; `requireSameOrigin:
  false` lifts it). Identity is the upgrade request's cookies / `Authorization`, or a
  `connection_init` payload token (`{ authorization: "Bearer …" }` or `{ token }`) when the
  upgrade carried none; every operation of a socket is one peer for `authorize` and
  `revoke(key, { peerId })`. `websocket: { connectionInitTimeoutMs, maxSubscriptions }` (3000 ms;
  32 operations per socket); `websocket: false` turns it off. Messages over `maxBodyBytes` close
  the socket.
- **Connection caps for both subscription transports** (`maxConnections`, `maxConnectionsPerIp`),
  mirroring the Live socket's: every open WebSocket and every streamed (SSE / multipart) response
  holds a slot, refused with `429` before the upgrade or the response past a cap. The per-address
  cap keys on `clientIpForLimits({ bucket: true })` as Live does (a trusted proxy's hop or the
  `rateLimitHeader` address, an IPv6 client's /64; a loopback/private peer behind an untrusted
  proxy counts only against the total unless `rateLimitLocalAddresses`). Defaults: the app's
  `live.limits.maxConnections` / `maxConnectionsPerIp`, else Live's 10 000 / 64. A slot is
  released however the connection ends — a client close or disconnect, a protocol error, the
  `connection_init` timeout, a completed or failed stream, a schema reload ending it.
- **The schema reloads in `denext dev`.** `schema` takes the module path that exports it
  (`schema: "./app/graphql/schema.ts"`; its `schema` or default export, a schema or a factory). An
  edit to a file under that module's directory (or the `watch` globs) loads the schema again for
  the next request without a restart; subscriptions on the old schema complete, over SSE and
  WebSocket alike.

### Fixed

- **`denext graphql sdl` / `diff` load a module-path `schema` under the app's own config.** The
  verb now declares that it loads project modules, as `denext content` and `denext openapi` do,
  so the CLI re-runs under the project's `deno.json` first; it used to import the schema module
  with whatever import map the CLI started with, and an npm package the schema imports (Pothos,
  say) failed to resolve.

## 0.3.0 - 2026-10-13

- Requires `@denext/denext` ^4.0.0-rc.1 (the jobs rename and the rest of denext 4.0's breaking
  changes).

## 0.2.1

- **`denext export` writes no SDL.** The `schema.graphql` artifact is a server's: a static export
  serves no GraphQL endpoint, so the build step does not run there (and an introspection failure
  can no longer fail an export). `denext build` still writes `outFile`.

## 0.2.0

- **Query cost budget (`maxCost`).** An opt-in complexity guard against the _multiplicative_
  DoS a depth limit misses — `users(first: 1000) { posts(first: 1000) { … } }` is shallow but
  fans out to a million resolver calls. Cost is estimated over the AST (no schema access, no
  resolver run, no second `graphql` realm): each field costs `1` and a field carrying a
  pagination argument (`first`/`last`/`limit`) multiplies its subtree cost by that integer. Off
  by default (`maxDepth` stays the on-by-default guard); set `maxCost: 1000` to enable, and tune
  the field weight / multiplier args via `costOptions`. New exported type `CostOptions`. The
  check runs at **execute** time, so a page size passed as a variable (`first: $n`) is counted
  at its real value — a variable can't evade the budget. With Yoga `batching` on, the budget is
  per operation (an N-operation batch may cost up to N×).
- **Both the depth and cost walks now memoize per fragment.** A "fragment bomb" (many non-cyclic
  spreads of the same fragment) is analyzed in linear time instead of exponential — this hardens
  the default-on `maxDepth` guard, not only the new `maxCost`.

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
