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
/** A slot's probe name. */
function slotName(el: HTMLElement): string {
  return el.dataset.probe ?? el.dataset.denextNativeView ?? "";
}

/** Ask the native side, once per slot, to turn on its "[nv]" NSLog lines (device console). */
async function enableLogging(
  name: string,
  command: Command,
  logging: Set<string>,
) {
  if (logging.has(name)) return;
  logging.add(name);
  await command("__debug").catch(() => {});
}

/** Where the native side has a slot's view (or why it cannot say). */
async function nativeFrame(
  command: Command | undefined,
  name: string,
  logging: Set<string>,
) {
  if (!command) return undefined;
  await enableLogging(name, command, logging);
  return await command("__frame").catch((e) => String(e));
}

/** An element as `tag.class#id`, for the probe. */
function describe(el: Element): string {
  const cls = typeof el.className === "string" && el.className
    ? `.${el.className.split(" ").join(".")}`
    : "";
  return `${el.tagName.toLowerCase()}${cls}${el.id ? `#${el.id}` : ""}`;
}

/** One slot's DOM box next to where the native side has its view. */
async function probeSlot(
  el: HTMLElement,
  commands: Map<string, Command>,
  logging: Set<string>,
) {
  const r = el.getBoundingClientRect();
  const name = slotName(el);
  const native = await nativeFrame(commands.get(name), name, logging);
  const dom = { x: r.x, y: r.y, width: r.width, height: r.height };
  // What the page hit-tests at the slot's center, topmost first: the occlusion check's input.
  const stack = document.elementsFromPoint(
    r.x + r.width / 2,
    r.y + r.height / 2,
  ).slice(0, 4);
  return {
    name,
    status: el.dataset.status,
    dom,
    native,
    stack: stack.map(describe),
  };
}

export function startRectProbe(commands: Map<string, Command>): () => void {
  if (!feature("NV_PROBE")) return () => {};
  // denext's tracker logs "[nv-occ]" lines (console, forwarded to the device log) on every
  // change of a slot's covered answer.
  (globalThis as { __DENEXT_NV_DEBUG__?: boolean }).__DENEXT_NV_DEBUG__ = true;
  const logging = new Set<string>();
  const timer = setInterval(async () => {
    const els = document.querySelectorAll<HTMLElement>(
      "[data-denext-native-view]",
    );
    const slots = await Promise.all(
      [...els].map((el) => probeSlot(el, commands, logging)),
    );
    probe("rects", slots);
  }, 1000);
  probe("start", { ua: navigator.userAgent });
  const stopLog = forwardNativeLog();
  return () => {
    clearInterval(timer);
    stopLog();
  };
}

/** The plugin's "[nv]" lines (once `__debug` turned them on), posted to the collector. */
function forwardNativeLog(): () => void {
  const plugins = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor
    ?.Plugins;
  const views = plugins?.DenextNativeViews as
    | {
      addListener?: (e: string, fn: (d: { line?: string }) => void) => unknown;
    }
    | undefined;
  const handle = views?.addListener?.(
    "nativeViewLog",
    (d) => probe("nv", d.line),
  );
  return () => void Promise.resolve(handle).then((h) => (h as { remove?: () => void })?.remove?.());
}
