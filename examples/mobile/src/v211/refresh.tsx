// Pull-to-refresh: a list inside <PullToRefresh>; each refresh takes 1.2 s and bumps a count.
import { useState } from "denext";
import { PullToRefresh } from "denext/mobile";
import { Fill, Screen } from "./shell.tsx";

export function RefreshList(
  { onRefreshed }: { onRefreshed?: (count: number) => void },
) {
  const [refreshing, setRefreshing] = useState(false);
  const [count, setCount] = useState(0);
  const onRefresh = () => {
    setRefreshing(true);
    setTimeout(() => {
      setRefreshing(false);
      setCount((c) => {
        onRefreshed?.(c + 1);
        return c + 1;
      });
    }, 1200);
  };
  return (
    <PullToRefresh
      refreshing={refreshing}
      onRefresh={onRefresh}
      label="Refreshing"
      style={{ height: "100%" }}
      data-selftest="refresh"
    >
      <p class="note" style={{ padding: "0 12px" }}>
        Refreshed <strong data-selftest="refresh-count">{count}</strong> time(s)
        {refreshing ? " · refreshing…" : ""}
      </p>
      <div>
        {Array.from(
          { length: 40 },
          (_, i) => <div key={i} class="list-row">Row {i + 1} (refresh #{count})</div>,
        )}
      </div>
    </PullToRefresh>
  );
}

export function RefreshScreen() {
  return (
    <Screen
      fill
      title="Pull-to-refresh"
      todo="At the top of the list, pull down: a spinner appears (a light haptic when it arms), let go: it spins for ~1 s, then 'Refreshed N time(s)' goes up by one. Scrolling mid-list and flinging does NOT trigger it."
    >
      <Fill>
        <RefreshList />
      </Fill>
    </Screen>
  );
}
