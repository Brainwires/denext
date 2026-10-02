---
title: Client Components
slug: client-components
lead: The interactive half of an app — "use client" boundaries, useOptimistic / useFormStatus / useTransition, dynamic() and lazy(), portals, context providers in the root layout, and the SSR-safe utility hooks whose first render always equals the server's.
---

Everything under `app/` is a Server Component until a file starts with
`"use client"`. That file and everything it imports ship to the browser; the
components it exports are the interactive leaves of the tree. This page is the
toolkit for those leaves. The rules of the boundary itself (what can cross it,
why a function prop cannot) are on [Islands & hydration](/docs/islands); the
lint rules that enforce hook placement are `denext/rules-of-hooks`,
`denext/hooks-in-component` and `denext/no-hooks-in-async`.

Every hook here is imported from **`denext`** (the React hooks are also on
`denext/client`; the utility hooks are on `denext` only). `createPortal` lives
on `denext/client`.

## The boundary in one file

```tsx
// app/counter.tsx
"use client";
import { useState } from "denext";

export function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  return <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
```

A Server Component renders `<Counter start={3} />`; the `start` prop crosses as
data. A component that takes `children` can wrap Server Components without
turning them into client code — the children arrive as already-rendered Flight
output.

## Forms and mutations

### `useFormStatus` — the nearest form's pending state

Scoped to the enclosing `<form action={fn}>`; two forms on one page report
independently. `{ pending: false }` outside a form and during server rendering.

```tsx
"use client";
import { useFormStatus } from "denext";

export function SubmitButton({ children }: { children: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Saving…" : children}
    </button>
  );
}
```

Put it in a child of the form, not the component that renders the `<form>` — the
status comes from context the form provides.

### `useOptimistic` — show the result before the server confirms

`useOptimistic(state, updateFn?)` returns `[optimisticState, addOptimistic]`.
The optimistic value is shown until the action or transition it was applied in
settles — success or failure — or until `state` itself changes; a failed action
therefore reverts on its own.

```tsx
"use client";
import { useOptimistic } from "denext";
import { toggleTodo } from "./actions.ts";

export function Todo(
  { todo }: { todo: { id: string; done: boolean; title: string } },
) {
  const [done, setDone] = useOptimistic(
    todo.done,
    (_current, next: boolean) => next,
  );
  return (
    <form
      action={async () => {
        setDone(!done); // paints immediately
        await toggleTodo(todo.id); // the real value arrives with the refreshed route
      }}
    >
      <button type="submit" aria-pressed={done}>
        {done ? "✓" : "○"} {todo.title}
      </button>
    </form>
  );
}
```

The single-argument form `setDone(value)` (no `updateFn`) treats the action as
the next value. Apply it inside a form action, an action passed to
`useActionState`, or `startTransition` — outside a transition it persists until
the base state changes.

### `useTransition` — keep the page responsive during an update

`[isPending, startTransition]`. Updates inside the callback are low priority: a
pending indicator paints and input stays responsive before the heavy work lands.
An `async` callback holds `isPending` until its promise settles.

```tsx
"use client";
import { useRouter, useTransition } from "denext";

export function FilterLink(
  { href, children }: { href: string; children: string },
) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      data-pending={isPending}
      onClick={() => startTransition(() => router.push(href))}
    >
      {children}
    </button>
  );
}
```

`useActionState` runs its action inside a transition already, so `useOptimistic`
overlays applied in an action revert when the action settles. Server Actions
themselves — `defineAction`, `useActionState`, `idleActionState` — are covered
on [Server Actions](/docs/server-actions).

## Loading code on demand

### `dynamic()` — a component in its own chunk, with a fallback

```tsx
"use client";
import { dynamic } from "denext";

const Chart = dynamic(() => import("./chart.tsx"), {
  ssr: false, // the server renders `loading` (or nothing); the client mounts it after paint
  loading: ({ pastDelay, error, retry }) =>
    error
      ? <button type="button" onClick={retry}>Retry</button>
      : pastDelay
      ? <p>Loading chart…</p>
      : null,
});

export function Dashboard() {
  return <Chart series={[1, 2, 3]} />;
}
```

