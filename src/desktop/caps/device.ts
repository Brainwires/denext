/**
 * The `device` capability: `deviceInfo()` on Deno Desktop. It answers `denext/mobile`'s
 * `device.info` RPC with `{ os, osVersion, model? }` — the OS, its release, and the coarse model
 * name (`Macintosh` / `Windows` / `Linux`) that `deviceInfo`'s user-agent fallback would report.
 *
 * DELIBERATELY MINIMAL: it exposes only the OS and its release — the same two facts the web
 * fallback derives from `navigator.userAgent`, and no more. It never reads the hostname, user name,
 * architecture, CPU/memory, network or any other machine-identifying signal, even though the Deno
 * process could. `osVersion` is `Deno.osRelease()` (the kernel release), matching the documented
 * desktop contract in `src/mobile/device.ts`; it needs `--allow-sys=osRelease` in the packaged app,
 * and the cap answers `""`-less (omits the field) if that read is refused.
 *
 * Runtime-only (imported by the desktop entry, never a client bundle). Touches nothing that
 * persists, so it needs no app directory.
 *
 * @module
 */

import type { DesktopCapability } from "../extension.ts";

/** The coarse, non-identifying model name for an OS (mirrors the UA fallback in `device.ts`). */
const MODEL_BY_OS: Readonly<Record<string, string>> = {
  darwin: "Macintosh",
  windows: "Windows",
  linux: "Linux",
};

/** `Deno.osRelease()`, or undefined when `--allow-sys=osRelease` is not granted. */
function osReleaseOrUndefined(): string | undefined {
  try {
    const release = Deno.osRelease();
    return release ? release : undefined;
  } catch {
    return undefined;
  }
}

/** The built-in `device` capability. */
export const deviceCapability: DesktopCapability = {
  name: "device",
  methods: {
    info: {
      permissions: { sys: ["osRelease"] },
      handler: (_args, ctx) => {
        const osVersion = osReleaseOrUndefined();
        return {
          os: ctx.os,
          model: MODEL_BY_OS[ctx.os] ?? ctx.os,
          ...(osVersion !== undefined ? { osVersion } : {}),
        };
      },
    },
  },
};
