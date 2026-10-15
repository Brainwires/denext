---
title: Model–View–Update
slug: mvu
lead: denext/mvu runs an Elm-style program in a component — init, update(msg, model) returning the next model and the effects to run, view(model, send), and subscriptions. Effects and subscriptions are plain data, so update is a pure function you test with assertEquals. The same program can run on the server as a live view.
---

Gleam's Lustre and Elm structure a UI as one **model**, a list of **messages**, an **update**
function and a **view**. Nothing changes the model except `update`, and `update` never does
I/O: it returns the next model together with **effects** — data that says "fetch this", "wait
this long", "run this task" — and the runtime does the work, turning each result into another
message. `denext/mvu` brings that to a denext app. It is opt-in and a subpath of its own: an
app that never imports it bundles none of it, and nothing about React-style components
changes.

```tsx
"use client";
import { fx, type Next, subs, useMvu } from "denext/mvu";

type Model = { n: number; running: boolean; saved: boolean };
type Msg =
  | { type: "inc" }
  | { type: "toggle" }
  | { type: "saved" }
  | { type: "failed"; error: unknown };

export function update(msg: Msg, m: Model): Next<Model, Msg> {
  switch (msg.type) {
    case "inc":
      return [{ ...m, n: m.n + 1, saved: false }, [
        fx.fetch("/api/count", {
          init: { method: "POST", body: JSON.stringify({ n: m.n + 1 }) },
          ok: () => ({ type: "saved" }),
          err: (error) => ({ type: "failed", error }),
        }),
      ]];
    case "toggle":
      return [{ ...m, running: !m.running }];
    case "saved":
      return [{ ...m, saved: true }];
    case "failed":
      return [m];
  }
}

export function Counter() {
  const [model, dispatch] = useMvu(
    () => [{ n: 0, running: false, saved: true }],
    update,
    (m) => [m.running && subs.interval(1000, { type: "inc" })],
  );
  return (
    <div>
      <button type="button" onClick={() => dispatch({ type: "inc" })}>{model.n}</button>
      <button type="button" onClick={() => dispatch({ type: "toggle" })}>
        {model.running ? "stop" : "auto"}
      </button>
      {model.saved ? null : <span>saving…</span>}
    </div>
  );
}
```

Because `update` returns data, its test needs no fake `fetch`:

```ts
import { assertEquals } from "@std/assert";
import { update } from "./counter.tsx";

const [next, effects] = update({ type: "inc" }, { n: 1, running: false, saved: true });
assertEquals(next.n, 2);
assertEquals(effects?.[0]?.kind, "fetch");
```

## The API

| Export                                        | What it is                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `useMvu(init, update, subscriptions?, opts?)` | Runs a program in a component. Returns `[model, dispatch]`; `dispatch` is stable.                          |
| `MvuView({ program, props? })`                | Renders a whole program (`init(props)`, its `update`, its `view(model, send)`) in the browser.             |
| `defineMvu(program)`                          | Identity, for inference: one program for `MvuView` here and `defineLiveView` on the server.                |
| `fx.fetch(url, { init?, as?, ok, err? })`     | Fetch; `ok` gets a 2xx body (`as: "json"` by default, or `"text"`), `err` a network error or `{ status }`. |
| `fx.delay(ms, msg)`                           | Dispatch `msg` after `ms`.                                                                                 |
| `fx.task(run, ok?, err?)`                     | Run `run(signal)` (any async work); `ok` / `err` turn the outcome into a message.                          |
| `fx.dispatch(msg)`                            | Dispatch `msg` right after the current update.                                                             |
| `subs.interval(ms, msg, key?)`                | Dispatch `msg` every `ms` while the model asks for it.                                                     |
| `subs.channel(channel, key, toMsg)`           | Each payload a `createChannel` channel publishes for `key` becomes a message (over the Live socket).       |
| `eventPayload(event)`                         | What `send((payload) => msg)` receives: a form control's `value` / `checked`, a key, a form's fields.      |

`init` returns `[model, effects?]` and runs during the component's first render (on the server
too, so the first HTML shows the initial model). Its effects, every later update's effects and
the subscriptions start in the browser only, once the component mounts, and stop when it
unmounts: a pending delay is cleared and a running task's or fetch's `signal` is aborted.

Messages are processed in order. A dispatch from inside an effect or a subscription waits for
the current message, and a batch of messages re-renders the component once. An `update` that
throws drops its message and keeps the model (the error is logged).

`subscriptions(model)` is called after every update. A subscription is kept while an equal one
(the same interval period and `key`, the same channel and key) is in the list, picks up the
latest message mapping without restarting, and stops when it leaves the list. A falsy entry is
skipped, so `cond && subs.interval(…)` reads naturally.

## A whole program: `view` and `send`

Give the program a `view(model, send)` and render it with `MvuView`. `send(msg)` returns an
event handler for any `on*` prop; `send((payload) => msg)` builds the message from the event:

```tsx
import { defineMvu } from "denext/mvu";

export const search = defineMvu({
  init: (props: { q: string }) => [{ q: props.q }],
  update: (msg: { type: "typed"; q: string }, _m) => [{ q: msg.q }],
  view: (m, send) => (
    <input value={m.q} onInput={send((e) => ({ type: "typed", q: e.value ?? "" }))} />
  ),
});

// a "use client" component
<MvuView program={search} props={{ q: "" }} />;
```

`send` is what makes the same program run on the server: as a
[live view](/docs/live-views) the handler carries only an index to the browser, and the
message is built on the server. In the browser `send` dispatches locally.

## Time travel in DevTools

In `denext dev` every running program records its messages and the model each produced (the
last 200). The DevTools **MVU** tab lists the programs on the page (named by
`useMvu(…, { name })`, `MvuView`'s `name`, else `mvu`) and their steps; click a step to put
its model on screen. A message dispatched after that continues from the step on screen and
drops the steps after it. Effects and subscriptions keep running while you travel; a step only
replaces the model. Production builds record nothing.
