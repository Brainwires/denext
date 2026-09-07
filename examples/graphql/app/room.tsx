"use client";
import { useState } from "denext";
import { type ChannelRef, useChannel } from "denext/live";

type Message = { room: string; text: string; at: Date };

// The Live-socket side of the same channel: `useChannel` receives exactly what a GraphQL
// `subscription { messages(room: "lobby") }` receives — one publish, two protocols.
export function Room(props: { channel: ChannelRef<Message>; initial: Message[] }) {
  const [seen, setSeen] = useState<Message[]>([]);
  const live = useChannel(props.channel, "lobby");
  if (live.data && seen[seen.length - 1] !== live.data) setSeen([...seen, live.data]);
  const all = [...props.initial, ...seen];
  return (
    <div class="room">
      <p>
        <strong>#lobby</strong> <small>({all.length} message{all.length === 1 ? "" : "s"})</small>
      </p>
      {all.map((m, i) => (
        <p key={i}>
          <small>{m.at instanceof Date ? m.at.toISOString().slice(11, 19) : ""}</small> {m.text}
        </p>
      ))}
    </div>
  );
}