The build turns the `import()` into a separately served chunk, fetched on the
first render of `Chart`. `dynamic` wraps its own Suspense boundary; `loading`
receives Next's props (`isLoading`, `pastDelay` after `delay` ms — default 200 —
`timedOut` after `timeout`, `error` and `retry`). A load error with no `loading`
component reaches the nearest error boundary. `ssr: false` is for a component
that touches `window` at module or render time.

### `lazy()` — suspend to the nearest `<Suspense>`

`lazy(() => import("./c.tsx"))` is React's shape: no boundary of its own, so the
enclosing `<Suspense fallback>` shows while the module loads. Use it when
several lazy components should share one fallback.

```tsx
"use client";
import { lazy, Suspense } from "denext";

const Editor = lazy(() => import("./editor.tsx"));
const Preview = lazy(() => import("./preview.tsx"));

export function Workspace() {
  return (
    <Suspense fallback={<p>Loading workspace…</p>}>
      <Editor />
      <Preview />
    </Suspense>
  );
}
```

## Portals

`createPortal(children, container, key?)` renders into another DOM node while
keeping the component and context tree. It is on `denext/client` (it needs a DOM
container, so it has no server meaning); render it from an effect-guarded branch
or a component that only mounts on the client.

```tsx
"use client";
import { useEffect, useState, type VNodeChildren } from "denext";
import { createPortal } from "denext/client";

export function Modal(
  { open, children }: { open: boolean; children: VNodeChildren },
) {
  const [container, setContainer] = useState<Element | null>(null);
  useEffect(() => setContainer(document.body), []); // null on the server and the first client render
  if (!open || !container) return null;
  return createPortal(<div class="modal">{children}</div>, container);
}
```

Reading `document.body` in an effect, not during render, is what keeps the first
client render identical to the server's — see the hydration entry on
[Troubleshooting](/docs/troubleshooting).

## Context providers in the root layout

A provider is a Client Component; the layout stays a Server Component and passes
`children` through:

```tsx
// app/providers.tsx
"use client";
import { createContext, useContext, useState, type VNodeChildren } from "denext";

const ThemeContext = createContext<
  { theme: string; setTheme: (t: string) => void }
>({
  theme: "light",
  setTheme: () => {},
});

export function Providers({ children }: { children: VNodeChildren }) {
  const [theme, setTheme] = useState("light");
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
```

```tsx
// app/layout.tsx — a Server Component
import type { VNodeChildren } from "denext";
import { Providers } from "./providers.tsx";

export default function RootLayout({ children }: { children: VNodeChildren }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

Only Client Components can call `useTheme()`; a Server Component that needs the
same value reads it from where it really lives (a cookie via `cookies()`, the
session via `auth()`) and passes it down as a prop.

## Branching in JSX: `choose`

`choose(value, cases, defaultCase?)` from `denext` (after Lit's) is a lazy
`switch` you can drop straight into JSX: it runs only the branch for `value`
and returns its result, `defaultCase()` when nothing matches, or `undefined`
when there is no default. It is a plain function, so it works in Server and
Client Components alike.

```tsx
import { choose } from "denext";

type Status = "loading" | "error" | "empty" | "ready";

