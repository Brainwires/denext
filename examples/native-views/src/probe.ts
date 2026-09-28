// Device-test probe: with NV_PROBE=1 at export time, the app posts what the native views report
// (events, and where the native side placed each view against its DOM slot) to a collector on
// the LAN. Off in a normal build: `feature("NV_PROBE")` folds to false and this code is removed.
import { feature } from "denext/feature";

const COLLECTOR = "http://172.20.10.2:3999/nv";

/** Post one probe line (never throws; nothing happens unless the probe build flag is on). */
export function probe(event: string, data?: unknown): void {
  if (!feature("NV_PROBE")) return;
  try {
    fetch(COLLECTOR, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ t: Date.now(), event, data }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // No network: the probe is best effort.
  }
}

type Command = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Every second, post each slot's DOM box next to where the native side has its view
 * (`__frame`, a plugin debug command): the rect-sync line.
 */
export function startRectProbe(commands: Map<string, Command>): () => void {
  if (!feature("NV_PROBE")) return () => {};
  const timer = setInterval(async () => {
    const slots = [];
    for (
      const el of document.querySelectorAll<HTMLElement>(
        "[data-denext-native-view]",
      )
    ) {
      const r = el.getBoundingClientRect();
      const name = el.dataset.probe ?? el.dataset.denextNativeView ?? "";
      const native = await commands.get(name)?.("__frame").catch((e) => String(e));
      slots.push({
        name,
        status: el.dataset.status,
        dom: { x: r.x, y: r.y, width: r.width, height: r.height },
        native,
      });
    }
    probe("rects", slots);
  }, 1000);
  probe("start", { ua: navigator.userAgent });
  return () => clearInterval(timer);
}
