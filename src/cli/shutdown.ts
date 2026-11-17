// Graceful shutdown for the processes that own a server (`denext start`, `serve`, `ui`, a compiled
// app): the termination signals to trap and the controller they abort. Its own module so a
// compiled app's entry reaches it without the CLI's build helpers.

/**
 * Termination signals to trap for graceful shutdown (platform-dependent). On Windows, Deno maps
 * the console's events to signals: Ctrl-C is `SIGINT`, Ctrl-Break `SIGBREAK`, a closed console
 * window `SIGHUP`, and logoff / system shutdown `SIGTERM`.
 */
export const SHUTDOWN_SIGNALS: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"]
  : ["SIGINT", "SIGTERM"];

/**
 * Abort `controller` on the first termination signal (and stop trapping, so the
 * process exits once the server drains). Passing the controller's signal to the
 * server makes Deno.serve stop accepting and wait for in-flight requests. The listener returns a
 * promise that settles as the process ends, so a runtime that waits on it (Windows' console close,
 * logoff and shutdown events, which end the process once the handler returns) lets the drain run.
 *
 * @param controller Aborted on the first termination signal.
 * @returns Stops trapping: for a server that ended another way (its `shutdown()`), whose
 *   listeners would otherwise keep the event loop alive and swallow the next Ctrl-C.
 */
export function installShutdown(controller: AbortController): () => void {
  const uninstall = () => {
    for (const sig of SHUTDOWN_SIGNALS) {
      try {
        Deno.removeSignalListener(sig, onSignal);
      } catch { /* not installed */ }
    }
  };
  // The listener's promise settles when the process is ending (`unload`: the drain finished and
  // the event loop emptied, or the server exited itself). A runtime that waits on a signal
  // listener's promise before letting the OS end the process (Windows: a closed console window,
  // logoff, system shutdown) then holds that end for the drain, up to the OS's own limit.
  let settle: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => settle = resolve);
  const onSignal = (): Promise<void> => {
    controller.abort();
    uninstall();
    globalThis.addEventListener("unload", () => settle?.(), { once: true });
    return settled;
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, onSignal);
    } catch { /* signal unsupported on this platform */ }
  }
  return uninstall;
}
