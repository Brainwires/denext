# denext × useTransition

A runnable demo of denext's **fiber concurrency** on the classic typeahead.
Typing filters 8,000 items: the input is an urgent update (stays responsive)
while the filtered list re-renders as a low-priority **transition** —
time-sliced and interruptible — so `isPending` shows and the browser
paints/handles keystrokes before the heavy re-render commits.

```sh
deno task example:transitions          # build once, serve
deno task example:transitions --dev    # rebuild on each request
```

Open <http://localhost:3002> and type quickly in the filter box.

## What it exercises

- `useTransition` — `startTransition(() => setQuery(v))` deprioritizes the list
  re-render; `isPending` stays true across the yield.
- The urgent `setInput(v)` commits first (responsive field), the transition
  commits on a later macrotask.

> denext renders on a fiber reconciler: transition renders are time-sliced and
> can be interrupted mid-tree by an urgent update, then restarted. For a demo
> that makes the time-slicing and interruption directly visible (a spinner that
> keeps moving while a huge grid re-renders, plus a started/committed counter),
> see `examples/concurrency`. Full model:
> [`README-NEXT-MIGRATION.md` §10](../../README-NEXT-MIGRATION.md).

## Shared-element view transitions (`<ViewTransition>`)

denext also honors `React.ViewTransition` for **route** transitions. Wrap an element
in a `<ViewTransition name="...">` on both the source and destination routes with the
same `name`, and a soft navigation morphs one into the other (where the browser
supports the View Transitions API — a no-op otherwise):

```tsx
import { Link, ViewTransition } from "denext";

// app/gallery/page.tsx
export default function Gallery() {
  return (
    <ul>
      {photos.map((p) => (
        <li key={p.id}>
          <Link href={`/gallery/${p.id}`}>
            <ViewTransition name={`photo-${p.id}`} enter="zoom" exit="zoom">
              <img src={p.thumb} alt={p.title} />
            </ViewTransition>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// app/gallery/[id]/page.tsx — the SAME name pairs the thumbnail with the hero
export default async function Photo({ params }: { params: { id: string } }) {
  const p = await getPhoto(params.id);
  return (
    <ViewTransition name={`photo-${p.id}`}>
      <img src={p.full} alt={p.title} />
    </ViewTransition>
  );
}
```

```css
/* The class from enter/exit becomes a view-transition-class on the pseudo-elements. */
::view-transition-old(.zoom),
::view-transition-new(.zoom) {
  animation-duration: 300ms;
}
```

- The wrapper stamps `view-transition-name` on its host child around the swap — before
  `startViewTransition` on the outgoing element, after the commit on the incoming one —
  then clears it when the transition finishes.
- `addTransitionType("nav-forward")` feeds `startViewTransition({ types })`, and an
  `enter={{ "nav-forward": "slide-left", default: "fade" }}` map resolves against it.
- It works on every soft-nav path (Flight, isomorphic, full-HTML). Only **navigation**
  commits are wrapped — a same-page state toggle is not animated (see
  [KNOWN-LIMITATIONS.md](../../KNOWN-LIMITATIONS.md)).
