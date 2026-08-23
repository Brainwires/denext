# Live data & presence (secured)

A runnable demo of the two **gated** Live hooks over a single WebSocket:

- **`useLive`** — a server value (`getCount`) streamed to every client and
  re-pushed whenever the `count` cache tag is invalidated (the `bump` action
  does that).
- **`usePresence`** — who's on the page (the `lobby` room).

## The security model this example demonstrates

Presence rooms and `useLive` subscriptions are **default-deny — identically in
dev and production**. Without a policy the hub refuses joins/subscriptions (and
raises a clear, actionable error the first time you run it, so a missing policy
is caught locally, never in prod), so one client cannot read another user's
presence or run registered server actions over the socket. This example opts in
explicitly, in two complementary ways (see
[`denext.config.ts`](./denext.config.ts) and
[`app/live-actions.ts`](./app/live-actions.ts)):

- `experimental.live.canJoinRoom` authorizes the `lobby` presence room. The hook
  runs in the visitor's own request context, so a real app can call
  `getSession()` inside it and scope rooms to the signed-in user.
- `liveReadable(getCount)` marks the read action as streamable. An unmarked
  action is refused over the live channel even though it is a normal,
  HTTP-dispatchable action. (Alternatively, authorize dynamically with
  `experimental.live.canSubscribe`.)

For genuinely public collaboration (no per-user rules), set
`experimental.live.allowAnonymous: true` — one explicit line that opts presence
rooms open (there is no silent dev-only allowance to trip over later). It does
**not** open arbitrary data: a `useLive` subscription still needs its action
marked `liveReadable` (or a `canSubscribe` hook), so anonymous presence never
exposes an unmarked or mutating action over the socket.

## Run it

```sh
deno task dev     # or: deno task build && deno task start
```

Open the page in **two browser tabs**: clicking **+1** updates the count in
both, and each tab appears in the other's presence list — all pushed from the
server, no polling.
