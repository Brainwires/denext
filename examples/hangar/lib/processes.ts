// Find the running QEMU processes and tie each to exactly one library VM. A process belongs to a
// VM when it is a `qemu-system-*` binary AND its working directory is the VM's folder (`start.sh`
// does `cd "$(dirname "$0")"` before `exec`, and Hangar starts its own VMs there), or, where the
// working directory cannot be read, when the VM's pidfile names it. The `-name` on the command
// line is never trusted: two VMs may share one, and anything can pass it.

import type { Host, ProcessInfo } from "./host.ts";
import type { Instance, VmDefinition } from "./types.ts";

/** The `ps` arguments whose output {@linkcode parsePs} reads (every process, full command lines). */
export const PS_ARGS = ["-axww", "-o", "pid=,ppid=,rss=,%cpu=,args="] as const;

/**
 * The `ps` program that lists the host's processes, or `null` where there is none: Windows has no
 * `/bin/ps` (spawning it fails on every overview poll), so Hangar lists no running QEMU there.
 *
 * @param os `Deno.build.os`.
 */
export function psProgram(os: string): string | null {
  return os === "windows" ? null : "/bin/ps";
}

/** Parse `ps -o pid=,ppid=,rss=,%cpu=,args=` output. */
export function parsePs(output: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const command = m[5].trim();
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKiB: Number(m[3]),
      cpuPercent: Number(m[4].replace(",", ".")),
      executable: command.split(/\s+/)[0],
      command,
    });
  }
  return out;
}

/** A QEMU system emulator process (by its program's file name, not a substring of its args). */
export function isQemuSystem(p: ProcessInfo): boolean {
  const base = p.executable.split("/").pop() ?? "";
  return /^qemu-system-[A-Za-z0-9_]+$/.test(base);
}

/** A pid from a pidfile's text, or `null`. */
export function parsePidFile(text: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(text);
  const pid = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** Strip a trailing slash so folder paths compare exactly. */
function norm(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The QEMU processes, each with its working directory (read once). */
async function qemuProcesses(
  host: Host,
): Promise<{ proc: ProcessInfo; cwd: string | null }[]> {
  const procs = (await host.processes()).filter(isQemuSystem);
  return await Promise.all(
    procs.map(async (proc) => ({ proc, cwd: await host.processCwd(proc.pid) })),
  );
}

/** One VM's match: its instance, or the ambiguity that stops Hangar from acting on it. */
export interface Match {
  readonly instance: Instance | null;
  readonly ambiguous: boolean;
}

/**
 * Match the running QEMU processes to the library.
 *
 * @param host The machine.
 * @param vms The library.
 * @returns Each VM's match, by id.
 */
export async function matchInstances(
  host: Host,
  vms: readonly VmDefinition[],
): Promise<Map<string, Match>> {
  const procs = await qemuProcesses(host);
  const out = new Map<string, Match>();
  for (const vm of vms) {
    const dir = norm((await host.realPath(vm.dir)) ?? vm.dir);
    let matches: { p: ProcessInfo; by: Instance["matchedBy"] }[] = procs.filter((p) =>
      p.cwd !== null && norm(p.cwd) === dir
    )
      .map((p) => ({ p: p.proc, by: "cwd" }));
    if (matches.length === 0 && vm.pidFile && await host.exists(vm.pidFile)) {
      const pid = parsePidFile(await host.readTextFile(vm.pidFile).catch(() => ""));
      // Only a QEMU process whose working directory is unknown: one known to run elsewhere is
      // another VM's (or a reused pid).
      matches = procs.filter((p) => p.proc.pid === pid && p.cwd === null)
        .map((p) => ({ p: p.proc, by: "pidfile" }));
    }
    const first = matches[0];
    out.set(vm.id, {
      ambiguous: matches.length > 1,
      instance: first
        ? {
          vmId: vm.id,
          pid: first.p.pid,
          rssBytes: first.p.rssKiB * 1024,
          cpuPercent: first.p.cpuPercent,
          matchedBy: first.by,
        }
        : null,
    });
  }
  return out;
}
