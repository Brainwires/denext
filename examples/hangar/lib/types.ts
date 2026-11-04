// The shapes Hangar's backend hands the page. Plain data (JSON over the desktop bridge); the page
// imports these as types only.

/** A host port forwarded into the guest (`-nic user,hostfwd=…`). */
export interface PortForward {
  readonly proto: "tcp" | "udp";
  /** The host address (`127.0.0.1`, or `""` for every address). */
  readonly hostAddress: string;
  readonly hostPort: number;
  readonly guestPort: number;
}

/** One VM in the library: a `start.sh` folder Hangar adopted, or one Hangar created. */
export interface VmDefinition {
  /** The folder name: the VM's id. */
  readonly id: string;
  /** The display name (QEMU's `-name`, or the config's name). */
  readonly name: string;
  /** `script`: started by its own `start.sh`; `hangar`: built from `hangar.json`. */
  readonly kind: "script" | "hangar";
  /** The folder (absolute). */
  readonly dir: string;
  /** The guest architecture, from the QEMU binary (`aarch64`, `x86_64`), or `null`. */
  readonly arch: string | null;
  /** The accelerator (`hvf`, `tcg`, `kvm`), or `null`. */
  readonly accel: string | null;
  readonly cpus: number | null;
  readonly memoryMiB: number | null;
  /** Disk image files, relative to the folder. */
  readonly disks: readonly string[];
  /** The QMP socket (absolute), or `null` when the VM has none. */
  readonly qmpSocket: string | null;
  /** The pidfile a headless start writes (absolute), or `null`. */
  readonly pidFile: string | null;
  /** The VM can start headless (`LAB_HEADLESS=1` in `start.sh`, or any Hangar VM). */
  readonly headlessCapable: boolean;
  readonly forwards: readonly PortForward[];
  /** An `ssh …` command the script's comments give, or `null`. */
  readonly sshHint: string | null;
}

/** A running QEMU process matched to a library VM. */
export interface Instance {
  readonly vmId: string;
  readonly pid: number;
  readonly rssBytes: number;
  readonly cpuPercent: number;
  /** How the process was matched: its working directory, or the VM's pidfile. */
  readonly matchedBy: "cwd" | "pidfile";
}

/** The RAM budget: what the running VMs use against the share of host memory allowed. */
export interface RamBudget {
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly totalBytes: number;
  /** `ok`, `warn` (over 85% of the budget) or `over`. */
  readonly level: "ok" | "warn" | "over";
}

/** One VM with its live state. */
export interface VmOverview {
  readonly vm: VmDefinition;
  readonly instance: Instance | null;
  /** More than one QEMU process claims this VM: Hangar refuses to stop either by pid. */
  readonly ambiguous: boolean;
}

/** Everything the panel shows. */
export interface Overview {
  readonly vms: readonly VmOverview[];
  readonly budget: RamBudget;
  /** The tray tooltip. */
  readonly tooltip: string;
  /** The library folder (shown in settings). */
  readonly libraryRoot: string;
}

/** A snapshot inside a qcow2 image (`qemu-img info`'s `snapshots`). */
export interface ImageSnapshot {
  readonly id: string;
  readonly name: string;
  /** Seconds since the epoch. */
  readonly date: number;
  readonly vmStateBytes: number;
}

/** `qemu-img info` of one image. */
export interface ImageInfo {
  readonly file: string;
  readonly format: string;
  readonly virtualBytes: number;
  readonly actualBytes: number;
  readonly backingFile: string | null;
  readonly snapshots: readonly ImageSnapshot[];
}

/** One image file in a VM's folder. */
export interface ImageEntry {
  readonly vmId: string;
  readonly file: string;
  readonly bytes: number;
  /** `disk` (qcow2, raw, …) or `iso`. */
  readonly kind: "disk" | "iso";
}

/** Hangar's settings (kept in the app's data folder). */
export interface HangarSettings {
  /** The library folder (default `~/VMs`). */
  readonly libraryRoot: string;
  /** Where QEMU is installed (`/opt/homebrew` → `/opt/homebrew/bin/qemu-img`). */
  readonly qemuPrefix: string;
  /** The share of host memory running VMs may use, 10–100. */
  readonly ramBudgetPercent: number;
  /** How long a graceful shutdown waits before QMP `quit`, in seconds. */
  readonly shutdownTimeoutSeconds: number;
}
