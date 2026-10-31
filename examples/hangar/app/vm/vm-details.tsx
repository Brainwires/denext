"use client";
// One VM: its definition, live QMP status, forwarded ports, the ssh / Remote Desktop quick
// actions, shutdown and (after the confirm step) force stop by its exact pid.

import { useEffect, useSearchParams, useState } from "denext";
import { writeClipboard } from "denext/mobile";
import { formatBytes, rdpAddress, sshCommand } from "../../lib/format.ts";
import { ConfirmButton } from "../confirm.tsx";
import { errorText, hangar } from "../hangar-client.ts";
import { useOverview } from "../use-overview.ts";

export function VmDetails() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const { overview, error, refresh } = useOverview();
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState("");
  const row = overview?.vms.find((r) => r.vm.id === id);
  const pid = row?.instance?.pid;

  useEffect(() => {
    if (!id) return;
    hangar.status({ id }).then(setStatus, () => setStatus("unknown"));
  }, [id, pid]);

  const act = async (label: string, what: () => Promise<unknown>) => {
    setMessage(`${label}…`);
    try {
      const out = await what();
      setMessage(typeof out === "string" ? `${label}: ${out}` : `${label}: done`);
    } catch (err) {
      setMessage(errorText(err));
    }
    await refresh();
  };

  if (error) return <p className="error">{error}</p>;
  if (!overview) return <p>Loading…</p>;
  if (!row) return <p>No VM “{id}” in the library.</p>;
  const { vm, instance } = row;
  const ssh = sshCommand(vm);
  const rdp = rdpAddress(vm);

  return (
    <section>
      <h1>{vm.name}</h1>
      <dl className="facts">
        <dt>State</dt>
        <dd>{instance ? `running (pid ${instance.pid}), QMP: ${status || "…"}` : "stopped"}</dd>
        <dt>Kind</dt>
        <dd>{vm.kind === "script" ? "start.sh (adopted)" : "Hangar config"}</dd>
        <dt>Machine</dt>
        <dd>
          {vm.arch ?? "?"} · {vm.accel ?? "?"} · {vm.cpus ?? "?"} CPUs ·{" "}
          {vm.memoryMiB ? formatBytes(vm.memoryMiB * 1024 * 1024) : "?"}
        </dd>
        {instance && (
          <>
            <dt>Using</dt>
            <dd>
              {formatBytes(instance.rssBytes)} RAM · {instance.cpuPercent.toFixed(0)}% CPU
            </dd>
          </>
        )}
        <dt>Disks</dt>
        <dd>{vm.disks.join(", ") || "none"}</dd>
        <dt>Ports</dt>
        <dd>
          {vm.forwards.map((f) => `${f.hostPort} → ${f.guestPort}/${f.proto}`).join(", ") ||
            "none"}
        </dd>
      </dl>

      <h2>Connect</h2>
      <p className="row">
        {ssh
          ? (
            <>
              <code>{ssh}</code>
              <button type="button" onClick={() => act("Copied", () => writeClipboard(ssh))}>
                Copy
              </button>
              <button
                type="button"
                onClick={() => act("Terminal", () => hangar.openTerminal({ id }))}
              >
                Open in Terminal
              </button>
            </>
          )
          : <span>No ssh port forwarded.</span>}
      </p>
      {rdp && (
        <p className="row">
          Remote Desktop: <code>{rdp}</code>
          <button type="button" onClick={() => act("Copied", () => writeClipboard(rdp))}>
            Copy
          </button>
        </p>
      )}

      <h2>Power</h2>
      <p className="row">
        {instance
          ? (
            <>
              <button type="button" onClick={() => act("Shutdown", () => hangar.shutdown({ id }))}>
                Shut down
              </button>
              <ConfirmButton
                label="Force stop"
                expected={vm.id}
                onConfirm={(confirm) =>
                  act("Force stop", () => hangar.forceStop({ id, pid: instance.pid, confirm }))}
              />
            </>
          )
          : (
            <>
              {vm.headlessCapable && (
                <button
                  type="button"
                  onClick={() => act("Start", () => hangar.start({ id, headless: true }))}
                >
                  Start headless
                </button>
              )}
              <button
                type="button"
                onClick={() => act("Start", () => hangar.start({ id, headless: false }))}
              >
                Start with a window
              </button>
            </>
          )}
      </p>
      {message && <p className="message">{message}</p>}
    </section>
  );
}
