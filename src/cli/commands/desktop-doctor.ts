// `denext desktop doctor [dir] [--linux] [--json]`: the pinned Deno Desktop runtime and, on Linux
// (or with `--linux`), what the session provides, with a fix for each missing piece
// (../../build/desktop-doctor.ts). Exits 1 when a finding is an error.

import type { CommandContext, FlagSpec } from "../command.ts";
import {
  type DesktopDoctorOptions,
  type DesktopDoctorReport,
  formatDesktopDoctor,
  runDesktopDoctor,
} from "../../build/desktop-doctor.ts";
import { desktopRuntimeStatus } from "../../build/desktop-runtime.ts";
import { denoExecutable } from "../../build/bundle.ts";

/** The flags only `desktop doctor` reads. */
export const DESKTOP_DOCTOR_FLAGS: readonly FlagSpec[] = [
  {
    name: "linux",
    type: "boolean",
    help: "doctor: run the Linux session checks (tray host, Secret Service, portals, …); the " +
      "default on a Linux host",
  },
];

/**
 * `denext desktop doctor`.
 *
 * @param ctx The command context (`--linux`, `--json`).
 * @param dir The project directory (its deno.json `desktop.backend` picks the runtime build).
 * @param seams Test seams for {@linkcode runDesktopDoctor}.
 * @returns The report (after printing it); the process exits 1 when it has an error.
 */
export async function desktopDoctor(
  ctx: CommandContext,
  dir: string,
  seams: Partial<DesktopDoctorOptions> = {},
): Promise<DesktopDoctorReport> {
  const os = seams.os ?? Deno.build.os;
  const linux = ctx.flags.linux === true ? true : undefined;
  if (linux && os !== "linux") {
    console.error(
      "denext desktop doctor: --linux reads the session it runs in; run it on the Linux desktop.",
    );
    Deno.exit(1);
  }
  const report = await runDesktopDoctor({
    runtimeStatus: () => desktopRuntimeStatus({ projectDir: dir, deno: denoExecutable() }),
    ...seams,
    os,
    ...(linux ? { linux } : {}),
  });
  if (ctx.global.json) console.log(JSON.stringify(report));
  else {
    console.log(`\n  denext desktop doctor  ▸  ${dir}\n`);
    console.log(formatDesktopDoctor(report));
  }
  if (report.findings.some((f) => f.level === "error")) Deno.exit(1);
  return report;
}
