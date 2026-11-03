// `qemu-img` command lines and the parsing of what it prints. The paths given here are already
// checked to be inside a library VM's folder (see `library.ts`).

import type { ImageInfo, ImageSnapshot } from "./types.ts";

/** A snapshot name: what `qemu-img snapshot` accepts without quoting surprises. */
export const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The formats Hangar creates and converts to. */
export const IMAGE_FORMATS = ["qcow2", "raw"] as const;
/** An image format Hangar creates. */
export type ImageFormat = typeof IMAGE_FORMATS[number];

/** `qemu-img info` (`--force-share`: a running VM's image is locked for writing, not reading). */
export function infoArgs(path: string): string[] {
  return ["info", "--force-share", "--output=json", path];
}

/** `qemu-img create`. */
export function createArgs(path: string, format: ImageFormat, size: string): string[] {
  return ["create", "-f", format, path, size];
}

/** `qemu-img resize` (grow only: shrinking a disk under a guest's filesystem loses data). */
export function resizeArgs(path: string, format: string, size: string): string[] {
  return ["resize", "-f", format, path, size];
}

/** `qemu-img convert` to a new file. */
export function convertArgs(from: string, to: string, format: ImageFormat): string[] {
  return ["convert", "-O", format, from, to];
}

/** `qemu-img snapshot` create (`-c`), apply (`-a`) or delete (`-d`). */
export function snapshotArgs(
  action: "create" | "apply" | "delete",
  path: string,
  name: string,
): string[] {
  const flag = action === "create" ? "-c" : action === "apply" ? "-a" : "-d";
  return ["snapshot", flag, name, path];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse `qemu-img info --output=json`.
 *
 * @param file The image's name (the page never sees absolute paths).
 * @param json What `qemu-img` printed.
 */
export function parseImageInfo(file: string, json: string): ImageInfo {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const snapshots: ImageSnapshot[] = Array.isArray(raw.snapshots)
    ? raw.snapshots.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? ""),
      name: String(s.name ?? ""),
      date: num(s["date-sec"]),
      vmStateBytes: num(s["vm-state-size"]),
    }))
    : [];
  const backing = raw["backing-filename"];
  return {
    file,
    format: String(raw.format ?? "unknown"),
    virtualBytes: num(raw["virtual-size"]),
    actualBytes: num(raw["actual-size"]),
    // Only the backing file's name: the page shows it, it never needs the folder.
    backingFile: typeof backing === "string" ? backing.split("/").pop() ?? null : null,
    snapshots,
  };
}

/** A size argument in bytes (`20G` → 21474836480). */
export function sizeBytes(size: string): number {
  const m = /^(\d+)([KMGT])$/.exec(size);
  if (!m) return NaN;
  return Number(m[1]) * 1024 ** ("KMGT".indexOf(m[2]) + 1);
}
