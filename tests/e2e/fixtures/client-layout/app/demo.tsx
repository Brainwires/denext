"use client";
// Same-page <ViewTransition> (a startTransition add animates; an urgent one doesn't) and a hidden
// <Activity> whose effects must not mount until it is revealed.
import {
  Activity,
  startTransition,
  useEffect,
  useState,
  useSyncExternalStore,
  ViewTransition,
} from "denext";

const w = globalThis as unknown as { __panelEffects?: number; __panelCleanups?: number };

function Panel() {
  useEffect(() => {
    w.__panelEffects = (w.__panelEffects ?? 0) + 1;
    return () => {
      w.__panelCleanups = (w.__panelCleanups ?? 0) + 1;
    };
  }, []);
  return <p data-testid="panel">panel</p>;
}

// A component whose output is a Fragment of two hosts: the boundary marks both.
function Pair() {
  return (
    <>
      <p data-testid="pair-1">one</p>
      <p data-testid="pair-2">two</p>
    </>
  );
}

// An external store (useSyncExternalStore renders its changes synchronously).
let stored = false;
const listeners = new Set<() => void>();
const store = {
  subscribe: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
  get: () => stored,
  set: (v: boolean) => {
    stored = v;
    for (const fn of listeners) fn();
  },
};

export function Demo() {
  const [pair, setPair] = useState(false);
  const fromStore = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [items, setItems] = useState(["a"]);
  const [shown, setShown] = useState(false);
  const next = () => String.fromCharCode(97 + items.length);
  return (
    <div>
      <button
        type="button"
        data-testid="add"
        onClick={() => startTransition(() => setItems([...items, next()]))}
      >
        add
      </button>
      <button type="button" data-testid="add-urgent" onClick={() => setItems([...items, next()])}>
        add urgently
      </button>
      <button type="button" data-testid="toggle" onClick={() => setShown(!shown)}>
        toggle
      </button>
      <button
        type="button"
        data-testid="pair"
        onClick={() => startTransition(() => setPair(true))}
      >
        pair
      </button>
      <button
        type="button"
        data-testid="store"
        onClick={() => startTransition(() => store.set(true))}
      >
        store
      </button>
      {pair && (
        <ViewTransition name="pair" enter="pair-in">
          <Pair />
        </ViewTransition>
      )}
      {fromStore && (
        <ViewTransition enter="store-in">
          <p data-testid="stored">stored</p>
        </ViewTransition>
      )}
      <ul>
        {items.map((id) => (
          <ViewTransition key={id} enter="item-in" exit="item-out">
            <li data-testid={`item-${id}`}>{id}</li>
          </ViewTransition>
        ))}
      </ul>
      <Activity mode={shown ? "visible" : "hidden"}>
        <Panel />
      </Activity>
    </div>
  );
}
