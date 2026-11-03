// A file `runDesktop` reads by its app path (the tray's icons) when the export doesn't have it.
// `denext desktop dev` builds the window without an export (the window proxies the dev server), so
// a `desktop.tray.icon: "/tray.png"` read from the export alone was missing there and the tray
// failed to start ("the tray icon /tray.png is not in the export", an unhandled rejection).
// In dev the file comes from the dev server the window proxies, with the same token headers.

/** The dev server a `denext desktop dev` window proxies. */
export interface DesktopDevFileSource {
  /** The dev server's URL (`DENEXT_DESKTOP_DEV_URL`). */
  readonly url: string;
  /** Headers every request to it carries (a LAN dev server's session token). */
  readonly headers: Readonly<Record<string, string>>;
  /** The fetch to use (tests pass their own). */
  readonly fetch?: typeof fetch;
}

/**
 * Read `path` (an app path such as `/tray.png`) from the export, else from the dev server when
 * `dev` is given.
 *
 * @param fromExport Reads the export; `null` when it has no such file.
 * @param path The app path.
 * @param dev The dev server, in `denext desktop dev`; omitted in a built app.
 * @returns The file's bytes, or `null` when neither has it.
 */
export async function readDesktopAppFile(
  fromExport: (path: string) => Promise<Uint8Array | null>,
  path: string,
  dev?: DesktopDevFileSource,
): Promise<Uint8Array | null> {
  const local = await fromExport(path);
  if (local || !dev) return local;
  const pathname = new URL(path, "http://export.invalid").pathname;
  try {
    const res = await (dev.fetch ?? fetch)(new URL(pathname, dev.url), {
      headers: { ...dev.headers },
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null; // the dev server is down: the caller says the file is missing
  }
}
