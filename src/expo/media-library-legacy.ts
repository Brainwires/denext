/**
 * `expo-media-library/legacy` for denext: Expo's function API (and, before SDK 57, the main
 * entry's) over `denext/mobile`'s {@linkcode saveToLibrary} / {@linkcode getAlbums} /
 * {@linkcode createAlbum} / {@linkcode getRecentMedia} (`@capacitor-community/media`: `denext
 * mobile add media-library`) and the `photos` permission. `saveToLibraryAsync` /
 * `createAssetAsync` save into the photo library in the shell and download the file in a
 * browser; `getAlbumsAsync`, `getAlbumAsync` and `createAlbumAsync` list and make albums;
 * `getAssetsAsync` lists the newest photos and videos (iOS: `uri` is a thumbnail `data:` URL, and
 * there is one page: `first` items, `hasNextPage` false). Moving, deleting and favouriting
 * assets, asset details, moments and the change listener are not provided (they reject, or never
 * fire). `denext/expo/media-library` is SDK 57's class API over the same calls.
 *
 * @example
 * ```ts
 * import * as MediaLibrary from "denext/expo/media-library/legacy";
 *
 * const { granted } = await MediaLibrary.requestPermissionsAsync(true);
 * if (granted) await MediaLibrary.saveToLibraryAsync(fileUri);
 * ```
 *
 * @module
 */

import {
  createAlbum,
  getAlbums,
  getRecentMedia,
  type MediaAlbum,
  type MediaItem,
  saveToLibrary,
} from "../mobile/media-library.ts";
import { checkPermission, type PermissionState, requestPermission } from "../mobile/permissions.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import {
  createPermissionHook,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse as ExpoPermissionResponse,
  permissionResponse,
  PermissionStatus,
  type Subscription,
  subscription,
  unavailable,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, Subscription };

/** The media library permission, with how much of the library it covers. */
export type PermissionResponse = ExpoPermissionResponse & {
  /** `"all"`, `"limited"` (selected photos) or `"none"`. */
  accessPrivileges?: "all" | "limited" | "none";
};

/** Android 13+'s media permission kinds (the plugin asks for photos and videos together). */
export type GranularPermission = "audio" | "photo" | "video";
/** An asset's kind. */
export type MediaTypeValue = "audio" | "photo" | "video" | "unknown" | "pairedVideo";
/** A sort key (only the newest-first order is provided). */
export type SortByKey =
  | "default"
  | "mediaType"
  | "width"
  | "height"
  | "creationTime"
  | "modificationTime"
  | "duration";
/** A sort key, optionally with its direction. */
export type SortByValue = [SortByKey, boolean] | SortByKey;

/** An asset. */
export type Asset = {
  /** Its id. */
  id: string;
  /** Its file name (the id where the platform gives none). */
  filename: string;
  /** Its URI: a thumbnail `data:` URL from `getAssetsAsync`. */
  uri: string;
  /** Its kind. */
  mediaType: MediaTypeValue;
  /** Its width in pixels. */
  width: number;
  /** Its height in pixels. */
  height: number;
  /** When it was taken, ms since the epoch. */
  creationTime: number;
  /** When it last changed (the creation time here). */
  modificationTime: number;
  /** A video's length in seconds (0 for a photo). */
  duration: number;
  /** The album it was listed from. */
  albumId?: string;
};

/** An album. */
export type Album = {
  /** Its id. */
  id: string;
  /** Its name. */
  title: string;
  /** How many assets it holds (0: not reported here). */
  assetCount: number;
  /** `"album"` or `"smartAlbum"`. */
  type?: "album" | "moment" | "smartAlbum";
  /** Unused (0). */
  startTime: number;
  /** Unused (0). */
  endTime: number;
};

/** Options of {@linkcode getAlbumsAsync}. */
export type AlbumsOptions = {
  /** Include the smart albums (Favorites, Recents, …). */
  includeSmartAlbums?: boolean;
};

