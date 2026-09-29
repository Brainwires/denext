// The islands' hydration probe: every island that the harness waits for bumps a counter and
// stamps the time, so time-to-interactive can include "the last island hydrated".

interface HydrationProbe {
  __sbHydrated?: number;
  __sbHydratedAt?: number;
}

/** Called from an island's first effect (the moment it is hydrated and live). */
export function markHydrated(): void {
  const g = globalThis as HydrationProbe;
  g.__sbHydrated = (g.__sbHydrated ?? 0) + 1;
  g.__sbHydratedAt = performance.now();
}
