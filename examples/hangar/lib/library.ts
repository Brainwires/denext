// The VM library: one folder per VM under the library root (`~/VMs` by default), each with a
// `start.sh` (adopted as is) or a `hangar.json` (created by Hangar). Hangar reads only those two
// files of a VM folder, and only names and sizes of the rest: never a credentials file or any
// other content. Every path an action takes is resolved here and must stay inside its VM's
// folder, symlinks included.

import { join } from "@std/path";
import type { Host } from "./host.ts";
import { parseStartScript } from "./start-script.ts";
import type { ImageEntry, VmDefinition } from "./types.ts";
import { CONFIG_FILE, hangarVmDefinition, IMAGE_FILE, parseVmConfig } from "./vm-config.ts";

/** The adopted VM's launcher. */
export const START_SCRIPT = "start.sh";
/** The only files of a VM folder Hangar ever reads. */
const READABLE = new Set([START_SCRIPT, CONFIG_FILE]);
/** A folder name Hangar lists (an adopted folder may have capitals and spaces). */
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
/** An installer image in a VM folder. */
const ISO_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,126}\.iso$/i;

/** A refused action: the message is safe to show (no absolute paths). */
export class HangarError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HangarError";
    this.code = code;
  }
}

/**
 * Read one of the two files Hangar reads in a VM folder.
 *
 * @throws {HangarError} for any other file name.
 */
export async function readVmFile(host: Host, dir: string, name: string): Promise<string> {
  if (!READABLE.has(name)) throw new HangarError("forbidden", `Hangar does not read ${name}`);
  return await host.readTextFile(join(dir, name));
}

/** Load one VM folder, or `null` when it is not a VM (no `start.sh` or `hangar.json`). */
async function loadVm(host: Host, root: string, id: string): Promise<VmDefinition | null> {
  const dir = join(root, id);
  if (await host.exists(join(dir, CONFIG_FILE))) {
    try {
      const config = parseVmConfig(JSON.parse(await readVmFile(host, dir, CONFIG_FILE)));
      return hangarVmDefinition(id, dir, config);
    } catch {
      return null; // a broken config is listed nowhere rather than half-started
    }
  }
  if (await host.exists(join(dir, START_SCRIPT))) {
    return parseStartScript(id, dir, await readVmFile(host, dir, START_SCRIPT));
  }
  return null;
}

/** Every VM in the library root, by id. */
export async function scanLibrary(host: Host, root: string): Promise<VmDefinition[]> {
  if (!(await host.exists(root))) return [];
  const vms: VmDefinition[] = [];
  const entries = (await host.readDir(root)).filter((e) => e.isDirectory && FOLDER.test(e.name));
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const vm = await loadVm(host, root, e.name);
    if (vm) vms.push(vm);
  }
  return vms;
}

/** The library VM `id`, or a `not_found` error (an id outside the library is never acted on). */
export function findVm(vms: readonly VmDefinition[], id: unknown): VmDefinition {
  const vm = typeof id === "string" ? vms.find((v) => v.id === id) : undefined;
  if (!vm) throw new HangarError("not_found", "No such VM in the library");
  return vm;
}

/** Whether `path` is `dir` or inside it. */
function inside(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/**
 * The absolute path of an image file in a VM's folder, checked: a plain image name, and (when it
 * exists) a real path inside the folder, so a symlink cannot point an action elsewhere.
 *
 * @param mustExist `false` for a file an action is about to create (it must NOT exist).
 */
export async function imagePath(
  host: Host,
  vm: VmDefinition,
  file: unknown,
  options: { mustExist: boolean; allowIso?: boolean },
): Promise<string> {
  const ok = typeof file === "string" &&
    (IMAGE_FILE.test(file) || (options.allowIso === true && ISO_FILE.test(file)));
  if (!ok) throw new HangarError("validation", "Not an image file name");
  const path = join(vm.dir, file);
  const real = await host.realPath(path);
  if (!options.mustExist) {
    if (real !== null || await host.exists(path)) {
      throw new HangarError("exists", `${file} already exists`);
    }
    return path;
  }
  const dir = await host.realPath(vm.dir);
  if (real === null || dir === null) throw new HangarError("not_found", `${file} does not exist`);
  if (!inside(dir, real)) throw new HangarError("forbidden", `${file} points outside the VM`);
  return real;
}

/** The image files in a VM's folder (names and sizes only). */
export async function listImages(host: Host, vm: VmDefinition): Promise<ImageEntry[]> {
  const out: ImageEntry[] = [];
  for (const e of await host.readDir(vm.dir)) {
    if (!e.isFile) continue;
    const kind = IMAGE_FILE.test(e.name) ? "disk" : ISO_FILE.test(e.name) ? "iso" : null;
    if (!kind) continue;
    out.push({
      vmId: vm.id,
      file: e.name,
      bytes: (await host.fileSize(join(vm.dir, e.name))) ?? 0,
      kind,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
