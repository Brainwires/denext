---
title: Live views
slug: live-views
lead: defineLiveView keeps a Model–View–Update program on the server, one instance per Live connection. The page renders it as plain HTML, events go over the Live socket, update runs on the server, and the DOM changes come back as patches. Phoenix LiveView and Lustre server components, on denext's existing socket and its guards.
---

A [Model–View–Update](/docs/mvu) program normally runs in the browser. A **live view** runs the
same program on the server instead: the model lives in the server process for as long as the
viewer's Live connection does, `update` and its effects run there (next to your database), and
the browser only renders. Nothing of the program ships to the client: the page carries the
rendered HTML, and each event handler is an index the server maps back to the message it
rendered.

```tsx
// app/todos/todo-view.tsx — a server module (not "use client")
import { defineLiveView } from "denext/live";
import { fx, type Next } from "denext/mvu";
import { auth } from "denext/server";
import { db } from "../../lib/db.ts";

type Model = { items: { id: string; text: string }[]; draft: string };
type Msg =
  | { type: "typed"; text: string }
  | { type: "add" }
  | { type: "saved"; items: Model["items"] };

function update(msg: Msg, m: Model): Next<Model, Msg> {
  switch (msg.type) {
    case "typed":
      return [{ ...m, draft: msg.text }];
    case "add":
      return [{ ...m, draft: "" }, [
        fx.task(() => db.todos.add(m.draft), (items) => ({ type: "saved", items })),
      ]];
    case "saved":
      return [{ ...m, items: msg.items }];
  }
}

export const TodoView = defineLiveView({
  id: "todos",
  init: (props: { items: Model["items"] }) => [{ items: props.items, draft: "" }],
  update,
  view: (m, send) => (
    <form onSubmit={send({ type: "add" })}>
      <ul>{m.items.map((t) => <li>{t.text}</li>)}</ul>
      <input value={m.draft} onInput={send((e) => ({ type: "typed", text: e.value ?? "" }))} />
      <button type="submit">Add</button>
    </form>
  ),
  authorize: async () => (await auth()) !== null,
});
```

```tsx
// app/todos/page.tsx — a Server Component
import { TodoView } from "./todo-view.tsx";

export default async function Page() {
  return <TodoView items={await db.todos.list()} />;
}
```

`defineLiveView` comes from `denext/live`, the `update` / effect helpers from
[`denext/mvu`](/docs/mvu). A program written with `defineMvu` runs unchanged here or in the
browser with `MvuView`; only where it runs differs.

## How it works

1. **The page.** The component runs `authorize(props)` (when given) and `init(props)` and renders
   `view(model)` into the page's HTML inside the framework's `denext#LiveView` island, together
   with the props and an HMAC over them. With JavaScript disabled the view is plain HTML.
2. **Mount.** In the browser the island opens the Live socket (the one `<Live>`, `useLive` and
   channels share) and mounts the view with those props. The server checks the HMAC, runs
   `authorize` again in the viewer's session, runs `init` for this connection and sends the
   whole rendered tree; init's effects and the subscriptions start.
3. **Events.** `send(msg)` put only a handler index on the page. A click sends the index and
   the event's payload; the server finds the message it rendered for that index, runs `update`
   and the effects, re-renders the view (through `renderToFlight`, as the viewer, inside a Live
   render slot with the render deadline) and sends the Flight diff. The client applies it and
   the reconciler changes only the DOM that differs, so focus and caret survive.

A burst of events re-renders once; the client's events name the render they came from, and a
handler stays valid for the 16 renders after it.

## Events and payloads

`send(msg)` binds a constant message. `send((payload) => msg)` builds it from the event's
payload: `value` and `checked` of an input, select or textarea, `key` of a keyboard event, and
`form` (the text fields) of a submit, which is `preventDefault`ed. Return `null` to dispatch
nothing. The function runs on the server.

Every payload passes a built-in check first: an object with only those four fields, strings at
most 16 KiB, at most 64 form fields. Then `events`, if the view declares one, a
[Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType or your own) validates it:

```ts
export const Search = defineLiveView({
  id: "search",
  events: z.object({ value: z.string().max(200).optional() }),
  // …
});
```

A rejected payload is answered with an `invalid-input` error (with `fieldErrors` from the
schema) and no message is dispatched. Because the message itself never travels, a client can
fire only handlers the server rendered for it, in a render it still holds.

## Authorization and caps

`authorize(props, { connection })` runs in the viewer's session (`auth()`, `getSession()`,
`cookies()` work) when the page renders (`connection: null`; `false` renders nothing), when the
browser mounts or resumes the view, and again before an event once
`live.limits.channelAuthTtlSeconds` (300) has passed — `false` ends the view with `denied`.
Without `authorize`, anyone holding the page's signed props can mount the view, the same as
loading the page that rendered it.

Live views ride the Live hub, so its gates apply first: the same-origin handshake,
`live.authorize`, `maxConnections` / `maxConnectionsPerIp`, the 100-frames-a-second rate and
`maxMessageBytes` per frame. On top of them:

