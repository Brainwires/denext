/**
 * The `keepAwake` capability: hold the display/machine awake while the page has an active hold
 * (see `holdDesktopAwake` in `src/desktop/native.ts`). Each page holder gets its own id; the runtime
 * keeps ONE OS power assertion while any id is held, and drops it when the last is released.
 *
 * The OS assertion is a {@link KeepAwakeDriver}:
 * - macOS: a long-running `caffeinate -dimsu -w <pid>` child, killed on release (`--allow-run=caffeinate`).
 * - Linux: `systemd-inhibit --what=idle:sleep … tail --pid=<pid>` held while the child runs, killed
 *   on release (`--allow-run=systemd-inhibit`).
 * Both children are tied to the app's pid ({@link keepAwakeCommand}), so a quit or crash that never
 * releases still drops the assertion.
 * - Windows: `kernel32!SetThreadExecutionState` via FFI (ES_CONTINUOUS|SYSTEM|DISPLAY to hold,
 *   ES_CONTINUOUS to release) (`--allow-ffi=kernel32.dll`).
 *
 * The driver is injected so tests exercise the ref-counting without touching the OS.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import type { DesktopCapability, DesktopPermissions } from "../extension.ts";

/** The running OS spelling the default driver branches on. */
type Os = "darwin" | "windows" | "linux";

/** An OS power assertion: {@link start} acquires it and returns a releaser. */
export interface KeepAwakeDriver {
  /** Acquire the OS assertion; the returned function releases it. */
  start(): Promise<() => void | Promise<void>>;
  /** The Deno permissions the driver needs (for packaging + `doctor`). */
  readonly permissions: DesktopPermissions;
}

/**
 * The argv of the assertion-holding child on macOS/Linux, TIED TO `pid` (the app's Deno process):
 * the child exits on its own once `pid` does. A spawned child is NOT killed when its parent exits,
 * and the window-close handler ends the app with `Deno.exit(0)` (no release RPC ever arrives), so an
 * untied `caffeinate` / `systemd-inhibit … sleep` would keep the machine awake indefinitely after
 * the app quit or crashed. macOS: `caffeinate -w <pid>`; Linux: the inhibitor wraps
 * `tail --pid=<pid> -f /dev/null` (GNU coreutils), which returns when `pid` exits. Pure + exported
 * for tests.
 *
 * @param os `darwin` or `linux`.
 * @param pid The process whose lifetime bounds the assertion.
 * @returns `[command, args]`.
 */
export function keepAwakeCommand(os: "darwin" | "linux", pid: number): [string, string[]] {
  if (os === "darwin") return ["caffeinate", ["-dimsu", "-w", String(pid)]];
  return ["systemd-inhibit", [
    "--what=idle:sleep",
    "--who=denext",
    "--why=keep-awake",
    "--mode=block",
    "tail",
    `--pid=${pid}`,
    "-f",
    "/dev/null",
  ]];
}

/** The default driver for `os`. */
function defaultDriver(os: Os): KeepAwakeDriver {
  if (os === "windows") {
    return {
      permissions: { ffi: ["kernel32.dll"] },
      start: () => {
        const ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;
        // deno-lint-ignore no-explicit-any
        const lib = (Deno as any).dlopen("kernel32.dll", {
          SetThreadExecutionState: { parameters: ["u32"], result: "u32" },
        });
        // `>>> 0`: a JS bitwise OR with bit 31 set is a negative int32, which Deno FFI rejects for a
        // `u32` parameter.
        lib.symbols.SetThreadExecutionState(
          (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) >>> 0,
        );
        return Promise.resolve(() => {
          lib.symbols.SetThreadExecutionState(ES_CONTINUOUS);
          lib.close();
        });
      },
    };
  }
  const [cmd, args] = keepAwakeCommand(os, Deno.pid);
  return {
    permissions: { run: [cmd] },
    start: () => {
      const child = new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "null" })
        .spawn();
      return Promise.resolve(() => {
        try {
          child.kill();
        } catch {
          // already exited
        }
      });
    },
  };
}

/** Options for {@link keepAwakeCapability}. */
export interface KeepAwakeDeps {
  /** The OS (defaults to the running one) — picks the default driver. */
  readonly os?: Os;
  /** The assertion driver (defaults to the OS one); tests inject a fake. */
  readonly driver?: KeepAwakeDriver;
}

/**
 * Build the `keepAwake` capability. Ref-counts the page's holds and keeps exactly one OS assertion
 * while any is held.
 *
 * @param deps The OS and/or an injected driver.
 * @returns The `keepAwake` {@link DesktopCapability}.
 */
export function keepAwakeCapability(deps: KeepAwakeDeps = {}): DesktopCapability {
  const driver = deps.driver ?? defaultDriver(deps.os ?? (Deno.build.os as Os));
  const held = new Set<string>();
  let releaser: (() => void | Promise<void>) | undefined;
  let starting: Promise<void> | undefined;

  const ensureActive = async (): Promise<void> => {
    if (releaser) return;
    if (!starting) {
      starting = driver.start().then((r) => {
        releaser = r;
      }).finally(() => {
        starting = undefined;
      });
    }
    await starting;
  };

  const maybeStop = async (): Promise<void> => {
    if (held.size === 0 && releaser) {
      const r = releaser;
      releaser = undefined;
      await r();
    }
  };

  return {
    name: "keepAwake",
    // A reload/navigation drops the old page's holds: its `release` will never arrive, and the
    // new page acquires afresh (otherwise a reload leaks a hold and the machine never sleeps).
    onPageLoad: async () => {
      held.clear();
      await maybeStop();
    },
    methods: {
      acquire: {
        permissions: driver.permissions,
        handler: async () => {
          const id = crypto.randomUUID();
          held.add(id);
          await ensureActive();
          // A release that raced in before start resolved may have emptied the set.
          await maybeStop();
          return { id };
        },
      },
      release: {
        handler: async (args) => {
          const id = (args as { id?: unknown })?.id;
          if (typeof id === "string") held.delete(id);
          await maybeStop();
          return { ok: true };
        },
      },
    },
  };
}
