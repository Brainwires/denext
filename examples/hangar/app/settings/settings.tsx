"use client";
// Hangar's settings: the library folder, QEMU's install prefix, the RAM budget and how long a
// graceful shutdown waits. Kept by the backend in the app's data folder.

import { useEffect, useState } from "denext";
import type { HangarSettings } from "../../lib/types.ts";
import { errorText, hangar } from "../hangar-client.ts";

export function Settings() {
  const [settings, setSettings] = useState<HangarSettings | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    hangar.getSettings().then(setSettings, (err) => setMessage(errorText(err)));
  }, []);
  if (!settings) return <p className="message">{message || "Loading…"}</p>;
  const set = (key: keyof HangarSettings) => (e: { target: unknown }) => {
    const el = e.target as HTMLInputElement;
    setSettings({ ...settings, [key]: el.type === "number" ? Number(el.value) : el.value });
  };
  const save = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    try {
      setSettings(await hangar.setSettings(settings));
      setMessage("Saved.");
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <form className="form" onSubmit={save}>
      <h1>Settings</h1>
      <label>
        Library folder <input value={settings.libraryRoot} onInput={set("libraryRoot")} />
      </label>
      <label>
        QEMU prefix <input value={settings.qemuPrefix} onInput={set("qemuPrefix")} />
      </label>
      <label>
        RAM budget (% of host memory){" "}
        <input
          type="number"
          min={10}
          max={100}
          value={settings.ramBudgetPercent}
          onInput={set("ramBudgetPercent")}
        />
      </label>
      <label>
        Graceful shutdown timeout (seconds){" "}
        <input
          type="number"
          min={5}
          max={600}
          value={settings.shutdownTimeoutSeconds}
          onInput={set("shutdownTimeoutSeconds")}
        />
      </label>
      <button type="submit">Save</button>
      {message && <p className="message">{message}</p>}
    </form>
  );
}
