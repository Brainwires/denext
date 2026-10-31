// The VMs Hangar creates itself: a `hangar.json` per folder instead of a `start.sh`, and the
// QEMU command line built from it. Validation is strict (the file is also what the page sends to
// "create VM"), so a value never reaches QEMU's argv unchecked.

import { join } from "@std/path/posix";
import type { PortForward, VmDefinition } from "./types.ts";

/** The config file's name in a VM folder. */
export const CONFIG_FILE = "hangar.json";
/** The QMP socket every Hangar VM gets, in its folder. */
const QMP_SOCKET = "qmp.sock";
/** The pidfile a headless start writes, in the VM's folder. */
const PID_FILE = "qemu.pid";
/** The aarch64 UEFI variable store copied into a new VM's folder. */
export const VARS_FILE = "vars.fd";

/** One disk of a Hangar VM. */
export interface DiskConfig {
  /** The image file, in the VM's folder. */
  readonly file: string;
  /** How the guest sees it. */
  readonly interface: "virtio" | "nvme";
}

/** One user-mode NIC. */
export interface NicConfig {
  readonly model: "virtio-net-pci" | "e1000e";
  readonly forwards: readonly PortForward[];
}

/** `hangar.json`. */
export interface HangarVmConfig {
  readonly version: 1;
  readonly name: string;
  readonly arch: "aarch64" | "x86_64";
  readonly accel: "hvf" | "tcg";
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly disks: readonly DiskConfig[];
  /** An installer ISO to boot from once (absolute path), or `null`. */
  readonly iso: string | null;
  readonly nics: readonly NicConfig[];
  /** The display when started windowed (`none` = always headless). */
  readonly display: "none" | "cocoa";
}

/** A VM id (its folder name): lower-case letters, digits, `-`, `_`, `.`; not starting with `.`. */
export const VM_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** An image file name inside a VM folder. */
export const IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.(qcow2|img|raw|vmdk|vhdx|vdi)$/;

/** A config validation failure (the message names the field, never a path). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) {
    throw new ConfigError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new ConfigError(`${field} must be a list of at most ${max}`);
  }
  return value;
}

function forward(value: unknown, field: string): PortForward {
  const f = record(value, field);
  return {
    proto: oneOf(f.proto ?? "tcp", ["tcp", "udp"] as const, `${field}.proto`),
    hostAddress: "127.0.0.1",
    hostPort: int(f.hostPort, `${field}.hostPort`, 1024, 65535),
    guestPort: int(f.guestPort, `${field}.guestPort`, 1, 65535),
  };
}

/** The display name: 1–64 characters, no quotes, commas or control characters. */
function vmName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  const bad = /[",]/.test(name) || [...name].some((ch) => ch.charCodeAt(0) < 32);
  if (name === "" || name.length > 64 || bad) {
    throw new ConfigError("name must be 1–64 characters, without quotes, commas or controls");
  }
  return name;
}

/** The disks: 1–4 image files in the VM's folder. */
function disks(value: unknown): DiskConfig[] {
  const out = list(value, "disks", 4).map((d, i) => {
    const disk = record(d, `disks[${i}]`);
    if (typeof disk.file !== "string" || !IMAGE_FILE.test(disk.file)) {
      throw new ConfigError(`disks[${i}].file must be an image file name in the VM's folder`);
    }
    return {
      file: disk.file,
      interface: oneOf(disk.interface ?? "virtio", ["virtio", "nvme"] as const, "interface"),
    };
  });
  if (out.length === 0) throw new ConfigError("disks must name at least one image");
  return out;
}

/** The installer ISO: an absolute `.iso` path without commas (a `-drive` separator), or `null`. */
function isoPath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const ok = typeof value === "string" && value.startsWith("/") && /\.iso$/i.test(value) &&
    !/[\0,]/.test(value);
  if (!ok) throw new ConfigError("iso must be an absolute path to a .iso file (no commas)");
  return value as string;
}

/** The NICs, with no host port forwarded twice. */
function nics(value: unknown): NicConfig[] {
  const out = list(value ?? [], "nics", 4).map((n, i) => {
    const nic = record(n, `nics[${i}]`);
    return {
      model: oneOf(nic.model ?? "virtio-net-pci", ["virtio-net-pci", "e1000e"] as const, "model"),
      forwards: list(nic.forwards ?? [], `nics[${i}].forwards`, 16).map((f, j) =>
        forward(f, `nics[${i}].forwards[${j}]`)
      ),
    };
  });
  const ports = out.flatMap((n) => n.forwards.map((f) => `${f.proto}:${f.hostPort}`));
  if (new Set(ports).size !== ports.length) throw new ConfigError("a host port is forwarded twice");
  return out;
}

/**
 * Validate a VM config (from `hangar.json`, or the page's "create VM" form).
 *
 * @throws {ConfigError} naming the first bad field.
 */
