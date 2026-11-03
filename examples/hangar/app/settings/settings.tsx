"use client";
// Hangar's settings: the library folder, QEMU's install prefix, the RAM budget and how long a
// graceful shutdown waits. Kept by the backend in the app's data folder. The backend decides what a
// page may change (lib/page-settings.ts): the QEMU prefix is shown, not edited here, and
// the RAM budget goes up to its page bound; the settings file holds the rest.

import { useEffect, useState } from "denext";
import { PAGE_MAX_RAM_BUDGET } from "../../lib/page-settings.ts";
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
        QEMU prefix <input value={settings.qemuPrefix} readOnly />
        <small>Set in hangar-settings.json, in the app's data folder.</small>
      </label>
      <label>
        RAM budget (% of host memory){" "}
        <input
          type="number"
          min={10}
          max={Math.max(PAGE_MAX_RAM_BUDGET, settings.ramBudgetPercent)}
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