| `live.limits` key           | Default | What it bounds                                                                                        |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `maxViewsPerConnection`     | 16      | Views one connection holds (`limit` past it).                                                         |
| `maxViewBytesPerConnection` | 1 MiB   | Model (as JSON) + last rendered tree across a connection's views; past it the view ends with `limit`. |
| `viewResumeSeconds`         | 30      | How long a dropped connection's views wait to be resumed.                                             |
| `maxParkedViews`            | 1000    | Views waiting to be resumed across the server; the oldest go first.                                   |
| `maxSubscriptionInputBytes` | 16 KiB  | A view's props.                                                                                       |

Per view, at most 32 events wait to be processed (more are refused with `limit`), at most 32
effects are pending and 32 subscriptions open, and an interval fires at most every 100 ms.
Outbound, a back-pressured socket gets nothing queued per update: once it drains, the view sends
its whole current tree once.

## Effects and subscriptions on the server

Effects run as the viewer: `fx.task(() => db.todos.add(text), ok)` calls your data layer inside
the connection's request context, so `auth()` and `cookies()` answer for that viewer. A
relative `fx.fetch("/api/x")` resolves against the page's origin but carries no cookie; prefer
`fx.task` with the function the route would have called. `subs.channel(channel, key, toMsg)`
subscribes the view to a [`createChannel`](/docs/live#server-push--channels) key after the
channel's own `authorize` for the viewer, so a publish from any request — or any instance, with a
`ChannelTransport` — becomes a message.

## Keyed lists

Give list rows a `key`, as in React: `items.map((item) => <li key={item.id}>…</li>)`. The key
travels with the element in Flight, so when the model reorders the list the patch moves the
rows (one `m` op naming each row's old index) and the browser moves their DOM nodes: a row keeps
its element and whatever the viewer typed into an input inside it. The same holds
for a `<Live>` boundary's pushed subtree and for soft navigation. A keyed component's key carries
onto the single element it renders (`<Row key={id} />` rendering an `<li>`); a component that
renders a fragment or a list has no element to carry it, so give its rows their own keys. A
list without keys is patched by position.

## Reconnects

When the socket drops, the server parks the connection's views for `viewResumeSeconds`. The
browser reconnects with backoff and re-mounts each view with the instance id it was given; if
the server still holds it, for the same view and the same signed props, the model carries on
(effects and subscriptions kept running meanwhile) and the browser gets its whole tree. A parked
view's model is also written to the view store (below), so a reconnect that reaches another
instance resumes it there, from the model as it last stood. Past the window, or when no store
holds it, the mount runs `init` again from the props — the documented re-init. Events fired
while the socket was down wait (up to 16) and are sent once the view is mounted again.

If the server cannot mount the view at all — its module is not loaded in this process yet, or
the HMAC does not verify (another instance's key, a restart with a per-process key) — it answers
`gone` and the browser re-renders the route once to get fresh props.

## More than one instance

A live view's state lives in the process that holds the viewer's socket, so:

- **Mounting works anywhere** when every instance signs with the same key: set
  `DENEXT_LIVE_VIEW_SECRET` (any long random string) on all of them. Without it each process
  uses a random key, and a page rendered by one instance and mounted on another costs one
  route re-render (`gone`) before it works.
- **Resuming anywhere needs a shared view store.** Install one at startup —
  `setLiveViewStore(redisLiveViewStore())` or `setLiveViewStore(postgresLiveViewStore({ url }))`
  from `denext/server` — and a reconnect that lands on another instance takes the parked
  model from it (once) and carries on, with effects and subscriptions started again from that
  model; `init` and its effects do not run again. The default store is in memory, per process:
  without a shared one, a reconnect that lands elsewhere re-runs `init` (sticky sessions keep a
  viewer on one node). See [Multi-instance › Live views](/docs/multi-instance#live-views-liveviewstore).
- **Models must be serializable to travel.** The stored model goes through the same codec as
  live props: plain data plus `Date`, `Map`, `Set`, `BigInt` and `URL`. A model holding a
  function, a class instance or a socket is parked in its own process only (a warning says so).
- **The store sees no model.** Each snapshot is sealed (AES-256-GCM) under a key derived from
  `DENEXT_LIVE_VIEW_SECRET` and bound to its instance id; every instance must share that secret.
- **Cross-viewer updates use the channel transport.** One viewer's update reaching another
  viewer's view goes through a channel: publish to it (from `update`'s task, an action, a
  webhook) and subscribe the views with `subs.channel`. Install a cross-instance
  `ChannelTransport` and every instance's views receive it — see
  [Multi-instance › Live](/docs/multi-instance#live-channeltransport).

## Debugging

Under `denext dev`, the DevTools panel's [Live views tab](/docs/devtools#live-views) lists
every view the dev server holds — attached or parked — with its model and the recent messages
its `update` ran, and the [Live tab](/docs/devtools#live) shows each socket's subscriptions and
the channel pushes. Strings in models and messages are shown as `string(n)`.

## Limits

- `view` must be a pure function of the model: the server and the page number handlers by the
  order `send` is called, and a click sent before the mount answered uses the page's numbering.
- `send` handlers bind on HTML elements; a `"use client"` component inside a view is an island
  with its own state and its own (browser) handlers.
- With JavaScript disabled only the first render works: events need the socket.
