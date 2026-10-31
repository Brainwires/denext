// Hangar's backend: the VM library, the running instances, and the image actions, over a `Host`.
// The desktop extension (`desktop/hangar.ts`) is a thin shell over this; the tests drive it with a
// fake host. Every action names a library VM by id and is refused for anything else, and every
// destructive one takes a `confirm` that must repeat the target's name (the page's confirm step).

import { join } from "@std/path";
import { overBudgetBy, ramBudget, sshCommand, trayTooltip } from "./format.ts";
import type { Host } from "./host.ts";
import {
  convertArgs,
  createArgs,
  IMAGE_FORMATS,
  type ImageFormat,
  infoArgs,
  parseImageInfo,
  resizeArgs,
  sizeBytes,
  SNAPSHOT_NAME,
  snapshotArgs,
} from "./images.ts";
import {
  findVm,
  HangarError,
  imagePath,
  listImages,
  scanLibrary,
  START_SCRIPT,
} from "./library.ts";
import { isQemuSystem, matchInstances } from "./processes.ts";
import type { HangarSettings, ImageEntry, ImageInfo, Overview, VmDefinition } from "./types.ts";
import {
  buildQemuCommand,
  CONFIG_FILE,
  ConfigError,
  parseVmConfig,
  qemuPaths,
  VARS_FILE,
  VM_ID,
} from "./vm-config.ts";

export { HangarError } from "./library.ts";

/** The log a started VM's output goes to, in its folder. */
const LOG_FILE = "hangar-qemu.log";
/** How long a QMP command may take. */
const QMP_TIMEOUT_MS = 3000;
/** How often a shutdown checks whether the VM is gone. */
const POLL_MS = 500;
/** How long a force stop waits after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;

/** The defaults for a home folder. */
export function defaultSettings(home: string, os: string): HangarSettings {
  return {
    libraryRoot: join(home, "VMs"),
    qemuPrefix: os === "darwin" ? "/opt/homebrew" : "/usr",
    ramBudgetPercent: 75,
    shutdownTimeoutSeconds: 60,
  };
}

/** Validate settings from the page or the settings file, filling gaps from `base`. */
export function parseSettings(raw: unknown, base: HangarSettings): HangarSettings {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const path = (v: unknown, fallback: string, field: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !v.startsWith("/") || v.includes("\0") || v.includes("..")) {
      throw new HangarError("validation", `${field} must be an absolute folder`);
    }
    return v.replace(/\/+$/, "") || "/";
  };
  const int = (v: unknown, fallback: number, min: number, max: number, field: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new HangarError("validation", `${field} must be from ${min} to ${max}`);
    }
    return v;
  };
  return {
    libraryRoot: path(s.libraryRoot, base.libraryRoot, "Library folder"),
    qemuPrefix: path(s.qemuPrefix, base.qemuPrefix, "QEMU prefix"),
    ramBudgetPercent: int(s.ramBudgetPercent, base.ramBudgetPercent, 10, 100, "RAM budget"),
    shutdownTimeoutSeconds: int(
      s.shutdownTimeoutSeconds,
      base.shutdownTimeoutSeconds,
      5,
      600,
      "Shutdown timeout",
    ),
  };
}

/** Run a config parse, turning its `ConfigError` into a `validation` refusal. */
function asHangarError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) throw new HangarError("validation", err.message);
    throw err;
  }
}

/** What `start` did. */
export type StartResult =
  | { readonly started: true }
  | { readonly started: false; readonly needsConfirm: "budget"; readonly overByBytes: number };

/** How a graceful shutdown ended. */
export type ShutdownResult = "powered-off" | "quit" | "not-running";

