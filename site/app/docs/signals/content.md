---
title: Preact Signals (denext/signals)
slug: signals
lead: denext/signals is Preact Signals' API on denext — signal, computed, effect, batch, the component hooks and the Show / For helpers. A migrated Fresh or Preact app gets it through its @preact/signals imports, and any denext app can import it.
---

`denext/signals` implements the API of `@preact/signals`, `@preact/signals-core` and
`@preact/signals/utils` on denext's renderer. [Migrating from Fresh](/docs/migrating-fresh) and
[Migrating from Preact](/docs/migrating-preact) map those packages here, so a migrated app's
signals keep working with the source unchanged. It is not limited to migrated apps: any denext
app can `import { signal } from "denext/signals"`, and an app that does not import it ships none of
it.

> [!NOTE]
> **Not the same as `useSignal` from `denext`.** The root `denext` module exports its own
> `Signal` / `useSignal` / `useStore`: serializable, component-scoped state that is the substrate
> of [Resumability](/docs/resumability). `denext/signals` is the Preact Signals model (signals
> that live outside components, `computed`, `effect`, shared reactive state). The two are separate
> implementations and are not interchangeable: don't pass one where the other is expected.

## An example

```tsx
// app/cart.tsx
"use client";
import { batch, computed, For, Show, signal, useSignal } from "denext/signals";

// Module-level state, shared by every component that reads it.
const items = signal<string[]>([]);
const count = computed(() => items.value.length);

export function Cart() {
  const draft = useSignal("");
  const add = () =>
    batch(() => {
      items.value = [...items.value, draft.value];
      draft.value = "";
    });
  return (
    <div>
      <input value={draft.value} onInput={(e) => (draft.value = e.currentTarget.value)} />
      <button type="button" onClick={add}>Add</button>
      <p>{count} items</p>
      <Show when={count} fallback={<p>The cart is empty.</p>}>
        <ul>
          <For each={items}>{(item, i) => <li key={i}>{item}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}
```

Render `<Cart />` from a page. `{count}` renders the signal's value and updates when it changes;
`<Show>` and `<For>` read their signals, so the component re-renders when they change.

## The API

| Export                      | What it does                                                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal(value?)` / `Signal` | A reactive value. Read and assign `.value`; `peek()` reads without subscribing; `subscribe(fn)` calls `fn` with the value now and after every change and returns the unsubscribe function; `toString()`, `toJSON()` and `valueOf()` read the value. |
| `computed(fn)`              | A `ReadonlySignal` derived from the signals `fn` reads, re-evaluated when they change. Assigning its `.value` throws `a computed signal is read-only`, and a computed that writes a signal throws.                                                  |
| `effect(fn)`                | Runs `fn` now and again after any signal it read changes. `fn` may return a cleanup, run before the next run and on dispose. Returns an `EffectDispose`: call it, or use it with `using` (`Symbol.dispose`).                                        |
| `batch(fn)`                 | Applies several writes as one change: effects and re-renders run once, when the outermost batch ends.                                                                                                                                               |
| `untracked(fn)`             | Runs `fn` without subscribing to the signals it reads.                                                                                                                                                                                              |
| `action(fn)`                | Wraps `fn` so each call is batched and untracked.                                                                                                                                                                                                   |
| `useSignal(value?)`         | A signal owned by the component, created once.                                                                                                                                                                                                      |
| `useComputed(fn)`           | A computed owned by the component; `fn` is always the latest render's.                                                                                                                                                                              |
| `useSignalEffect(fn)`       | An effect owned by the component: started after mount, disposed on unmount.                                                                                                                                                                         |
| `useLiveSignal(value)`      | A signal that follows `value` (a prop), updated whenever the component renders with a new one.                                                                                                                                                      |
| `Show`                      | `<Show when fallback>`: renders its children while `when` (a signal or a value) is truthy, else `fallback`. The children may be a function that receives the value.                                                                                 |
| `For`                       | `<For each fallback>{(item, index) => …}</For>`: renders each item of `each` (a signal or an array), or `fallback` when it is empty.                                                                                                                |

Not provided: `useSignalRef` and `createModel` (`denext migrate --check` reports them).

## How it reacts

- **Reading `.value` while rendering subscribes the component**, in the browser: when the signal
  changes, the component re-renders. A server render reads the value once.
- **A signal as a JSX child** (`<p>{count}</p>`) renders its value as text and updates when it
  changes.
- **A signal as a DOM prop** (`<input value={text} />`) is bound only in code compiled with
  Preact's JSX runtime: `jsxImportSource: "preact"`, which resolves to
  `denext/preact/jsx-runtime` (a migrated Fresh app has it; a migrated Preact app has it when
  `migrate` wrote its `deno.json`). Elsewhere pass `text.value`, as the example does.
- **Effects run at the end of the outermost batch** (a lone write is its own batch). Effects that
  keep changing the signals they read are stopped after 100 flush rounds with an error naming the
  cycle.
- **Reactivity is per component**: a change re-renders the components that read the signal,
  where Preact patches a signal child's text node directly. See
  [Known limitations](/docs/limitations).

## Signals from a Server Component

A signal a Server Component passes to a `"use client"` component as a prop arrives as a live
signal on a route rendered through Flight: its current value is serialized, and the client revives
one shared signal per server signal, so two client components handed the same signal share it,
as two islands do in Fresh. The receiving client module must import `denext/signals` (a value
import, not `import type`); without it the value arrives plain.

```tsx
// app/page.tsx (a Server Component)
import { signal } from "denext/signals";
import { Counter, Display } from "./counter.tsx";

export default function Page() {
  const count = signal(3);
  return (
    <>
      <Counter count={count} />
      <Display count={count} /> {/* the same client signal as Counter's */}
    </>
  );
}
```
