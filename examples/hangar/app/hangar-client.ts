// The page's typed handle on the `hangar` desktop extension (desktop/hangar.ts). Outside a Deno
// Desktop window (`denext task dev` in a browser) every call rejects with code `unavailable`, and
// the pages say so instead of showing an empty library.

import { desktopExtension } from "denext/desktop/client";
import type { ShutdownResult, StartResult } from "../lib/hangar.ts";
import type { ImageFormat } from "../lib/images.ts";
import type { HangarVmConfig } from "../lib/vm-config.ts";
import type {
  HangarSettings,
  ImageEntry,
  ImageInfo,
  Overview,
  VmDefinition,
} from "../lib/types.ts";

/** What the page can ask the backend. */
interface HangarClient {
  overview(args?: Record<never, never>): Promise<Overview>;
  status(args: { id: string }): Promise<string>;
  start(args: { id: string; headless: boolean; allowOverBudget?: boolean }): Promise<StartResult>;
  shutdown(args: { id: string }): Promise<ShutdownResult>;
  forceStop(args: { id: string; pid: number; confirm: string }): Promise<void>;
  images(args: { id?: string }): Promise<ImageEntry[]>;
  imageInfo(args: { id: string; file: string }): Promise<ImageInfo>;
  createImage(args: { id: string; file: string; size: string; format: ImageFormat }): Promise<void>;
  resizeImage(args: { id: string; file: string; size: string }): Promise<void>;
  convertImage(
    args: { id: string; file: string; target: string; format: ImageFormat },
  ): Promise<void>;
  snapshot(args: {
    id: string;
    file: string;
    action: "create" | "apply" | "delete";
    name: string;
    confirm?: string;
  }): Promise<void>;
  deleteImage(args: { id: string; file: string; confirm: string }): Promise<void>;
  createVm(args: { id: string; config: HangarVmConfig; diskSize: string }): Promise<VmDefinition>;
  openTerminal(args: { id: string }): Promise<void>;
  open(args: { path: string }): Promise<null>;
  getSettings(args?: Record<never, never>): Promise<HangarSettings>;
  setSettings(args: Partial<HangarSettings>): Promise<HangarSettings>;
}

/** The backend. */
export const hangar = desktopExtension("hangar") as unknown as HangarClient;

/** A bridge error's message, for the page. */
export function errorText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "unavailable") return "Hangar's backend runs only in the desktop app.";
  return typeof e?.message === "string" ? e.message : String(err);
}