/** Hangar's backend. */
export interface Hangar {
  settings(): HangarSettings;
  setSettings(next: HangarSettings): void;
  overview(): Promise<Overview>;
  start(id: string, options: { headless: boolean; allowOverBudget: boolean }): Promise<StartResult>;
  shutdown(id: string): Promise<ShutdownResult>;
  forceStop(id: string, pid: number, confirm: string): Promise<void>;
  status(id: string): Promise<string>;
  images(id?: string): Promise<ImageEntry[]>;
  imageInfo(id: string, file: string): Promise<ImageInfo>;
  createImage(id: string, file: string, size: string, format: ImageFormat): Promise<void>;
  resizeImage(id: string, file: string, size: string): Promise<void>;
  convertImage(id: string, file: string, target: string, format: ImageFormat): Promise<void>;
  snapshot(
    id: string,
    file: string,
    action: "create" | "apply" | "delete",
    name: string,
    confirm?: string,
  ): Promise<void>;
  deleteImage(id: string, file: string, confirm: string): Promise<void>;
  createVm(id: string, config: unknown, diskSize: string): Promise<VmDefinition>;
  openTerminal(id: string): Promise<void>;
}

/**
 * Hangar over a host.
 *
 * @param host The machine (real or fake).
 * @param initial The settings to start with.
 */
