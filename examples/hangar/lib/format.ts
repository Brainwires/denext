// Pure helpers the backend and the page share: byte sizes, the RAM budget, the tray tooltip and the
// ssh / RDP quick actions. No Deno APIs, so the page bundle can import them.

import type { Instance, RamBudget, VmDefinition } from "./types.ts";

/** `1536` → `"1.5 KiB"`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/** A QEMU size argument (`20G`, `512M`) from the page, or `null` when it is not one. */
export function parseSize(text: string): string | null {
  const m = /^\s*(\d{1,7})\s*([KMGT])(?:i?B)?\s*$/i.exec(text);
  return m && Number(m[1]) > 0 ? `${m[1]}${m[2].toUpperCase()}` : null;
}

/**
 * The RAM budget: the running VMs' resident memory against `percent` of the host's.
 *
 * @param usedBytes What the running VMs use.
 * @param totalBytes The host's memory.
 * @param percent The share VMs may use (10–100).
 */
export function ramBudget(usedBytes: number, totalBytes: number, percent: number): RamBudget {
  const budgetBytes = Math.round(totalBytes * Math.min(100, Math.max(10, percent)) / 100);
  const level = usedBytes > budgetBytes ? "over" : usedBytes > budgetBytes * 0.85 ? "warn" : "ok";
  return { usedBytes, budgetBytes, totalBytes, level };
}

/**
 * Whether starting a VM of `memoryMiB` would push the budget over.
 *
 * @returns The bytes it would be over by, or `0`.
 */
export function overBudgetBy(budget: RamBudget, memoryMiB: number | null): number {
  const after = budget.usedBytes + (memoryMiB ?? 0) * 1024 * 1024;
  return Math.max(0, after - budget.budgetBytes);
}

/** The tray tooltip: how many VMs run and the RAM they use. */
export function trayTooltip(running: readonly Instance[], budget: RamBudget): string {
  if (running.length === 0) return "Hangar: no VMs running";
  const vms = running.length === 1 ? "1 VM" : `${running.length} VMs`;
  const warn = budget.level === "over" ? " (over budget)" : "";
  return `Hangar: ${vms} running, ${formatBytes(budget.usedBytes)} RAM${warn}`;
}

/** The host port forwarded to `guestPort` over TCP, or `null`. */
function hostPortFor(vm: VmDefinition, guestPort: number): number | null {
  return vm.forwards.find((f) => f.proto === "tcp" && f.guestPort === guestPort)?.hostPort ?? null;
}

/** The ssh command for a VM (its script's own hint, else the forwarded port 22), or `null`. */
export function sshCommand(vm: VmDefinition): string | null {
  if (vm.sshHint) return vm.sshHint;
  const port = hostPortFor(vm, 22);
  return port === null ? null : `ssh -p ${port} localhost`;
}

/** A Remote Desktop address (`localhost:3390`) for the forwarded port 3389, or `null`. */
export function rdpAddress(vm: VmDefinition): string | null {
  const port = hostPortFor(vm, 3389);
  return port === null ? null : `localhost:${port}`;
}