export function parseVmConfig(raw: unknown): HangarVmConfig {
  const c = record(raw, "config");
  if (c.version !== undefined && c.version !== 1) throw new ConfigError("version must be 1");
  const name = vmName(c.name);
  const arch = oneOf(c.arch, ["aarch64", "x86_64"] as const, "arch");
  const accel = oneOf(c.accel, ["hvf", "tcg"] as const, "accel");
  if (accel === "hvf" && arch !== "aarch64") {
    throw new ConfigError("accel hvf runs only aarch64 guests on Apple silicon");
  }
  return {
    version: 1,
    name,
    arch,
    accel,
    cpus: int(c.cpus, "cpus", 1, 64),
    memoryMiB: int(c.memoryMiB, "memoryMiB", 256, 1024 * 1024),
    disks: disks(c.disks),
    iso: isoPath(c.iso),
    nics: nics(c.nics),
    display: oneOf(c.display ?? "cocoa", ["none", "cocoa"] as const, "display"),
  };
}

/** A Hangar VM's library entry. */
export function hangarVmDefinition(id: string, dir: string, config: HangarVmConfig): VmDefinition {
  return {
    id,
    name: config.name,
    kind: "hangar",
    dir,
    arch: config.arch,
    accel: config.accel,
    cpus: config.cpus,
    memoryMiB: config.memoryMiB,
    disks: config.disks.map((d) => d.file),
    qmpSocket: join(dir, QMP_SOCKET),
    pidFile: join(dir, PID_FILE),
    headlessCapable: true,
    forwards: config.nics.flatMap((n) => n.forwards),
    sshHint: null,
  };
}

/** Where QEMU's binaries and firmware are, under its install prefix. */
export function qemuPaths(prefix: string, arch: "aarch64" | "x86_64") {
  return {
    system: join(prefix, "bin", `qemu-system-${arch}`),
    img: join(prefix, "bin", "qemu-img"),
    firmwareCode: join(prefix, "share", "qemu", "edk2-aarch64-code.fd"),
    firmwareVars: join(prefix, "share", "qemu", "edk2-arm-vars.fd"),
  };
}

/**
 * The QEMU command line for a Hangar VM, run with the VM's folder as the working directory (that
 * folder is also how Hangar recognizes the process later).
 *
 * @param config The VM's config.
 * @param options `headless`: no display, daemonized, pid in {@link PID_FILE}.
 * @returns The program and its arguments.
 */
export function buildQemuCommand(
  config: HangarVmConfig,
  options: { headless: boolean; qemuPrefix: string },
): { program: string; args: string[] } {
  const paths = qemuPaths(options.qemuPrefix, config.arch);
  const args = ["-name", config.name];
  if (config.arch === "aarch64") {
    args.push("-M", "virt,highmem=on", "-accel", config.accel);
    args.push("-cpu", config.accel === "hvf" ? "host" : "max");
    args.push("-drive", `if=pflash,format=raw,readonly=on,file=${paths.firmwareCode}`);
    args.push("-drive", `if=pflash,format=raw,file=${VARS_FILE}`);
    args.push("-device", "virtio-gpu-pci", "-device", "qemu-xhci");
    args.push("-device", "usb-kbd", "-device", "usb-tablet");
  } else {
    args.push("-M", "q35", "-accel", config.accel === "tcg" ? "tcg,thread=multi" : config.accel);
    args.push("-vga", "std", "-device", "qemu-xhci", "-device", "usb-tablet");
  }
  args.push("-smp", String(config.cpus), "-m", `${config.memoryMiB}M`);
  config.disks.forEach((disk, i) => {
    const format = disk.file.endsWith(".qcow2") ? "qcow2" : "raw";
    if (disk.interface === "nvme") {
      args.push("-drive", `file=${disk.file},if=none,id=hd${i},format=${format},discard=unmap`);
      args.push("-device", `nvme,drive=hd${i},serial=hangar${i}`);
    } else {
      args.push("-drive", `file=${disk.file},if=virtio,format=${format},discard=unmap`);
    }
  });
  if (config.iso) {
    args.push("-drive", `file=${config.iso},media=cdrom,readonly=on`, "-boot", "once=d");
  }
  if (config.nics.length === 0) args.push("-nic", "none");
  for (const nic of config.nics) {
    const fwd = nic.forwards.map((f) =>
      `,hostfwd=${f.proto}:${f.hostAddress}:${f.hostPort}-:${f.guestPort}`
    ).join("");
    args.push("-nic", `user,model=${nic.model}${fwd}`);
  }
  args.push("-device", "virtio-rng-pci");
  args.push("-qmp", `unix:${QMP_SOCKET},server=on,wait=off`);
  if (options.headless || config.display === "none") {
    args.push("-display", "none", "-daemonize", "-pidfile", PID_FILE);
  } else {
    args.push("-display", config.display);
  }
  return { program: paths.system, args };
}
