// Read what a VM folder's `start.sh` launches, without running it: the QEMU binary, `-name`,
// `-m`, `-smp`, the accelerator, the disks, the QMP socket, the forwarded ports and whether it
// honours `LAB_HEADLESS=1`. A best-effort static read of the common shapes (`${MEM:-6G}`,
// `QEMU=/path` then `exec "$QEMU"`); anything it cannot read is `null`, and Hangar still starts
// the VM through the script itself.

import { isAbsolute, join } from "@std/path";
import type { PortForward, VmDefinition } from "./types.ts";

/** Expand `${VAR:-default}`, `${VAR}`, `"$VAR"` and `$VAR` from the script's own assignments. */
export function expandScriptVariables(script: string): string {
  const vars = new Map<string, string>();
  for (const line of script.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|(\S+))\s*(#.*)?$/.exec(line);
    if (m) vars.set(m[1], m[3] ?? m[4] ?? m[5] ?? "");
  }
  return script
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g, (_, n, d) => vars.get(n) ?? d)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, n) => vars.get(n) ?? all)
    .replace(/"\$([A-Za-z_][A-Za-z0-9_]*)"/g, (all, n) => vars.has(n) ? `"${vars.get(n)}"` : all)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g, (all, n) => vars.get(n) ?? all);
}

/** A QEMU memory size (`6G`, `8192`, `512M`) in MiB, or `null`. */
export function parseMemoryMiB(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)i?B?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  const mib = unit === "G"
    ? n * 1024
    : unit === "T"
    ? n * 1024 * 1024
    : unit === "K"
    ? n / 1024
    : n; // QEMU's default unit is MiB
  return Math.round(mib);
}

/** `key=value,key=value` → a map (a bare first item is keyed `""`). */
function options(spec: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of spec.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) out.set(out.size === 0 ? "" : part, "");
    else out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

/** Strip one pair of surrounding quotes. */
function unquote(s: string): string {
  return s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/** Every `hostfwd=` in the script. */
function parseForwards(text: string): PortForward[] {
  const out: PortForward[] = [];
  const re = /hostfwd=(tcp|udp):([\d.]*):(\d+)-[\d.]*:(\d+)/g;
  for (const m of text.matchAll(re)) {
    out.push({
      proto: m[1] as "tcp" | "udp",
      hostAddress: m[2],
      hostPort: Number(m[3]),
      guestPort: Number(m[4]),
    });
  }
  return out;
}

/** `ssh …@localhost` from a comment, only in a plain form safe to hand to a shell. */
function sshHint(script: string): string | null {
  const m = /SSH:\s*(ssh(?: -p \d{1,5})? [A-Za-z0-9._-]+@(?:localhost|127\.0\.0\.1))\s*$/m
    .exec(script);
  return m ? m[1] : null;
}

/**
 * Read a `start.sh` into a VM definition.
 *
 * @param id The folder name.
 * @param dir The folder (absolute).
 * @param script The script's text.
 */
export function parseStartScript(id: string, dir: string, script: string): VmDefinition {
  const text = expandScriptVariables(script);
  const binary = /(?:^|[\s"'/])(qemu-system-([A-Za-z0-9_]+))\b/m.exec(text);
  const name = /\s-name\s+("[^"]*"|'[^']*'|\S+)/.exec(text);
  const mem = /\s-m\s+("?[^\s"]+"?)/.exec(text);
  const smp = /\s-smp\s+"?(\d+)/.exec(text);
  const accel = /\s-accel\s+"?([a-z]+)/.exec(text) ?? /accel=([a-z]+)/.exec(text);
  const qmp = /\s-qmp\s+"?unix:([^,\s"]+)/.exec(text);
  const pidfile = /\s-pidfile\s+"?(?:\$PWD\/)?([^\s"]+)"?/.exec(text);
  const disks: string[] = [];
  for (const m of text.matchAll(/\s-drive\s+("[^"]*"|\S+)/g)) {
    const o = options(unquote(m[1]));
    const file = o.get("file");
    if (!file || o.get("if") === "pflash" || o.get("media") === "cdrom") continue;
    if (!disks.includes(file)) disks.push(file);
  }
  const abs = (p: string) => isAbsolute(p) ? p : join(dir, p);
  return {
    id,
    name: name ? unquote(name[1]) : id,
    kind: "script",
    dir,
    arch: binary ? binary[2] : null,
    accel: accel ? accel[1] : null,
    cpus: smp ? Number(smp[1]) : null,
    memoryMiB: mem ? parseMemoryMiB(unquote(mem[1])) : null,
    disks,
    qmpSocket: qmp ? abs(qmp[1]) : null,
    pidFile: pidfile ? abs(pidfile[1]) : null,
    headlessCapable: /\bLAB_HEADLESS\b/.test(script),
    forwards: parseForwards(text),
    sshHint: sshHint(script),
  };
}
