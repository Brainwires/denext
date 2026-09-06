"use client";
import { useState } from "denext";
import {
  type ChannelRef,
  type SubscriptionRefLike,
  useChannel,
  useSubscription,
} from "denext/live";

type Filter = "all" | "open";
type Stats = { total: number; done: number };
type Event = { kind: "added" | "toggled" | "removed"; title: string };

// Two typed live hooks over the one socket. The subscription and the channel arrive as PROPS
// from the Server Component (a server ref crosses Flight as an opaque id), so this island
// imports nothing server-only.
// - `useSubscription`: the server validates `{ filter }` against the definition's schema,
//   derives the tags, and re-pushes `stats` whenever "todos" is invalidated.
// - `useChannel`: every `todoEvents.publish("all", …)` arrives as a fresh `data` — a push,
//   not a recompute — so the toast shows what just happened in ANY tab.
export function LiveTodos(props: {
  initial: Stats;
  stats: SubscriptionRefLike<{ filter: Filter }, Stats>;
  events: ChannelRef<Event>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <div class="live-todos">
      <Count sub={props.stats} filter={filter} initial={props.initial} />
      <div class="filters">
        <button
          type="button"
          onClick={() => setFilter("all")}
          disabled={filter === "all"}
        >
          all
        </button>
        <button
          type="button"
          onClick={() => setFilter("open")}
          disabled={filter === "open"}
        >
          open
        </button>
      </div>
      <Toast channel={props.events} />
    </div>
  );
}

function Count(
  props: {
    sub: SubscriptionRefLike<{ filter: Filter }, Stats>;
    filter: Filter;
    initial: Stats;
  },
) {
  const stats = useSubscription(props.sub, { filter: props.filter }, {
    initial: props.initial,
  });
  const data = stats.data ?? props.initial;
  const note = stats.error ? ` · ${stats.error.code}` : "";
  return (
    <p class="count" data-total={data.total}>
      {data.done} / {data.total} done
      <small>({props.filter}{note})</small>
    </p>
  );
}

function Toast(props: { channel: ChannelRef<Event> }) {
  const event = useChannel(props.channel, "all");
  const text = event.data ? `${event.data.kind}: ${event.data.title}` : "waiting for events…";
  return <p class="toast" data-kind={event.data?.kind}>{text}</p>;
}
