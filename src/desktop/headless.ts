/**
 * Headless runs of a Deno Desktop app: `DENEXT_DESKTOP_HEADLESS=1` (or `denext desktop run
 * --headless`) starts the app with every window hidden — never shown, never focused, no Dock icon,
 * no Dock bounce — while its pages, extensions and sidecars load and run as usual. For a packaged
 * app's self-test (a PTY round trip, a sidecar's health) on a machine where no window may appear: a
 * CI runner, a build host.
 *
 * Windows stay windows: each page still loads in a real (hidden) `BrowserWindow`, so it runs its
 * scripts as it would on screen. What headless takes away is everything that would put one in
 * front of the user: the main window is hidden as soon as `runDesktop` adopts it, every window
 * opened afterwards (`windows.open`, `openWindow`, a tray panel) is created hidden, and `show()`,
 * `focus()`, `maximize()`, `restore()`, `setFullScreen()` on any of them do nothing, as do the Dock's
 * `bounce()` and a switch of the activation policy to anything but `"accessory"`.
 *
 * Runtime-only (imported by `runDesktop`).
 *
 * @module
 */

/** The environment variable that starts the app headless (`1` or `true`). */
export const DESKTOP_HEADLESS_ENV = "DENEXT_DESKTOP_HEADLESS";

/**
 * The launch env of a headless run (`denext desktop run --headless`): this module's switch, and
 * what the webview host reads at process start: `LAUFEY_HEADLESS=1` (a host that reads it keeps
 * every window hidden, CEF's first one included, and does not activate the app on macOS) and the
 * macOS activation policy (`LAUFEY_ACTIVATION_POLICY`), so the app has no Dock icon from its first
 * frame.
 *
 * @returns The variables to add to the launched app's env.
 */
export function desktopHeadlessLaunchEnv(): Record<string, string> {
  return {
    [DESKTOP_HEADLESS_ENV]: "1",
    LAUFEY_HEADLESS: "1",
    LAUFEY_ACTIVATION_POLICY: "accessory",
  };
}

/**
 * `env` with the headless launch env ({@linkcode desktopHeadlessLaunchEnv}) on top when the launch
 * is headless: `env` sets `DENEXT_DESKTOP_HEADLESS`, or (when it does not) this process's
 * environment does, which the launched app inherits. So `denext desktop run` / `dev` under
 * `DENEXT_DESKTOP_HEADLESS=1` hand the webview host its variables too, not only `--headless`.
 *
 * @param env The launch env.
 * @param inherited This process's `DENEXT_DESKTOP_HEADLESS` (default: read from the environment).
 * @returns `env`, or a copy with the headless variables.
 */
export function withHeadlessLaunchEnv(
  env: Record<string, string>,
  inherited: string | undefined = headlessEnv(),
): Record<string, string> {
  const raw = DESKTOP_HEADLESS_ENV in env ? env[DESKTOP_HEADLESS_ENV] : inherited;
  return desktopHeadless(raw) ? { ...env, ...desktopHeadlessLaunchEnv() } : env;
}

/** The window methods that would show, raise or activate a window: no-ops when headless. */
const SURFACING_METHODS = [
  "show",
  "focus",
  "maximize",
  "restore",
  "unminimize",
  "setFullScreen",
] as const;

/** Marks a window or Dock made headless (so it is done once). */
const HEADLESS = Symbol.for("denext.desktop.headless");

/**
 * Whether this launch is headless: `DENEXT_DESKTOP_HEADLESS` is `1` or `true`. Unreadable (a
 * strict app that did not list it) is not headless.
 *
 * @param raw The variable's value (default: read from the environment).
 * @returns Whether every window stays hidden.
 */
export function desktopHeadless(raw: string | undefined = headlessEnv()): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** `DENEXT_DESKTOP_HEADLESS`, `undefined` where env access is not granted. */
function headlessEnv(): string | undefined {
  try {
    return Deno.env.get(DESKTOP_HEADLESS_ENV);
  } catch {
    return undefined;
  }
}

/** Replace `obj[name]` with `fn` (an own property; a frozen or odd object is left as it is). */
function override(obj: object, name: PropertyKey, fn: unknown): void {
  try {
    Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
  } catch { /* not ours to change */ }
}

/**
 * Make `win` a headless window, in place: hidden now, and its surfacing methods
 * ({@linkcode SURFACING_METHODS}) no-ops from here on. Anything that is not an object is returned
 * as it is; a window made headless before is left alone.
 *
 * @param win The `BrowserWindow`.
 * @returns `win`.
 */
export function headlessWindow<T>(win: T): T {
  if (typeof win !== "object" || win === null) return win;
  const w = win as Record<PropertyKey, unknown>;
  if (w[HEADLESS] === true) return win;
  override(w, HEADLESS, true);
  try {
    (w.hide as (() => void) | undefined)?.call(win);
  } catch { /* a window that cannot hide yet still gets the guards */ }
  for (const name of SURFACING_METHODS) {
    if (typeof w[name] === "function") override(w, name, () => {});
  }
  return win;
}

/**
 * A `BrowserWindow` constructor whose windows are created hidden (`show: false`) and made headless
 * ({@linkcode headlessWindow}). Not a function: returned as it is.
 *
 * @param Ctor The runtime's `BrowserWindow`.
 * @returns The wrapped constructor.
 */
export function headlessWindowConstructor<T>(Ctor: T): T {
  if (typeof Ctor !== "function") return Ctor;
  const Base = Ctor as unknown as new (options?: Record<string, unknown>) => object;
  const Wrapped = function (this: unknown, options?: Record<string, unknown>) {
    const opts = typeof options === "object" && options !== null ? options : {};
    return headlessWindow(new Base({ ...opts, show: false }));
  } as unknown as T;
  // `instanceof` and statics keep working through the wrapper.
  Object.setPrototypeOf(Wrapped, Base);
  (Wrapped as unknown as { prototype: unknown }).prototype = Base.prototype;
  return Wrapped;
}

/** The Dock as headless reads it. */
interface DockLike {
  bounce?(critical?: boolean): void;
  setActivationPolicy?(policy: string): boolean;
  setVisible?(visible: boolean): void;
}

/**
 * Make the macOS Dock headless, in place: the app switches to `"accessory"` (no Dock icon) now,
 * `bounce()` does nothing, a later `setActivationPolicy` takes only `"accessory"` (answering
 * `false` for the others) and `setVisible(true)` does nothing.
 *
 * @param dock `Deno.dock` (anything else is returned as it is).
 * @returns `dock`.
 */
export function headlessDock<T>(dock: T): T {
  if (typeof dock !== "object" || dock === null) return dock;
  const d = dock as DockLike & Record<PropertyKey, unknown>;
  if (d[HEADLESS] === true) return dock;
  override(d, HEADLESS, true);
  const setPolicy = typeof d.setActivationPolicy === "function"
    ? d.setActivationPolicy.bind(dock)
    : undefined;
  const setVisible = typeof d.setVisible === "function" ? d.setVisible.bind(dock) : undefined;
  try {
    if (setPolicy) setPolicy("accessory");
    else setVisible?.(false);
  } catch { /* an older runtime: the guards still apply */ }
  if (typeof d.bounce === "function") override(d, "bounce", () => {});
  if (setPolicy) {
    override(d, "setActivationPolicy", (p: string) => p === "accessory" ? setPolicy(p) : false);
  }
  if (setVisible) override(d, "setVisible", (v: boolean) => v ? undefined : setVisible(false));
  return dock;
}
