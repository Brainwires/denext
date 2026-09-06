// Opt-in wall-time instrumentation (`DENEXT_TIMING=1`): the cheap way to see where a slow
// build or a slow first request spends its minutes. Shared by the build pipeline and the
// server; a no-op (one env read, cached) when the variable is unset.

let enabled: boolean | null = null;

function timingEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = !!Deno.env.get("DENEXT_TIMING");
    } catch {
      enabled = false; // no env permission → off
    }
  }
  return enabled;
}

/** Run `step`, printing `[timing] <label> <secs>s` to stderr when timing is enabled. */
export async function timed<T>(label: string, step: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return await step();
  const started = performance.now();
  try {
    return await step();
  } finally {
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    console.error(`  [timing] ${label} ${secs}s`);
  }
}
