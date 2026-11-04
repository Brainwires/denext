// One window's workspace: its id and key, its counter's ticks (live, after the replay a reattach
// brings), and the counters its key owned before it closed. In a browser (`denext task dev`) the
// desktop calls reject `unavailable` and the page says so.
"use client";
import { useEffect, useState } from "denext";
import { desktopExtension, onDesktopEvent } from "denext/desktop/client";
import { currentWindowId, getWindows } from "denext/desktop/window";
import { latestCount, replayNote, type Tick, windowLabel } from "../lib/counters.ts";

const counters = desktopExtension<typeof import("../desktop/counters.ts")>("counters");

/** This window, and its counter: the one its key owned before (with the ticks missed), else new. */
interface Joined {
  readonly id: string;
  readonly key?: string;
  readonly counter: string;
  readonly replay: readonly Tick[];
}

/** Find this window and take its key's counter back, or start one. */
async function join(): Promise<Joined> {
  const id = await currentWindowId();
  const key = (await getWindows()).find((w) => w.id === id)?.key;
  const { ids } = await counters.mine(key !== undefined ? { key } : {});
  if (ids.length === 0) {
    const started = await counters.start({});
    return { id, key, counter: started.id, replay: [] };
  }
  const { replay } = await counters.attach({ id: ids[0] });
  return { id, key, counter: ids[0], replay };
}

/** Join this window's counter once, then follow its ticks. */
function useWorkspace(): { joined: Joined | null; ticks: Tick[]; error: string | null } {
  const [joined, setJoined] = useState<Joined | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    join().then((j) => {
      if (cancelled) return;
      setTicks([...j.replay]);
      setJoined(j);
    }, (err) => {
      if (!cancelled) setError(String((err as { code?: unknown }).code ?? err));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (joined === null) return;
    // The counter's ticks reach this window only (the resource's owner).
    return onDesktopEvent("counters", "tick", (data) => {
      const { id, data: tick } = data as { id: string; data: Tick };
      if (id === joined.counter) setTicks((list) => [...list.slice(-19), tick]);
    });
  }, [joined]);

  return { joined, ticks, error };
}

/** The window's name, the count and the replay note. */
function View({ joined, ticks }: { joined: Joined; ticks: Tick[] }) {
  const note = replayNote(joined.replay.length);
  return (
    <>
      <h1>{windowLabel(joined)}</h1>
      <p className="note">
        Window{" "}
        <code>{joined.id}</code>. Close it and reopen it from the Window menu: the counter keeps
        going and the ticks come back.
      </p>
      <p className="big">{latestCount(ticks)}</p>
      <p className="note">{note}</p>
    </>
  );
}

export function Workspace() {
  const { joined, ticks, error } = useWorkspace();
  if (error) return <p className="note">Open this page in the desktop app ({error}).</p>;
  if (joined === null) return <p className="note">…</p>;
  return <View joined={joined} ticks={ticks} />;
}
