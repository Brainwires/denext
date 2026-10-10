/**
 * The web `Notification` API for a Deno Desktop window, backed by the OS notifications of the
 * `notifications` capability. A webview has no working `Notification` (WKWebView has none at all),
 * so code written for a browser or Electron (`new Notification(title, { body, tag })`,
 * `Notification.permission`, `Notification.requestPermission()`, `onclick`) would do nothing. When
 * the capability is enabled under denext's pinned runtime, the desktop runtime inlines
 * {@linkcode DESKTOP_NOTIFICATION_SHIM_JS} into the injected `__denext` script of every top-level
 * page, before any page script, and it replaces `globalThis.Notification`.
 *
 * How it maps:
 *
 * - `new Notification(title, { body, tag, data })` posts an OS notification now (the capability's
 *   `webShow`) once the permission is known; `show` fires when it is posted, `error` when the
 *   permission is not `granted` or the post fails.
 * - `tag`: a second notification with the same tag replaces the first (in the OS too), without a
 *   `close` event on the replaced one, as in browsers.
 * - `close()` removes it from the OS and fires `close`.
 * - A click on it in the OS fires `click` (and `onclick`) on the object, through the capability's
 *   `webtap` signal and `webTake` queue. A click after the page reloaded reaches nothing. A click
 *   is untrusted input, as its `data` is: on Linux any process of the same user can forge one (a
 *   D-Bus call on the app's name), and on Windows the user's own processes can forge a toast
 *   activation.
 * - `Notification.permission` starts `"default"` and is the OS's answer once the first query
 *   returns (within the first tick or two); `requestPermission()` asks the OS (it prompts when
 *   undecided) and resolves `"granted"`, `"denied"` or `"default"`. An OS that has not answered
 *   within 20 s (a prompt left open, or an app the OS will not ask for) resolves it with the state
 *   known so far, `"default"` when nothing is, as a dismissed browser prompt does; a later answer
 *   still updates `Notification.permission`.
 *
 * `silent: true` posts the OS notification without a sound. The rest of the options (`icon`,
 * `image`, `badge`, `requireInteraction`, `actions`, `vibrate`, `renotify`) are kept on the object
 * but not shown: the OS notification has the app's icon, the default sound and no buttons. A dismissal in the OS fires nothing.
 *
 * The function is serialized with `Function.prototype.toString` and inlined into the page, so it is
 * self-contained: it reaches nothing outside its body but its `g` argument (`globalThis` in the
 * page; tests pass a fake).
 *
 * @module
 */

/** The page global the shim installs into (loosely typed: the page's `globalThis`, or a fake). */
// deno-lint-ignore no-explicit-any
export type NotificationShimGlobal = any;

/**
 * Install the web `Notification` shim into `g` (the page's `globalThis`). It needs the per-launch
 * token in `g.__denext` (a top-level page of the desktop window); without it nothing happens.
 *
 * @param g The page global.
 * @param permissionTimeoutMs How long `requestPermission()` waits for the OS before it resolves
 *   with the state known so far (20 s; tests pass less). A literal default: the function is
 *   serialized, so it may not name an outer constant.
 */
