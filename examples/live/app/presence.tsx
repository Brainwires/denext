"use client";
import { useState } from "denext";
import { usePresence } from "denext/live";

// Who's-online for the "lobby" room. `usePresence` joins the room and observes its
// members; `setState` publishes this peer's state to everyone else. The room name
// is gated by `canJoinRoom` in denext.config.ts — a room the policy rejects would
// be refused (dev and prod alike) instead of leaking other users' presence.
export function Presence() {
  const [name, setName] = useState("");
  const { self, others, setState } = usePresence<{ name: string }>("lobby", {
    initialState: { name: "anonymous" },
  });

  return (
    <div class="presence">
      <label class="field">
        Your name
        <input
          value={name}
          placeholder="anonymous"
          onInput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            setName(v);
            setState({ name: v || "anonymous" });
          }}
        />
      </label>

      <p>
        You are <strong>{self?.state.name ?? "…"}</strong>
      </p>
      <p>
        {others.length} other{others.length === 1 ? "" : "s"} here:
      </p>
      <ul class="peers">
        {others.length === 0
          ? <li class="empty">nobody yet</li>
          : others.map((p) => <li key={p.id}>{p.state.name}</li>)}
      </ul>
      <p class="hint">Open a second tab to see presence update live.</p>
    </div>
  );
}
