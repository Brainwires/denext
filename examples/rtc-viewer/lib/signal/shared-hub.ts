// The process's one hub. Kept on `globalThis` so a dev-server module reload keeps the rooms (and
// their open streams) instead of starting an empty hub beside them.

import { SHELL_ORIGINS, SignalHub } from "./hub.ts";

const KEY = Symbol.for("rtc-viewer.signal-hub");

/** Extra allowed origins, comma separated (`RTC_SIGNAL_ORIGINS=https://app.example`). */
function extraOrigins(): string[] {
  try {
    return (Deno.env.get("RTC_SIGNAL_ORIGINS") ?? "").split(",").map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return []; // no env permission
  }
}

/** The hub every request of this process shares. */
export function sharedHub(): SignalHub {
  const slot = globalThis as unknown as Record<symbol, SignalHub | undefined>;
  return slot[KEY] ??= new SignalHub({
    allowedOrigins: [...SHELL_ORIGINS, ...extraOrigins()],
  });
}