export function installDesktopNotificationShim(
  g: NotificationShimGlobal,
  permissionTimeoutMs = 20000,
): void {
  const denext = g.__denext;
  if (!denext || denext.desktop !== true || typeof denext.token !== "string" || !denext.token) {
    return;
  }
  const token: string = denext.token;
  const rpc = (method: string, args: unknown): Promise<unknown> =>
    g.fetch("/_denext/desktop/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", "x-denext-desktop-token": token },
      body: JSON.stringify({ cap: "notifications", method, args }),
      credentials: "same-origin",
      cache: "no-store",
    }).then((res: Response) => res.json()).then(
      (env: { ok?: boolean; data?: unknown; error?: { code?: string } } | null) => {
        if (env && env.ok === true) return env.data;
        throw new Error((env && env.error && env.error.code) || "bridge_error");
      },
    );

  let permission = "default";
  // Only the latest ask sets the state: the startup query must not overwrite a request's answer.
  let asks = 0;
  const ask = (request: boolean): Promise<string> => {
    const turn = ++asks;
    const answer = rpc("permission", { request }).then((out) => {
      const state = (out as { state?: unknown } | null)?.state;
      const web = state === "granted" ? "granted" : state === "denied" ? "denied" : "default";
      if (turn === asks) permission = web;
      return web;
    }, () => permission);
    if (!request) return answer;
    // A prompt the OS never answers must not hold the page (or its notifications) forever.
    return new Promise<string>((resolve) => {
      const timer = g.setTimeout(() => resolve(permission), permissionTimeoutMs);
      void answer.then((web) => {
        if (typeof g.clearTimeout === "function") g.clearTimeout(timer);
        resolve(web);
      });
    });
  };
  let ready = ask(false);

  // key -> the live notification object; a tag maps to a stable key, so a reload replaces too.
  // deno-lint-ignore no-explicit-any
  const live = new Map<string, any>();
  const hash = (text: string, seed: number): string => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  const keyFor = (tag: string): string => {
    if (tag) return "t" + hash(tag, 2166136261) + hash(tag, 5381);
    const bytes = new Uint8Array(8);
    g.crypto.getRandomValues(bytes);
    return "r" + Array.from(bytes, (b: number) => b.toString(16).padStart(2, "0")).join("");
  };
  // deno-lint-ignore no-explicit-any
  const fire = (target: any, type: string): void => {
    const event = new g.Event(type, { cancelable: type === "click" });
    const handler = target["on" + type];
    if (typeof handler === "function") {
      try {
        handler.call(target, event);
      } catch (err) {
        g.setTimeout(() => {
          throw err;
        }, 0);
      }
    }
    target.dispatchEvent(event);
  };

  // Clicks: the capability signals `webtap` on the bridge's event stream; take the queue then.
  const take = (): Promise<void> =>
    rpc("webTake", {}).then((list) => {
      for (const tap of Array.isArray(list) ? list : []) {
        const target = live.get((tap as { key?: string } | null)?.key ?? "");
        if (target) fire(target, "click");
      }
    }, () => {});
  let streaming = false;
  const listen = (delay: number): void => {
    const retry = () => g.setTimeout(() => listen(Math.min(delay * 2, 30000)), delay);
    g.fetch("/_denext/desktop/events", {
      headers: { accept: "text/event-stream", "x-denext-desktop-token": token },
      credentials: "same-origin",
      cache: "no-store",
    }).then((res: Response) => {
      if (!res.ok || !res.body) {
        if (res.status !== 401 && res.status !== 403 && res.status !== 404) retry();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new g.TextDecoder();
      let pending = "";
      const pump = (): Promise<void> =>
        reader.read().then(({ value, done }: { value?: Uint8Array; done: boolean }) => {
          if (done) return retry();
          pending += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl).replace(/\r$/, "");
            pending = pending.slice(nl + 1);
            if (!line.startsWith("data:") || line.indexOf('"webtap"') < 0) continue;
            try {
              const frame = JSON.parse(line.slice(5));
              if (frame.cap === "notifications" && frame.event === "webtap") void take();
            } catch { /* not a frame */ }
          }
          if (pending.length > 1048576) return reader.cancel().then(retry);
          return pump();
        });
      return pump();
    }).catch(retry);
  };

  class DesktopNotification extends g.EventTarget {
    constructor(title: string, options?: Record<string, unknown>) {
      super();
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'Notification': 1 argument required");
      }
      const o = options ?? {};
      const str = (v: unknown, d: string) => (v === undefined || v === null ? d : String(v));
      // The web API's read-only attributes, kept as given.
      Object.assign(this, {
        title: String(title),
        body: str(o.body, ""),
        tag: str(o.tag, ""),
        data: o.data === undefined ? null : o.data,
        dir: str(o.dir, "auto"),
        lang: str(o.lang, ""),
        icon: str(o.icon, ""),
        image: str(o.image, ""),
        badge: str(o.badge, ""),
        silent: o.silent === undefined ? null : o.silent === true,
        requireInteraction: o.requireInteraction === true,
        renotify: o.renotify === true,
        timestamp: typeof o.timestamp === "number" ? o.timestamp : Date.now(),
        actions: [],
        vibrate: [],
        onclick: null,
        onshow: null,
        onerror: null,
        onclose: null,
      });
      const self = this as unknown as Record<string, unknown> & { tag: string };
      const key = keyFor(self.tag);
      Object.defineProperty(this, "__key", { value: key });
      live.set(key, this);
      if (!streaming) {
        streaming = true;
        listen(1000);
      }
      void ready.then(() => {
        if (live.get(key) !== this) return; // closed or replaced before it was posted
        if (permission !== "granted") {
          live.delete(key);
          return fire(this, "error");
        }
        return rpc("webShow", {
          key,
          title: self.title,
          body: self.body,
          ...(self.silent === true ? { silent: true } : {}),
        }).then(
          () => fire(this, "show"),
          () => {
            if (live.get(key) === this) live.delete(key);
            fire(this, "error");
          },
        );
      });
    }

    close(): void {
      const key = (this as unknown as { __key: string }).__key;
      if (live.get(key) !== this) return;
      live.delete(key);
      void rpc("webClose", { key }).catch(() => {});
      fire(this, "close");
    }

    static get permission(): string {
      return permission;
    }

    static get maxActions(): number {
      return 0;
    }

    static requestPermission(callback?: (state: string) => void): Promise<string> {
      const asked = ask(true);
      ready = asked;
      if (typeof callback === "function") void asked.then(callback);
      return asked;
    }
  }
  Object.defineProperty(DesktopNotification, "name", { value: "Notification" });
  g.Notification = DesktopNotification;
}

/**
 * {@linkcode installDesktopNotificationShim} as the inline script the desktop runtime appends to
 * its injected `__denext` script (one CSP hash covers both).
 */
export const DESKTOP_NOTIFICATION_SHIM_JS: string =
  `;(${installDesktopNotificationShim.toString()})(globalThis)`;
