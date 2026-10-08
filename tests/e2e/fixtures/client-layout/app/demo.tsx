"use client";
// Same-page <ViewTransition> (a startTransition add animates; an urgent one doesn't) and a hidden
// <Activity> whose effects must not mount until it is revealed.
import { Activity, startTransition, useEffect, useState, ViewTransition } from "denext";

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

export function Demo() {
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