/** Options of {@linkcode getAssetsAsync}. */
export type AssetsOptions = {
  /** How many (default 20). */
  first?: number;
  /** Paging cursor (not supported: there is one page). */
  after?: AssetRef;
  /** Only this album. */
  album?: AlbumRef;
  /** Ignored: newest first. */
  sortBy?: SortByValue[] | SortByValue;
  /** `photo`, `video` or both. */
  mediaType?: MediaTypeValue[] | MediaTypeValue;
};

/** A page of assets. */
export type PagedInfo<T> = {
  /** The assets. */
  assets: T[];
  /** The last asset's id. */
  endCursor: string;
  /** Always false (one page). */
  hasNextPage: boolean;
  /** How many were returned. */
  totalCount: number;
};

/** An asset or its id. */
export type AssetRef = Asset | string;
/** An album or its id. */
export type AlbumRef = Album | string;

/** The media kinds. */
export const MediaType = {
  audio: "audio",
  photo: "photo",
  video: "video",
  unknown: "unknown",
} as const;

/** The sort keys. */
export const SortBy = {
  default: "default",
  mediaType: "mediaType",
  width: "width",
  height: "height",
  creationTime: "creationTime",
  modificationTime: "modificationTime",
  duration: "duration",
} as const;

const PKG = "expo-media-library/legacy";
const HINT = "denext maps saving, albums and the newest assets only.";

/**
 * Whether the photo library plugin is in this shell.
 *
 * @returns Whether saving reaches the library (a browser downloads instead).
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(nativePlugin("Media", ["savePhoto"]) !== undefined);
}

/** A denext permission state as Expo's answer. */
function libraryResponse(state: PermissionState | undefined): PermissionResponse {
  const status = state === "granted" || state === "limited"
    ? PermissionStatus.GRANTED
    : state === "denied" || state === "blocked"
    ? PermissionStatus.DENIED
    : PermissionStatus.UNDETERMINED;
  return {
    ...permissionResponse(status),
    canAskAgain: state !== "blocked",
    accessPrivileges: state === "granted" ? "all" : state === "limited" ? "limited" : "none",
  };
}

/** A permission read that treats "nothing can answer" as undetermined. */
async function read(fn: () => Promise<PermissionState>): Promise<PermissionState | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * The photo library permission.
 *
 * @param _writeOnly Ignored (the plugin asks for read and write together).
 * @param _granularPermissions Ignored.
 * @returns The permission.
 */
export async function getPermissionsAsync(
  _writeOnly?: boolean,
  _granularPermissions?: GranularPermission[],
): Promise<PermissionResponse> {
  return libraryResponse(await read(() => checkPermission("photos")));
}

/**
 * Ask for the photo library permission.
 *
 * @param _writeOnly Ignored (the plugin asks for read and write together).
 * @param _granularPermissions Ignored.
 * @returns The answer.
 */
export async function requestPermissionsAsync(
  _writeOnly?: boolean,
  _granularPermissions?: GranularPermission[],
): Promise<PermissionResponse> {
  return libraryResponse(await read(() => requestPermission("photos")));
}

