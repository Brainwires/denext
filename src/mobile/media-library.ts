/**
 * The photo library for `denext/mobile`: save a photo or video to it, list and create albums,
 * and read recent media. The native `Media` plugin in the shell (`@capacitor-community/media`,
 * installed by `denext mobile add media-library`, which also writes the photo-library usage
 * strings); on the web, saving downloads the file and the album functions are unsupported.
 *
 * @module
 */

import { nativePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/** An album, as {@linkcode getAlbums} lists it. */
export interface MediaAlbum {
  /** The platform's id (a PhotoKit local identifier on iOS, a folder path on Android). */
  readonly id: string;
  /** Its display name. */
  readonly name: string;
  /** iOS: `"user"` (made by an app or the user), `"smart"` (Favorites, Recents…) or `"shared"`. */
  readonly type?: "user" | "smart" | "shared";
}

/** Options for {@linkcode saveToLibrary}. */
export interface SaveToLibraryOptions {
  /** `"photo"` (the default; images and GIFs) or `"video"`. */
  readonly kind?: "photo" | "video";
  /**
   * The album to save into, by name; created when missing. iOS saves to the camera roll when
   * it is left out; Android always saves into an album the app owns, `"Saved"` by default.
   */
  readonly album?: string;
  /** The file name without extension (Android and the web; iOS names files itself). */
  readonly fileName?: string;
}

/** What {@linkcode saveToLibrary} saved. */
export interface SavedMedia {
  /** `"library"` natively; `"download"` on the web (the browser downloaded the file). */
  readonly savedTo: "library" | "download";
  /** iOS: the new asset's local identifier. */
  readonly id?: string;
  /** Android: the saved file's path. */
  readonly path?: string;
}

/** Options for {@linkcode getRecentMedia}. */
export interface RecentMediaOptions {
  /** How many items, newest first. Default 25. */
  readonly limit?: number;
  /** `"photos"`, `"videos"` or `"all"` (the default). */
  readonly types?: "photos" | "videos" | "all";
  /** Only this album (an id from {@linkcode getAlbums}). */
  readonly albumId?: string;
  /** Thumbnail edge in points. Default 256. */
  readonly thumbnailSize?: number;
}

/** One item from {@linkcode getRecentMedia}. */
export interface MediaItem {
  /** The PhotoKit local identifier. */
  readonly id: string;
  /** A JPEG thumbnail as a `data:` URL. */
  readonly thumbnail: string;
  /** When it was taken, ISO 8601. */
  readonly createdAt: string;
  /** Its full width in pixels. */
  readonly width: number;
  /** Its full height in pixels. */
  readonly height: number;
  /** A video's length in seconds. */
  readonly duration?: number;
}

/** The JS side of `@capacitor-community/media` (9.x, Capacitor 8). */
interface MediaPlugin {
  savePhoto(options: { path: string; albumIdentifier?: string; fileName?: string }): Promise<
    { filePath?: string; identifier?: string }
  >;
  saveVideo(options: { path: string; albumIdentifier?: string; fileName?: string }): Promise<
    { filePath?: string; identifier?: string }
  >;
  getAlbums(): Promise<{ albums?: Array<{ identifier?: string; name?: string; type?: string }> }>;
  createAlbum(options: { name: string }): Promise<void>;
  getMedias(options: {
    quantity?: number;
    thumbnailWidth?: number;
    thumbnailHeight?: number;
    types?: string;
    albumIdentifier?: string;
    sort?: Array<{ key: string; ascending: boolean }>;
  }): Promise<{
    medias?: Array<{
      identifier?: string;
      data?: string;
      creationDate?: string;
      duration?: number;
      fullWidth?: number;
      fullHeight?: number;
    }>;
  }>;
}

/** Android's album name when {@linkcode SaveToLibraryOptions.album} is left out. */
const DEFAULT_ANDROID_ALBUM = "Saved";

/** The `Media` plugin, when the shell has it. */
function mediaPlugin(): MediaPlugin | undefined {
  return nativePlugin<MediaPlugin>("Media", ["savePhoto", "saveVideo", "getAlbums", "createAlbum"]);
}

/** A plugin album, normalized; null without an id. */
function toAlbum(raw: { identifier?: string; name?: string; type?: string }): MediaAlbum | null {
  if (typeof raw.identifier !== "string" || raw.identifier === "") return null;
  const type: Pick<MediaAlbum, "type"> =
    raw.type === "user" || raw.type === "smart" || raw.type === "shared" ? { type: raw.type } : {};
  return { id: raw.identifier, name: String(raw.name ?? ""), ...type };
}

/**
 * The albums of the photo library the app can see: on iOS every album (after the user grants
 * full access), on Android the albums this app created (the plugin's default, non-gallery
 * mode).
 *
 * @returns The albums; `[]` on the web.
 * @example
 * ```ts
 * import { getAlbums } from "denext/mobile";
 * const names = (await getAlbums()).map((a) => a.name);
 * ```
 */
export async function getAlbums(): Promise<MediaAlbum[]> {
  const plugin = mediaPlugin();
  if (!plugin) return [];
  const { albums } = await plugin.getAlbums() ?? {};
  return (albums ?? []).map(toAlbum).filter((a): a is MediaAlbum => a !== null);
}

/**
 * Create an album (a no-op when one with that name exists).
 *
 * @param name The album's name.
 * @returns The album. It rejects on the web, where there is no photo library.
 * @example
 * ```ts
 * import { createAlbum } from "denext/mobile";
 * const album = await createAlbum("Receipts");
 * ```
 */
export async function createAlbum(name: string): Promise<MediaAlbum> {
  const plugin = mediaPlugin();
  if (!plugin) throw new Error("createAlbum: no photo library here (not in the native shell)");
  const existing = (await getAlbums()).find((a) => a.name === name && a.type !== "smart");
  if (existing) return existing;
  await plugin.createAlbum({ name });
  const created = (await getAlbums()).find((a) => a.name === name);
  if (!created) throw new Error(`createAlbum: "${name}" was not found after creating it`);
  return created;
}

/** The album id to save into, or undefined for iOS's camera roll. */
async function targetAlbum(options: SaveToLibraryOptions): Promise<string | undefined> {
  const name = options.album ??
    (nativePlatform() === "android" ? DEFAULT_ANDROID_ALBUM : undefined);
  return name === undefined ? undefined : (await createAlbum(name)).id;
}

/** Download `source` in the browser through a temporary `<a download>`. */
function download(source: string, fileName: string | undefined): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) throw new Error("saveToLibrary: no document to download from (SSR)");
  const a = doc.createElement("a");
  a.href = source;
  a.download = fileName ?? "";
  a.rel = "noopener";
  a.style.display = "none";
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Save a photo (or GIF) or video to the device's photo library.
 *
 * - Inside the native shell with `@capacitor-community/media`: iOS adds it to the camera roll
 *   (or `album`) and asks for add-only photo access the first time; Android saves it into an
 *   album the app owns (`album`, default `"Saved"`), with no permission prompt.
 * - On the web the browser downloads the file (`fileName`, when the source allows it).
 *
 * @param source What to save: an https URL, a `data:` URL, or a local file path / URL (for
 * example `webPath` from `pickImage`, or a `downloadToFile` result).
 * @param options `kind` (`"photo"`, the default, or `"video"`), `album` and `fileName`.
 * @returns Where it went. It rejects when access is refused (code `accessDenied`) or the
 * source cannot be read.
 * @example
 * ```ts
 * import { saveToLibrary } from "denext/mobile";
 * await saveToLibrary("https://cdn.example.com/poster.jpg", { album: "Posters" });
 * ```
 */