export function createHangar(host: Host, initial: HangarSettings): Hangar {
  let settings = initial;

  const library = () => scanLibrary(host, settings.libraryRoot);
  const qemuImg = () => join(settings.qemuPrefix, "bin", "qemu-img");

  /** The VM and its current match. */
  const lookup = async (id: string) => {
    const vms = await library();
    const vm = findVm(vms, id);
    const match = (await matchInstances(host, [vm])).get(vm.id)!;
    return { vm, match, vms };
  };

  /** Refuse a disk action while the VM runs (its images are open). */
  const stopped = async (id: string) => {
    const { vm, match } = await lookup(id);
    if (match.instance || match.ambiguous) {
      throw new HangarError("running", `${vm.name} is running; shut it down first`);
    }
    return vm;
  };

  /** Run qemu-img, turning a failure into a message without the VM's folder path. */
  const img = async (vm: VmDefinition, args: string[]) => {
    const out = await host.run(qemuImg(), args);
    if (out.code !== 0) {
      const detail = (out.stderr.trim().split("\n")[0] ?? "").replaceAll(vm.dir, vm.id);
      throw new HangarError("qemu_img", `qemu-img ${args[0]} failed: ${detail}`);
    }
    return out.stdout;
  };

  const isAlive = async (pid: number) =>
    (await host.processes()).some((p) => p.pid === pid && isQemuSystem(p));

  const waitGone = async (pid: number, ms: number) => {
    for (let waited = 0; waited < ms; waited += POLL_MS) {
      if (!(await isAlive(pid))) return true;
      await host.sleep(POLL_MS);
    }
    return !(await isAlive(pid));
  };

  const qmpCall = async (vm: VmDefinition, command: string) => {
    if (!vm.qmpSocket) throw new HangarError("no_qmp", `${vm.name} has no QMP socket`);
    const session = await host.qmp(vm.qmpSocket, QMP_TIMEOUT_MS);
    try {
      return await session.execute(command);
    } finally {
      session.close();
    }
  };

  const confirmed = (confirm: unknown, expected: string) => {
    if (confirm !== expected) {
      throw new HangarError("confirm", `Type "${expected}" to confirm`);
    }
  };

  const format = (value: unknown): ImageFormat => {
    if (!IMAGE_FORMATS.includes(value as ImageFormat)) {
      throw new HangarError("validation", `Format must be one of ${IMAGE_FORMATS.join(", ")}`);
    }
    return value as ImageFormat;
  };

  const size = (value: unknown): string => {
    if (typeof value !== "string" || !/^\d{1,7}[KMGT]$/.test(value)) {
      throw new HangarError("validation", "Size must look like 20G or 512M");
    }
    return value;
  };

  /** Check a new VM before anything is written: its id, config, folder, ISO and ports. */
  const planVm = async (id: unknown, raw: unknown, diskSize: unknown) => {
    if (typeof id !== "string" || !VM_ID.test(id)) {
      throw new HangarError("validation", "The id is lower-case letters, digits, . _ -");
    }
    const config = asHangarError(() => parseVmConfig(raw));
    const diskArg = size(diskSize);
    const dir = join(settings.libraryRoot, id);
    if (await host.exists(dir)) throw new HangarError("exists", `${id} already exists`);
    if (config.iso && !(await host.exists(config.iso))) {
      throw new HangarError("not_found", "The ISO does not exist");
    }
    const others = (await library()).flatMap((v) => v.forwards.map((f) => f.hostPort));
    const clash = config.nics.flatMap((n) => n.forwards).find((f) => others.includes(f.hostPort));
    if (clash) throw new HangarError("validation", `Host port ${clash.hostPort} is taken`);
    return { config, dir, diskArg };
  };

  const overview = async (): Promise<Overview> => {
    const vms = await library();
    const matches = await matchInstances(host, vms);
    const rows = vms.map((vm) => ({
      vm,
      instance: matches.get(vm.id)?.instance ?? null,
      ambiguous: matches.get(vm.id)?.ambiguous ?? false,
    }));
    const running = rows.flatMap((r) => r.instance ? [r.instance] : []);
    const used = running.reduce((n, i) => n + i.rssBytes, 0);
    const budget = ramBudget(used, host.totalMemoryBytes(), settings.ramBudgetPercent);
    return {
      vms: rows,
      budget,
      tooltip: trayTooltip(running, budget),
      libraryRoot: settings.libraryRoot,
    };
  };

  return {
    settings: () => settings,
    setSettings(next) {
      settings = next;
    },

    overview,

    async start(id, options) {
      const { vm, match } = await lookup(id);
      if (match.instance || match.ambiguous) {
        throw new HangarError("running", `${vm.name} is already running`);
      }
      if (options.headless && !vm.headlessCapable) {
        throw new HangarError("validation", `${vm.name}'s start.sh has no headless mode`);
      }
      const current = await overview();
      const overBy = overBudgetBy(current.budget, vm.memoryMiB);
      if (overBy > 0 && !options.allowOverBudget) {
        return { started: false, needsConfirm: "budget", overByBytes: overBy };
      }
      const logFile = join(vm.dir, LOG_FILE);
      if (vm.kind === "script") {
        await host.spawnDetached("/bin/bash", [START_SCRIPT], {
          cwd: vm.dir,
          env: options.headless ? { LAB_HEADLESS: "1" } : {},
          logFile,
        });
      } else {
        const config = parseVmConfig(
          JSON.parse(await host.readTextFile(join(vm.dir, CONFIG_FILE))),
        );
        const cmd = buildQemuCommand(config, {
          headless: options.headless,
          qemuPrefix: settings.qemuPrefix,
        });
        await host.spawnDetached(cmd.program, cmd.args, { cwd: vm.dir, logFile });
      }
      return { started: true };
    },

    async shutdown(id) {
      const { vm, match } = await lookup(id);
      if (match.ambiguous) throw new HangarError("ambiguous", "More than one process claims it");
      const pid = match.instance?.pid;
      if (pid === undefined) return "not-running";
      await qmpCall(vm, "system_powerdown");
      if (await waitGone(pid, settings.shutdownTimeoutSeconds * 1000)) return "powered-off";
      // The guest ignored the ACPI button (or is still shutting down): QMP `quit` ends QEMU.
      await qmpCall(vm, "quit").catch(() => {});
      await waitGone(pid, KILL_GRACE_MS);
      return "quit";
    },

    async forceStop(id, pid, confirm) {
      const { vm, match } = await lookup(id);
      confirmed(confirm, vm.id);
      if (match.ambiguous) throw new HangarError("ambiguous", "More than one process claims it");
      // Exactly the pid the page showed, still matched to this VM right now (not a reused pid).
      if (!match.instance || match.instance.pid !== pid) {
        throw new HangarError("stale", `${vm.name} is not running as process ${pid}`);
      }
      host.kill(pid, "SIGTERM");
      if (!(await waitGone(pid, KILL_GRACE_MS))) host.kill(pid, "SIGKILL");
    },

    async status(id) {
      const { vm, match } = await lookup(id);
      if (!match.instance) return "stopped";
      try {
        const out = await qmpCall(vm, "query-status") as { status?: unknown };
        return typeof out?.status === "string" ? out.status : "unknown";
      } catch {
        return "unknown"; // no socket, or another client holds it
      }
    },

    async images(id) {
      const vms = await library();
      const pick = id === undefined ? vms : [findVm(vms, id)];
      return (await Promise.all(pick.map((vm) => listImages(host, vm)))).flat();
    },

    async imageInfo(id, file) {
      const vm = findVm(await library(), id);
      const path = await imagePath(host, vm, file, { mustExist: true, allowIso: true });
      return parseImageInfo(file, await img(vm, infoArgs(path)));
    },

    async createImage(id, file, sizeArg, fmt) {
      const vm = findVm(await library(), id);
      const path = await imagePath(host, vm, file, { mustExist: false });
      await img(vm, createArgs(path, format(fmt), size(sizeArg)));
    },

    async resizeImage(id, file, sizeArg) {
      const vm = await stopped(id);
      const path = await imagePath(host, vm, file, { mustExist: true });
      const info = parseImageInfo(file, await img(vm, infoArgs(path)));
      if (sizeBytes(size(sizeArg)) <= info.virtualBytes) {
        throw new HangarError("validation", "Hangar only grows disks; the new size must be larger");
      }
      await img(vm, resizeArgs(path, info.format, sizeArg));
    },

    async convertImage(id, file, target, fmt) {
      const vm = await stopped(id);
      const from = await imagePath(host, vm, file, { mustExist: true });
      const to = await imagePath(host, vm, target, { mustExist: false });
      await img(vm, convertArgs(from, to, format(fmt)));
    },

    async snapshot(id, file, action, name, confirm) {
      if (typeof name !== "string" || !SNAPSHOT_NAME.test(name)) {
        throw new HangarError("validation", "Snapshot names are letters, digits, . _ -");
      }
      if (action !== "create") confirmed(confirm, name);
      // Internal snapshots of a running VM's image would race QEMU's own writes.
      const vm = await stopped(id);
      const path = await imagePath(host, vm, file, { mustExist: true });
      await img(vm, snapshotArgs(action, path, name));
    },

    async deleteImage(id, file, confirm) {
      confirmed(confirm, file);
      const vm = await stopped(id);
      const path = await imagePath(host, vm, file, { mustExist: true, allowIso: true });
      await host.removeFile(path);
    },

    async createVm(id, raw, diskSize) {
      const { config, dir, diskArg } = await planVm(id, raw, diskSize);
      await host.mkdir(dir);
      const vm = { id, dir, name: config.name } as VmDefinition;
      for (const disk of config.disks) {
        await img(
          vm,
          createArgs(
            join(dir, disk.file),
            disk.file.endsWith(".qcow2") ? "qcow2" : "raw",
            diskArg,
          ),
        );
      }
      if (config.arch === "aarch64") {
        await host.copyFile(
          qemuPaths(settings.qemuPrefix, "aarch64").firmwareVars,
          join(dir, VARS_FILE),
        );
      }
      await host.writeTextFile(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
      return findVm(await library(), id);
    },

    async openTerminal(id) {
      const vm = findVm(await library(), id);
      const cmd = sshCommand(vm);
      if (!cmd) throw new HangarError("validation", `${vm.name} forwards no ssh port`);
      if (host.os !== "darwin") throw new HangarError("unsupported", "Copy the command instead");
      // `cmd` is `ssh [-p N] [user@]host` from a fixed pattern: no quotes or shell syntax in it.
      await host.run("/usr/bin/osascript", [
        "-e",
        `tell application "Terminal" to do script "${cmd}"`,
        "-e",
        'tell application "Terminal" to activate',
      ]);
    },
  };
}
