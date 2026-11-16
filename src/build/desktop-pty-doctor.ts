// The `pty` check of `denext desktop doctor`: what the `pty` desktop capability bakes and needs,
// read from the project's `desktop` config as data (the doctor never runs the project's code).
//
//   - the `--allow-run` the package bakes for it (its shells for this OS, never an unscoped run);
//   - whether the pinned Deno Desktop runtime has `Deno.openPty` (FIRST_PTY_RUNTIME), and on
//     Windows whether its `Deno.openPty` starts a ConPTY (FIRST_WINDOWS_PTY_RUNTIME);
//   - `onWindowClose: "detach"` in an app that quits with its last window (no
//     `desktop.app.keepAlive`, no tray), where a detached terminal has no window left to attach it;
//   - a shells list with nothing for this OS, and an invalid `pty` value.

import {
  FIRST_PTY_RUNTIME,
  FIRST_WINDOWS_PTY_RUNTIME,
  supportsPty,
  supportsPtyOn,
} from "./deno-version.ts";
import { ptyConfigProblem, type PtyOs, resolvePtyConfig } from "../desktop/pty-config.ts";

/** One finding (the doctor's `DesktopDoctorFinding` shape). */
export interface PtyDoctorFinding {
  readonly check: "pty";
  readonly level: "error" | "warning";
  readonly message: string;
  readonly fix: string;
}

/** What the doctor lists about the `pty` capability. */
export interface DoctorPty {
  /** The `--allow-run` paths the package bakes for it on this OS. */
  readonly runAllow: readonly string[];
  /** What closing a terminal's window does. */
  readonly onWindowClose: "kill" | "detach";
  /** Whether the pinned runtime starts terminals on the checked OS (`Deno.openPty`). */
  readonly runtimeSupported: boolean;
  /** The first runtime that starts terminals on the checked OS. */
  readonly runtimeFloor: string;
}

/** Whether the app keeps running with no window: `desktop.app.keepAlive`, else on with a tray. */
function keepsAlive(desktop: Record<string, unknown>): boolean {
  const keepAlive = (desktop.app as { keepAlive?: unknown } | undefined)?.keepAlive;
  return keepAlive === true || (keepAlive === undefined && desktop.tray !== undefined);
}

/**
 * The `pty` check, or `null` when the capability is not enabled.
 *
 * @param desktop The project's `desktop` config (as data).
 * @param os The OS the app is checked for.
 * @param runtimeVersion The pinned Deno Desktop runtime's version.
 * @returns The facts and the findings, or `null`.
 */
export function ptyDoctorCheck(
  desktop: unknown,
  os: PtyOs,
  runtimeVersion: string,
): { pty: DoctorPty | null; findings: PtyDoctorFinding[] } | null {
  const d = (typeof desktop === "object" && desktop !== null ? desktop : {}) as Record<
    string,
    unknown
  >;
  const value = (d.capabilities as { pty?: unknown } | undefined)?.pty;
  if (value === undefined || value === null || value === false) return null;
  const findings: PtyDoctorFinding[] = [];
  const problem = ptyConfigProblem(value);
  if (problem) {
    findings.push({
      check: "pty",
      level: "error",
      message: `${problem[0]} ${problem[1]}`,
      fix: "correct desktop.capabilities.pty in denext.config.ts",
    });
    return { pty: null, findings };
  }
  const config = resolvePtyConfig(value, os);
  const runtimeSupported = supportsPty(runtimeVersion);
  if (!runtimeSupported) {
    findings.push({
      check: "pty",
      level: "warning",
      message: `the pinned runtime ${runtimeVersion} has no Deno.openPty: ` +
        "every pty call rejects `unsupported`",
      fix: "upgrade denext (`denext upgrade`): its pinned runtime has Deno.openPty",
    });
  }
  if (os === "windows" && runtimeSupported && !supportsPtyOn(runtimeVersion, "windows")) {
    findings.push({
      check: "pty",
      level: "warning",
      message: `the pinned runtime ${runtimeVersion} has no terminals on Windows (its ` +
        "Deno.openPty throws NotSupported there, with no ConPTY support): every " +
        "spawnPty() there rejects `unsupported`",
      fix: "upgrade denext (`denext upgrade`): its pinned runtime has ConPTY terminals on Windows",
    });
  }
  if (config.shells.length === 0) {
    findings.push({
      check: "pty",
      level: "warning",
      message: `desktop.capabilities.pty.shells lists no program for ${os}: spawnPty() is refused`,
      fix: os === "windows"
        ? "add an absolute Windows path (C:\\Windows\\System32\\cmd.exe) to pty.shells"
        : "add an absolute path (/bin/zsh) to pty.shells",
    });
  }
  if (config.onWindowClose === "detach" && !keepsAlive(d)) {
    findings.push({
      check: "pty",
      level: "warning",
      message: 'pty.onWindowClose is "detach", but the app quits with its last window (no ' +
        "desktop.app.keepAlive, no tray), so a detached terminal is killed with it: only another " +
        "window that is still open can attach it",
      fix: 'set desktop.app.keepAlive: true (or a desktop.tray), or use onWindowClose: "kill"',
    });
  }
  return {
    pty: {
      runAllow: config.shells,
      onWindowClose: config.onWindowClose,
      runtimeSupported: supportsPtyOn(runtimeVersion, os),
      runtimeFloor: os === "windows" ? FIRST_WINDOWS_PTY_RUNTIME : FIRST_PTY_RUNTIME,
    },
    findings,
  };
}

/**
 * The listing's line for the `pty` capability.
 *
 * @param pty The facts.
 * @returns The line.
 */
export function ptyFactLine(pty: DoctorPty): string {
  const run = pty.runAllow.length > 0 ? `--allow-run=${pty.runAllow.join(",")}` : "no shell";
  const runtime = pty.runtimeSupported
    ? "Deno.openPty available"
    : "the pinned runtime starts no terminals here (`denext upgrade`)";
  return `  pty       ${run}; onWindowClose ${pty.onWindowClose}; ${runtime}`;
}