/** Hook form of the permission: `[response, request, get]`. */
export const usePermissions: (
  options?: PermissionHookOptions<
    { writeOnly?: boolean; granularPermissions?: GranularPermission[] }
  >,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = /* @__PURE__ */ createPermissionHook({
  getMethod: () => getPermissionsAsync(),
  requestMethod: () => requestPermissionsAsync(),
});

/**
 * Let the user change the limited selection: not available (use the system Settings).
 *
 * @param _mediaTypes Ignored.
 * @returns Rejects.
 */
export function presentPermissionsPickerAsync(_mediaTypes?: ("photo" | "video")[]): Promise<void> {
  return Promise.reject(unavailable(PKG, "presentPermissionsPickerAsync", HINT));
}

/** `"video"` for a video file name, else `"photo"`. */
function kindOf(uri: string): "photo" | "video" {
  return /\.(mp4|mov|m4v|webm|3gp|mkv)(\?|#|$)/i.test(uri) ? "video" : "photo";
}

/** An album ref's name, looked up by id when it is an id. */
async function albumName(album: AlbumRef): Promise<string | undefined> {
  if (typeof album !== "string") return album.title;
  return (await getAlbums()).find((a) => a.id === album || a.name === album)?.name;
}

/**
 * Save `localUri` to the library (a browser downloads it).
 *
 * @param localUri A file URI, URL or `data:` URL.
 * @returns Settles once saved.
 */
export async function saveToLibraryAsync(localUri: string): Promise<void> {
  await saveToLibrary(localUri, { kind: kindOf(localUri) });
}

/**
 * Save `localUri` to the library, into `album` when given.
 *
 * @param localUri A file URI, URL or `data:` URL.
 * @param album The album (or its id).
 * @returns The saved asset (its id where the platform reports one).
 */
export async function createAssetAsync(localUri: string, album?: AlbumRef): Promise<Asset> {
  const kind = kindOf(localUri);
  const name = album === undefined ? undefined : await albumName(album);
  const saved = await saveToLibrary(localUri, { kind, ...(name ? { album: name } : {}) });
  const now = Date.now();
  return {
    id: saved.id ?? saved.path ?? localUri,
    filename: (saved.path ?? localUri).split(/[\\/]/).pop() ?? "",
    uri: saved.path ?? localUri,
    mediaType: kind,
    width: 0,
    height: 0,
    creationTime: now,
    modificationTime: now,
    duration: 0,
  };
}

/** Expo's album for denext's. */
function toAlbum(a: MediaAlbum): Album {
  return {
    id: a.id,
    title: a.name,
    assetCount: 0,
    type: a.type === "smart" ? "smartAlbum" : "album",
    startTime: 0,
    endTime: 0,
  };
}

/**
 * The albums.
 *
 * @param options Whether to include smart albums.
 * @returns The albums (none outside the shell).
 */
export async function getAlbumsAsync(options: AlbumsOptions = {}): Promise<Album[]> {
  const albums = await getAlbums();
  return albums.filter((a) => options.includeSmartAlbums || a.type !== "smart").map(toAlbum);
}

/**
 * The album named `title`, or null.
 *
 * @param title The name.
 * @returns The album, or null.
 */
export async function getAlbumAsync(title: string): Promise<Album | null> {
  const found = (await getAlbums()).find((a) => a.name === title);
  return found ? toAlbum(found) : null;
}

/**
 * Make an album (or return the one of that name), and save `initialAssetLocalUri` into it.
 *
 * @param albumName The name.
 * @param _asset An asset to add (not supported: pass `initialAssetLocalUri`).
 * @param _copyAsset Ignored.
 * @param initialAssetLocalUri A file to save into the new album.
 * @returns The album.
 */
export async function createAlbumAsync(
  albumName: string,
  _asset?: AssetRef,
  _copyAsset?: boolean,
  initialAssetLocalUri?: string,
): Promise<Album> {
  const album = await createAlbum(albumName);
  if (initialAssetLocalUri) {
    await saveToLibrary(initialAssetLocalUri, {
      kind: kindOf(initialAssetLocalUri),
      album: albumName,
    });
  }
  return toAlbum(album);
}

/** The plugin's `types` filter for Expo's `mediaType` option. */
function mediaTypes(value: AssetsOptions["mediaType"]): "photos" | "videos" | "all" {
  const list = value === undefined ? ["photo"] : Array.isArray(value) ? value : [value];
  const photos = list.includes("photo");
  const videos = list.includes("video");
  return photos && !videos ? "photos" : videos && !photos ? "videos" : "all";
}

/** Expo's asset for a listed item. */
function toAsset(item: MediaItem, albumId: string | undefined): Asset {
  const time = Date.parse(item.createdAt) || 0;
  return {
    id: item.id,
    filename: item.id,
    uri: item.thumbnail,
    mediaType: item.duration ? "video" : "photo",
    width: item.width,
    height: item.height,
    creationTime: time,
    modificationTime: time,
    duration: item.duration ?? 0,
    ...(albumId ? { albumId } : {}),
  };
}

/**
 * The newest assets (iOS shell; none elsewhere).
 *
 * @param options How many, which album, which kinds.
 * @returns One page of assets.
 */
export async function getAssetsAsync(options: AssetsOptions = {}): Promise<PagedInfo<Asset>> {
  const albumId = typeof options.album === "string" ? options.album : options.album?.id;
  const items = await getRecentMedia({
    limit: options.first ?? 20,
    types: mediaTypes(options.mediaType),
    ...(albumId ? { albumId } : {}),
  });
  const assets = items.map((item) => toAsset(item, albumId));
  return {
    assets,
    endCursor: assets.at(-1)?.id ?? "",
    hasNextPage: false,
    totalCount: assets.length,
  };
}

/** A call that is not provided: rejects with Expo's unavailability error. */
function notProvided<T>(name: string): Promise<T> {
  return Promise.reject(unavailable(PKG, name, HINT));
}

/**
 * Add assets to an album: not provided.
 *
 * @returns Rejects.
 */
export function addAssetsToAlbumAsync(
  _assets: AssetRef[] | AssetRef,
  _album: AlbumRef,
  _copy?: boolean,
): Promise<boolean> {
  return notProvided("addAssetsToAlbumAsync");
}

/**
 * Remove assets from an album: not provided.
 *
 * @returns Rejects.
 */
export function removeAssetsFromAlbumAsync(
  _assets: AssetRef[] | AssetRef,
  _album: AlbumRef,
): Promise<boolean> {
  return notProvided("removeAssetsFromAlbumAsync");
}

/**
 * Delete assets: not provided.
 *
 * @returns Rejects.
 */
export function deleteAssetsAsync(_assets: AssetRef[] | AssetRef): Promise<boolean> {
  return notProvided("deleteAssetsAsync");
}

/**
 * An asset's details: not provided.
 *
 * @returns Rejects.
 */
export function getAssetInfoAsync(_asset: AssetRef, _options?: object): Promise<Asset> {
  return notProvided("getAssetInfoAsync");
}

/**
 * An asset's content URI: not provided.
 *
 * @returns Rejects.
 */
export function getAssetContentUriAsync(_asset: AssetRef): Promise<string> {
  return notProvided("getAssetContentUriAsync");
}

/**
 * Delete albums: not provided.
 *
 * @returns Rejects.
 */
export function deleteAlbumsAsync(
  _albums: AlbumRef[] | AlbumRef,
  _assetRemove?: boolean,
): Promise<boolean> {
  return notProvided("deleteAlbumsAsync");
}

/**
 * The moments: not provided.
 *
 * @returns Rejects.
 */
export function getMomentsAsync(): Promise<Album[]> {
  return notProvided("getMomentsAsync");
}

/**
 * Favourite an asset: not provided.
 *
 * @returns Rejects.
 */
export function setAssetFavoriteAsync(_asset: AssetRef, _isFavorite: boolean): Promise<boolean> {
  return notProvided("setAssetFavoriteAsync");
}

/**
 * Whether an album needs Android's scoped-storage migration: never here.
 *
 * @returns false.
 */
export function albumNeedsMigrationAsync(_album: AlbumRef): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * Migrate an album for scoped storage: nothing to do.
 *
 * @returns Settles at once.
 */
export function migrateAlbumIfNeededAsync(_album: AlbumRef): Promise<void> {
  return Promise.resolve();
}

/**
 * Listen for library changes: never fires here.
 *
 * @param _listener Never called.
 * @returns A subscription.
 */
export function addListener(_listener: (event: object) => void): Subscription {
  return subscription(() => {});
}

/**
 * Remove a change listener.
 *
 * @param sub What {@linkcode addListener} returned.
 */
export function removeSubscription(sub: Subscription): void {
  sub.remove();
}

/** Remove every change listener (there are none to call). */
export function removeAllListeners(): void {}
