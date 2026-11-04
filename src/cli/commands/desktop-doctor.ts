// `denext desktop doctor [dir] [--linux] [--json]`: the pinned Deno Desktop runtime and, on Linux
// (or with `--linux`), what the session provides, with a fix for each missing piece
// (../../build/desktop-doctor.ts). Exits 1 when a finding is an error.

import type { CommandContext } from "../command.ts";
import {
  type DesktopDoctorOptions,
  type DesktopDoctorReport,
  formatDesktopDoctor,
  runDesktopDoctor,
} from "../../build/desktop-doctor.ts";
import { desktopRuntimeStatus, projectDesktopBackend } from "../../build/desktop-runtime.ts";
import { linuxWebRtcProblem } from "../../build/desktop-media-capture.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { desktopBridgeOrigins } from "../../build/desktop-app-config.ts";
import {
  isDesktopProject,
  type LaunchPolicyProblem,
  launchPolicyProblems,
  staleBackendPackageScripts,
  stalePackageScripts,
} from "../../build/desktop-launch-policy.ts";
import { readStaticConfig } from "../../build/config-static.ts";

/**
 * The project's packaged launch-policy gaps (see `launchPolicyProblems`), from what its config
 * says as data: this is an inspecting verb, so the config isn't run. A `desktop` key that code
 * computes, or a config whose shape can't be read, is one gap too.
 */
export async function projectLaunchPolicy(dir: string): Promise<LaunchPolicyProblem[] | null> {
  if (!await isDesktopProject(dir)) return null;
  const config = await readStaticConfig(dir);
  const desktop = config.keys.desktop;
  if (!config.readable || (desktop && desktop.kind !== "editable")) {
    return [{
      message: `${config.file} could not be loaded as data, so the launch policy is unknown: ` +
        "`desktop doctor` doesn't run the project's code",
      fix: "write `desktop` in the config as a plain object, or check the built app's " +
        "laufey-launch.json",
    }];
  }
  return launchPolicyProblems(
    desktop ? { desktop: desktop.value } : null,
    desktopBridgeOrigins,
    await stalePackageScripts(dir),
    await staleBackendPackageScripts(dir),
  );
}

/**
 * Why the project's Linux build has no WebRTC (`linuxWebRtcProblem`), from its config as data and
 * the project's Linux engine (`desktop.backend` for Linux: the config's, else deno.json's). `null` when it does not apply, or when the config or the backend
 * can't be read (the launch-policy check reports an unreadable config).
 */
export async function projectLinuxWebRtc(dir: string): Promise<string | null> {
  if (!await isDesktopProject(dir)) return null;
  const config = await readStaticConfig(dir);
  const desktop = config.keys.desktop;
  if (!config.readable || !desktop || desktop.kind !== "editable") return null;
  const backend = await projectDesktopBackend(dir, { target: "linux" }).catch(() => null);
  return linuxWebRtcProblem({ desktop: desktop.value }, backend);
}

/**
 * `denext desktop doctor`.
 *
 * @param ctx The command context (`--linux`, `--json`).
 * @param dir The project directory (its `desktop.backend` for the host picks the runtime build).
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
    deno: denoExecutable(),
    launchPolicy: () => projectLaunchPolicy(dir),
    linuxWebRtc: () => projectLinuxWebRtc(dir),
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
