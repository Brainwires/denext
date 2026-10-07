/**
 * The `globalShortcuts` capability: system-wide keyboard shortcuts through
 * `Deno.desktop.shortcuts` (denext's pinned Deno Desktop runtime) — a key combination that reaches
 * the app whichever app has the keyboard focus. The page side is `denext/desktop/app`'s
 * `registerShortcut`.
 *
 * Mechanisms (the runtime's): macOS Carbon hot keys (no Accessibility permission), Windows
 * `RegisterHotKey`, X11 key grabs, and on Wayland the XDG GlobalShortcuts portal, where the desktop
 * asks the user to approve each shortcut (and may bind another trigger).
 *
 * Presses are PULLED (a `pressed` signal, then `take`), so a press is delivered once, never again
 * after a reload. A new page load releases every shortcut the previous page registered (the page
 * that would handle them is gone; the new one registers its own).
 *
 * Under the stock runtime every method answers `unavailable`.
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, type DesktopCapCtx, DesktopCapError } from "../extension.ts";
import { type DesktopAppApi, desktopAppApi, type DesktopShortcutsApi } from "../launch-events.ts";
import { createPullQueue, type PullQueue } from "./queue.ts";

/** The longest accelerator accepted. */
const MAX_ACCELERATOR = 64;
/** The most shortcuts one app may hold. */
const MAX_SHORTCUTS = 64;

/** Options for {@linkcode shortcutsCapability}. */
export interface ShortcutsCapabilityOptions {
  /** The runtime's app API (default `Deno.desktop`); tests pass a fake. */
  readonly api?: DesktopAppApi;
}

/** The runtime's shortcuts, or `unavailable`. */
function nativeShortcuts(api: DesktopAppApi | undefined): DesktopShortcutsApi {
  const s = api?.shortcuts;
  if (typeof s?.register !== "function" || typeof s.addEventListener !== "function") {
    throw new DesktopCapError(
      "unavailable",
      "this Deno Desktop runtime has no global shortcuts (denext's pinned runtime adds them)",
    );
  }
  return s;
}

/** The accelerator argument. */
function accelerator(args: unknown): string {
  const raw = (args as { accelerator?: unknown } | null)?.accelerator;
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_ACCELERATOR) {
    throw new DesktopCapError("validation", "accelerator must be a non-empty string");
  }
  return raw;
}

/** The runtime's rejection as a bridge error (its `code` names the case). */
function registerError(err: unknown): DesktopCapError {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case "invalid":
      return new DesktopCapError("validation", message);
    case "not_supported":
      // The runtime's message is the reason (Wayland without the GlobalShortcuts portal, …).
      return new DesktopCapError("unsupported", message, {
        status: 501,
        data: { reason: message || "no global shortcuts in this session" },
      });
    case "conflict":
    case "already_registered":
    case "denied":
      return new DesktopCapError(code, message, { status: 409 });
    default:
      return new DesktopCapError("failed", "the OS did not register the shortcut", { status: 500 });
  }
}

/**
 * Build the `globalShortcuts` capability.
 *
 * @param options The runtime API (tests).
 * @returns The capability.
 */
export function shortcutsCapability(options: ShortcutsCapabilityOptions = {}): DesktopCapability {
  const api = () => options.api ?? desktopAppApi();
  let queue: PullQueue<{ accelerator: string }> | undefined;

  /** Start queueing presses (once). */
  const install = (s: DesktopShortcutsApi, ctx: DesktopCapCtx) => {
    if (queue) return queue;
    const q = createPullQueue<{ accelerator: string }>(() => ctx.emit("pressed", null));
    queue = q;
    s.addEventListener("shortcut", (e) => {
      const acc = ((e as CustomEvent).detail as { accelerator?: unknown } | null)?.accelerator;
      if (typeof acc === "string") q.push({ accelerator: acc });
    });
    return q;
  };

  return {
    name: "globalShortcuts",
    methods: {
      capabilities: { handler: () => nativeShortcuts(api()).capabilities() },
      register: {
        // The Wayland portal asks the user: no deadline. The pinned runtime needs an UNSCOPED
        // `--allow-sys` to register.
        timeoutMs: false,
        permissions: { sys: ["*"] },
        handler: async (args, ctx) => {
          const s = nativeShortcuts(api());
          const acc = accelerator(args);
          if (s.list().length >= MAX_SHORTCUTS) {
            throw new DesktopCapError("validation", `at most ${MAX_SHORTCUTS} shortcuts`);
          }
          install(s, ctx);
          try {
            return { accelerator: await s.register(acc) };
          } catch (err) {
            throw registerError(err);
          }
        },
      },
      unregister: {
        handler: (args) => ({ removed: nativeShortcuts(api()).unregister(accelerator(args)) }),
      },
      unregisterAll: {
        handler: () => {
          nativeShortcuts(api()).unregisterAll();
          return null;
        },
      },
      list: { handler: () => nativeShortcuts(api()).list() },
      canonicalize: {
        handler: (args) => ({
          accelerator: nativeShortcuts(api()).canonicalize(accelerator(args)),
        }),
      },
      take: {
        handler: (_args, ctx) => install(nativeShortcuts(api()), ctx).take(),
      },
    },
    events: ["pressed"],
    onPageLoad: () => {
      const s = api()?.shortcuts;
      if (typeof s?.unregisterAll === "function") s.unregisterAll();
      queue?.clear();
    },
  };
}