export async function saveToLibrary(
  source: string,
  options: SaveToLibraryOptions = {},
): Promise<SavedMedia> {
  if (typeof source !== "string" || source === "") {
    throw new TypeError("saveToLibrary: pass a URL, data: URL or file path");
  }
  const plugin = mediaPlugin();
  if (!plugin) {
    download(source, options.fileName);
    return { savedTo: "download" };
  }
  const albumIdentifier = await targetAlbum(options);
  const request = {
    path: source,
    ...(albumIdentifier ? { albumIdentifier } : {}),
    ...(options.fileName ? { fileName: options.fileName } : {}),
  };
  const saved = options.kind === "video"
    ? await plugin.saveVideo(request)
    : await plugin.savePhoto(request);
  return {
    savedTo: "library",
    ...(typeof saved?.identifier === "string" ? { id: saved.identifier } : {}),
    ...(typeof saved?.filePath === "string" ? { path: saved.filePath } : {}),
  };
}

/**
 * The newest photos and videos in the library, with thumbnails (iOS only: Android's plugin has
 * no media query, and the web has no library).
 *
 * @param options How many, which types, which album, and the thumbnail size.
 * @returns The items, newest first; `[]` on Android and the web. It rejects when photo access
 * is refused.
 * @example
 * ```tsx
 * import { getRecentMedia } from "denext/mobile";
 * const items = await getRecentMedia({ limit: 12, types: "photos" });
 * // <img src={items[0].thumbnail} />
 * ```
 */
export async function getRecentMedia(options: RecentMediaOptions = {}): Promise<MediaItem[]> {
  const plugin = nativePlatform() === "ios"
    ? nativePlugin<MediaPlugin>("Media", ["getMedias"])
    : undefined;
  if (!plugin) return [];
  const size = options.thumbnailSize ?? 256;
  const { medias } = await plugin.getMedias({
    quantity: options.limit ?? 25,
    thumbnailWidth: size,
    thumbnailHeight: size,
    types: options.types ?? "all",
    sort: [{ key: "creationDate", ascending: false }],
    ...(options.albumId ? { albumIdentifier: options.albumId } : {}),
  }) ?? {};
  return (medias ?? []).flatMap((m) =>
    typeof m.identifier === "string"
      ? [{
        id: m.identifier,
        thumbnail: typeof m.data === "string" && !m.data.startsWith("data:")
          ? `data:image/jpeg;base64,${m.data}`
          : String(m.data ?? ""),
        createdAt: String(m.creationDate ?? ""),
        width: Number(m.fullWidth ?? 0),
        height: Number(m.fullHeight ?? 0),
        ...(typeof m.duration === "number" && m.duration > 0 ? { duration: m.duration } : {}),
      }]
      : []
  );
}
