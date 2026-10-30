"use client";
// The panel (and the library page of the full window): every VM with its state, RAM and CPU, the
// RAM budget, and start / shut down. Starting over the budget asks first.

import { useRouter, useState } from "denext";
import { formatBytes } from "../lib/format.ts";
import type { VmOverview } from "../lib/types.ts";
import { errorText, hangar } from "./hangar-client.ts";
import { useOverview } from "./use-overview.ts";
import { showFull } from "./window-mode.ts";

export function Panel() {
  const { overview, error, refresh } = useOverview();
  const [message, setMessage] = useState("");
  const [overBudget, setOverBudget] = useState<{ id: string; headless: boolean } | null>(null);
  const router = useRouter();

  const go = (path: string) => void showFull().then(() => router.push(path));

  const act = async (what: () => Promise<unknown>) => {
    setMessage("");
    try {
      await what();
    } catch (err) {
      setMessage(errorText(err));
    }
    await refresh();
  };

  const start = (id: string, headless: boolean, allowOverBudget = false) =>
    act(async () => {
      const r = await hangar.start({ id, headless, allowOverBudget });
      setOverBudget(r.started ? null : { id, headless });
      if (!r.started) {
        setMessage(`Starting it would go ${formatBytes(r.overByBytes)} over the RAM budget.`);
      }
    });

  if (error) return <p className="error">{error}</p>;
  if (!overview) return <p>Loading…</p>;
  const { budget } = overview;
  const pct = Math.min(100, Math.round(budget.usedBytes / budget.budgetBytes * 100));

  return (
    <section className="panel">
      <div className={`budget ${budget.level}`} title={overview.tooltip}>
        <span>
          RAM {formatBytes(budget.usedBytes)} of {formatBytes(budget.budgetBytes)} budget
        </span>
        <meter min={0} max={100} low={70} high={85} optimum={0} value={pct} />
        {budget.level !== "ok" && (
          <strong>{budget.level === "over" ? "Over budget" : "Near budget"}</strong>
        )}
      </div>
      {message && (
        <p className="error">
          {message} {overBudget && (
            <button
              type="button"
              onClick={() => start(overBudget.id, overBudget.headless, true)}
            >
              Start anyway
            </button>
          )}
        </p>
      )}
      {overview.vms.length === 0 && (
        <p>No VMs in {overview.libraryRoot}. Create one, or add a folder with a start.sh.</p>
      )}
      <ul className="vms">
        {overview.vms.map((row) => (
          <VmRow
            key={row.vm.id}
            row={row}
            onStart={(headless) => start(row.vm.id, headless)}
            onShutdown={() => act(() => hangar.shutdown({ id: row.vm.id }))}
            onDetails={() => go(`/vm?id=${encodeURIComponent(row.vm.id)}`)}
          />
        ))}
      </ul>
      <nav className="footer">
        <button type="button" onClick={() => go("/images")}>Images</button>
        <button type="button" onClick={() => go("/create")}>New VM</button>
        <button type="button" onClick={() => go("/settings")}>Settings</button>
      </nav>
    </section>
  );
}

function VmRow(props: {
  row: VmOverview;
  onStart: (headless: boolean) => void;
  onShutdown: () => void;
  onDetails: () => void;
}) {
  const { vm, instance, ambiguous } = props.row;
  return (
    <li data-running={instance ? "yes" : "no"}>
      <button type="button" className="link" onClick={props.onDetails}>
        <span className="dot" /> {vm.name}
      </button>
      <small>
        {instance
          ? `${formatBytes(instance.rssBytes)} · ${instance.cpuPercent.toFixed(0)}% CPU`
          : ambiguous
          ? "several processes claim it"
          : vm.memoryMiB
          ? `stopped · ${formatBytes(vm.memoryMiB * 1024 * 1024)}`
          : "stopped"}
      </small>
      <span className="actions">
        {instance ? <button type="button" onClick={props.onShutdown}>Shut down</button> : (
          <>
            {vm.headlessCapable && (
              <button
                type="button"
                disabled={ambiguous}
                onClick={() => props.onStart(true)}
              >
                Start
              </button>
            )}
            <button type="button" disabled={ambiguous} onClick={() => props.onStart(false)}>
              {vm.headlessCapable ? "Window" : "Start"}
            </button>
          </>
        )}
      </span>
    </li>
  );
}
