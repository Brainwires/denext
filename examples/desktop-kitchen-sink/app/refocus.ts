// After a check closes a window it opened, the main window gets the keyboard focus back before the
// next check runs: closing a window leaves the focus wherever the window manager puts it, and
// xfwm4 under Xvfb (the Linux CI session) once left it nowhere, so the next check's maximize
// request timed out. The pure loop behind `checks.ts`'s secondary-window check (no window calls
// here, so it is unit-tested in tests/desktop-kitchen-sink.test.ts).

/** What {@link refocusMain} drives. */
export interface RefocusOptions {
  /** Ask for the focus (`focusWindow()`); a rejection is treated as "not granted yet". */
  readonly focus: () => Promise<void>;
  /** Whether this window has the focus (`document.hasFocus()`). */
  readonly hasFocus: () => boolean;
  /** How long to wait for the focus. */
  readonly timeoutMs?: number;
  /** How often to look. */
  readonly pollMs?: number;
  /** How often to ask again while the focus has not come back. */
  readonly reaskMs?: number;
}

/**
 * Ask for the main window's focus and wait until it has it. Never throws: a window manager that
 * keeps the focus elsewhere costs the wait, and the next check runs anyway.
 *
 * @param options The focus call, the probe and the timing.
 * @returns Whether the window has the focus when it returns.
 */
export async function refocusMain(options: RefocusOptions): Promise<boolean> {
  const { focus, hasFocus, timeoutMs = 5000, pollMs = 100, reaskMs = 1000 } = options;
  if (hasFocus()) return true;
  const end = Date.now() + timeoutMs;
  let askedAt = -Infinity;
  while (Date.now() < end) {
    if (Date.now() - askedAt >= reaskMs) {
      askedAt = Date.now();
      await focus().catch(() => {});
    }
    if (hasFocus()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return hasFocus();
}