export function Orders({ status, rows }: { status: Status; rows: Order[] }) {
  return (
    <section>
      {choose(status, {
        loading: () => <Spinner />,
        error: () => <p role="alert">Could not load orders.</p>,
        ready: () => <OrderTable rows={rows} />,
      }, () => <p>No orders yet.</p>)}
    </section>
  );
}
```

Only `cases`' own keys match: a `value` of `"toString"` or `"__proto__"` falls
through to `defaultCase` instead of finding an `Object.prototype` member. The
fallback is a separate argument, so a `value` of `"default"` matches a
`default` case, not the fallback.

## SSR-safe utility hooks

Browser state — storage, viewport, network, observers — does not exist on the
server, and a hook that reads it during the first client render produces markup
that differs from the server's: a hydration mismatch. Every utility hook below
is built on one rule: **the first client render returns the same value the
server rendered**, and the real value is adopted afterwards (in an effect, or
through `useSyncExternalStore`'s server snapshot during hydration). You pay one
extra render for a stored value instead of a mismatch. All of them are exported
from `denext`, and all are no-ops on the server and where the underlying API is
absent (`isSupported` reports which).

| Hook                                     | Returns                                                  | Server / first render                          |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `useLocalStorage(key, initial)`          | `[value, setValue, remove]`, JSON-serialised, cross-tab  | `initial`; the stored value arrives post-mount |
| `useSessionStorage(key, initial)`        | same, per tab                                            | `initial`                                      |
| `useMediaQuery(query, serverFallback?)`  | `boolean`                                                | `serverFallback` (default `false`)             |
| `useWindowSize()`                        | `{ width, height }`                                      | `{ width: 0, height: 0 }`                      |
| `useNetworkState()`                      | `{ online, effectiveType?, downlink?, rtt?, saveData? }` | `{ online: true }`                             |
| `useDebouncedValue(value, delayMs)`      | the value once it has been still for `delayMs`           | `value` (the timer runs client-side only)      |
| `useIntersectionObserver(options?)`      | `{ ref, entry, isIntersecting, isSupported }`            | `isIntersecting: false`                        |
| `useCopyToClipboard(resetAfterMs?)`      | `{ copy, copied, error, isSupported }`                   | `copy` resolves `false`, `isSupported: false`  |
| `useEventListener(type, handler, opts?)` | `void` — `window` (or `target`) listener, latest closure | no listener                                    |
| `useClickOutside(ref, handler, events?)` | `void`                                                   | no listener                                    |
| `useAsyncEffect(effect, deps)`           | `void` — an async effect with an `AbortSignal` per run   | not run                                        |

```tsx
"use client";
import { useDebouncedValue, useLocalStorage, useMediaQuery, useState } from "denext";

export function Search() {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 300); // fire the request on this, not on `query`
  const [recent, setRecent] = useLocalStorage<string[]>("recent-searches", []);
  const compact = useMediaQuery("(max-width: 600px)");
  return (
    <div data-compact={compact}>
      <input
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      <ul>
        {recent.map((r) => <li key={r} onClick={() => setQuery(r)}>{r}</li>)}
      </ul>
      {debounced && (
        <Results
          query={debounced}
          onPick={(r) => setRecent([r, ...recent].slice(0, 5))}
        />
      )}
    </div>
  );
}
```

`recent` is `[]` on the server and on the first client render even when the
browser has five entries stored; the list fills in one render later. Branch on
the server value where it matters (`width === 0 ? "…" : width + "px"`) rather
than assuming the browser value is there from the start.

Two more browser hooks with the same contract, `useWakeLock` and
`usePictureInPicture`, are on [Browser APIs](/docs/browser-apis).

### Files in the browser: OPFS and the File System Observer

Three hooks over the Origin Private File System, each live: a listing or a
file's contents re-read themselves when the underlying storage changes, through
the File System Observer API where the browser has it (Chromium at the time of
writing; `isSupported` says).

```tsx
"use client";
import { useDirectory, useFile, useOPFSRoot } from "denext";

export function Notes() {
  const { isSupported } = useOPFSRoot();
  const { entries } = useDirectory("notes"); // re-lists on change
  const { data, write } = useFile<{ text: string }>("notes/today.json", {
    as: "json",
    create: true,
  });
  if (!isSupported) return <p>This browser has no private file system.</p>;
  return (
    <>
      <ul>{entries.map((e) => <li key={e.name}>{e.name}</li>)}</ul>
      <textarea
        value={data?.text ?? ""}
        onInput={(e) =>
          write(
            JSON.stringify({ text: (e.target as HTMLTextAreaElement).value }),
          )}
      />
    </>
  );
}
```

- `useOPFSRoot()` — `{ root, isSupported, error }`; `root` is `null` until it
  resolves.
- `useDirectory(pathOrHandle, { recursive? })` —
  `{ entries, loading, error,
  refresh, isSupported }`, entries sorted by name.
  A path is resolved under the OPFS root; a `FileSystemDirectoryHandle` (a
  user-picked directory) is used as is.
- `useFile(pathOrHandle, { as?: "text" | "arrayBuffer" | "json", create? })` —
  `{ data, loading, error, write, remove, refresh, isSupported }`; `write`
  creates the file and its parents.
- `useFileSystemObserver(handle | handles, callback, { recursive? })` — the
  primitive the two above use; `callback` is held in a ref, so a fresh closure
  each render does not re-subscribe. Pass a stable handle reference.

On the server every one of them reports `isSupported: false`, `data: null` and
an empty listing — the same values the first client render shows.
