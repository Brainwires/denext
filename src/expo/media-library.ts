/**
 * `expo-media-library` for denext: SDK 57's class API (`Asset`, `Album`, `Query` and the
 * `MediaType` / `AssetField` / `MediaSubtype` enums) over `denext/mobile`'s
 * {@linkcode saveToLibrary} / {@linkcode getAlbums} / {@linkcode createAlbum} /
 * {@linkcode getRecentMedia} (`@capacitor-community/media`: `denext mobile add media-library`)
 * and the `photos` permission, plus the deprecated functions, which work here (Expo's throw;
 * `denext/expo/media-library/legacy` has them too).
 *
 * `Asset.create(file, album?)` saves into the library in the shell (a browser downloads the
 * file); `Album.create` / `get` / `getAll` list and make albums; a `Query` with `limit`, `album`
 * and a `MEDIA_TYPE` filter lists the newest photos and videos (iOS), newest first. An asset
 * knows what the listing reported (`getUri()` is a thumbnail `data:` URL, and its size, media
 * type, creation time and duration); the rest of its getters, deleting, moving and favouriting
 * reject with `ERR_UNAVAILABLE`, and the change listener never fires.
 *
 * @example
 * ```ts
 * import { Asset, requestPermissionsAsync } from "denext/expo/media-library";
 *
 * if ((await requestPermissionsAsync(true)).granted) await Asset.create(fileUri);
 * ```
 *
 * @module
 */

import {
  createAlbum,
  getAlbums,
  getRecentMedia,
  type MediaItem,
  saveToLibrary,
} from "../mobile/media-library.ts";
import { unavailable } from "./internal/common.ts";

export {
  addAssetsToAlbumAsync,
  addListener,
  albumNeedsMigrationAsync,
  createAlbumAsync,
  createAssetAsync,
  deleteAlbumsAsync,
  deleteAssetsAsync,
  getAlbumAsync,
  getAlbumsAsync,
  getAssetContentUriAsync,
  getAssetInfoAsync,
  getAssetsAsync,
  getMomentsAsync,
  getPermissionsAsync,
  isAvailableAsync,
  migrateAlbumIfNeededAsync,
  PermissionStatus,
  presentPermissionsPickerAsync,
  removeAllListeners,
  removeAssetsFromAlbumAsync,
  removeSubscription,
  requestPermissionsAsync,
  saveToLibraryAsync,
  setAssetFavoriteAsync,
  usePermissions,
} from "./media-library-legacy.ts";
export type {
  GranularPermission,
  PermissionExpiration,
  PermissionHookOptions,
  PermissionResponse,
  Subscription,
} from "./media-library-legacy.ts";

/** An asset's kind. */
export enum MediaType {
  /** Not known. */
  UNKNOWN = "unknown",
  /** A photo. */
  IMAGE = "image",
  /** Audio. */
  AUDIO = "audio",
  /** A video. */
  VIDEO = "video",
}

/** The fields a {@linkcode Query} filters and sorts by. */
export enum AssetField {
  /** When it was taken. */
  CREATION_TIME = "creationTime",
  /** When it last changed. */
  MODIFICATION_TIME = "modificationTime",
  /** Its {@linkcode MediaType}. */
  MEDIA_TYPE = "mediaType",
  /** Its width. */
  WIDTH = "width",
  /** Its height. */
  HEIGHT = "height",
  /** A video's length. */
  DURATION = "duration",
  /** Whether it is a favourite. */
  IS_FAVORITE = "isFavorite",
}

/** iOS media subtypes (none are reported here). */
export enum MediaSubtype {
  /** Portrait mode. */
  DEPTH_EFFECT = "depthEffect",
  /** HDR. */
  HDR = "hdr",
  /** Slow motion. */
  HIGH_FRAME_RATE = "highFrameRate",
  /** A Live Photo. */
  LIVE_PHOTO = "livePhoto",
  /** A panorama. */
  PANORAMA = "panorama",
  /** A screenshot. */
  SCREENSHOT = "screenshot",
  /** A stream. */
  STREAM = "stream",
  /** A time-lapse. */
  TIME_LAPSE = "timelapse",
  /** Spatial media. */
  SPATIAL_MEDIA = "spatialMedia",
  /** Cinematic video. */
  VIDEO_CINEMATIC = "videoCinematic",
}

const PKG = "expo-media-library";
const HINT = "denext maps saving, albums and the newest assets only.";

/** A call that is not provided: rejects with Expo's unavailability error. */
function notProvided<T>(name: string): Promise<T> {
  return Promise.reject(unavailable(PKG, name, HINT));
}

/** `VIDEO` for a video file name, else `IMAGE`. */
function kindOf(uri: string): MediaType {
  return /\.(mp4|mov|m4v|webm|3gp|mkv)(\?|#|$)/i.test(uri) ? MediaType.VIDEO : MediaType.IMAGE;
}

/** What is known about an asset: from the listing, or from saving it. */
interface AssetFacts {
  uri?: string;
  mediaType?: MediaType;
  width?: number;
  height?: number;
  creationTime?: number;
  duration?: number;
}

/** Each asset's known facts (made on first use). */
let facts: WeakMap<Asset, AssetFacts> | undefined;

/** An asset's known facts. */
function factsOf(asset: Asset): AssetFacts {
  return facts?.get(asset) ?? {};
}

/** A new asset with `known` facts. */
function assetWith(id: string, known: AssetFacts): Asset {
  const asset = new Asset(id);
  (facts ??= new WeakMap()).set(asset, known);
  return asset;
}

/** A fact, or a rejection when the platform did not report it. */
function fact<T>(value: T | undefined, name: string): Promise<T> {
  return value === undefined ? notProvided(`Asset.${name}`) : Promise.resolve(value);
}

/** An asset in the photo library. */
export class Asset {
  /** Its id (a PhotoKit local identifier on iOS). */
  id: string;

  /**
   * An asset by id.
   *
   * @param id Its id.
   */
  constructor(id: string) {
    this.id = id;
  }

  /** When it was taken (ms since the epoch). */
  getCreationTime(): Promise<number | null> {
    return Promise.resolve(factsOf(this).creationTime ?? null);
  }

  /** A video's length in seconds (null for a photo). */
  getDuration(): Promise<number | null> {
    return Promise.resolve(factsOf(this).duration ?? null);
  }

  /** Its file name (its id: the platform reports none). */
  getFilename(): Promise<string> {
    return Promise.resolve(factsOf(this).uri?.split(/[\\/]/).pop() || this.id);
  }

  /** Its height in pixels. */
  getHeight(): Promise<number> {
    return fact(factsOf(this).height, "getHeight");
  }

  /** Its width in pixels. */
  getWidth(): Promise<number> {
    return fact(factsOf(this).width, "getWidth");
  }

  /** Its kind. */
  getMediaType(): Promise<MediaType> {
    return Promise.resolve(factsOf(this).mediaType ?? MediaType.UNKNOWN);
  }

  /** Its subtypes (none are reported here). */
  getMediaSubtypes(): Promise<MediaSubtype[]> {
    return Promise.resolve([]);
  }

  /** Its URI: a thumbnail `data:` URL from a listing, the saved file after `create`. */
  getUri(): Promise<string> {
    return fact(factsOf(this).uri, "getUri");
  }

  /** When it last changed (the creation time here). */
  getModificationTime(): Promise<number | null> {
    return this.getCreationTime();
  }

  /** A Live Photo's video (not provided). */
  getLivePhotoVideoUri(): Promise<string | null> {
    return notProvided("Asset.getLivePhotoVideoUri");
  }

  /** Whether it is only in iCloud (not provided). */
  getIsInCloud(): Promise<boolean> {
    return notProvided("Asset.getIsInCloud");
  }

  /** Its EXIF orientation (not provided). */
  getOrientation(): Promise<number | null> {
    return notProvided("Asset.getOrientation");
  }

  /** Its shape (not provided). */
  getShape(): Promise<null> {
    return notProvided("Asset.getShape");
  }

  /** Everything about it (not provided). */
  getInfo(): Promise<never> {
    return notProvided("Asset.getInfo");
  }

  /** The albums holding it (not provided). */
  getAlbums(): Promise<Album[]> {
    return notProvided("Asset.getAlbums");
  }

  /** Where it was taken (not provided). */
  getLocation(): Promise<null> {
    return notProvided("Asset.getLocation");
  }

  /** Its EXIF data (not provided). */
  getExif(): Promise<{ [key: string]: unknown }> {
    return notProvided("Asset.getExif");
  }

  /** Delete it (not provided). */
  delete(): Promise<void> {
    return notProvided("Asset.delete");
  }

  /** Whether it is a favourite (not provided). */
  getFavorite(): Promise<boolean> {
    return notProvided("Asset.getFavorite");
  }

  /** Mark it a favourite (not provided). */
  setFavorite(_isFavorite: boolean): Promise<void> {
    return notProvided("Asset.setFavorite");
  }

  /**
   * Save `filePath` to the library (a browser downloads it), into `album` when given.
   *
   * @param filePath A file URI, URL or `data:` URL.
   * @param album The album.
   * @returns The saved asset (its id where the platform reports one).
   */
  static async create(filePath: string, album?: Album): Promise<Asset> {
    const mediaType = kindOf(filePath);
    const name = album ? await album.getTitle() : undefined;
    const saved = await saveToLibrary(filePath, {
      kind: mediaType === MediaType.VIDEO ? "video" : "photo",
      ...(name ? { album: name } : {}),
    });
    return assetWith(saved.id ?? saved.path ?? filePath, {
      uri: saved.path ?? filePath,
      mediaType,
      creationTime: Date.now(),
    });
  }

  /**
   * Delete assets (not provided).
   *
   * @param _assets The assets.
   * @returns Rejects.
   */
  static delete(_assets: Asset[]): Promise<void> {
    return notProvided("Asset.delete");
  }
}

/** An asset from a listing. */
function listedAsset(item: MediaItem): Asset {
  return assetWith(item.id, {
    uri: item.thumbnail,
    mediaType: item.duration ? MediaType.VIDEO : MediaType.IMAGE,
    width: item.width,
    height: item.height,
    creationTime: Date.parse(item.createdAt) || undefined,
    duration: item.duration,
  });
}

/** Each album's title, as listed (made on first use). */
let titles: WeakMap<Album, string> | undefined;

/** An album with its title. */
function albumWith(id: string, title: string): Album {
  const album = new Album(id);
  (titles ??= new WeakMap()).set(album, title);
  return album;
}

/** An album in the photo library. */
export class Album {
  /** Its id. */
  id: string;

  /**
   * An album by id.
   *
   * @param id Its id.
   */
  constructor(id: string) {
    this.id = id;
  }

  /** Its newest assets (iOS; none elsewhere). */
  async getAssets(): Promise<Asset[]> {
    return (await getRecentMedia({ albumId: this.id })).map(listedAsset);
  }

  /** Its name. */
  async getTitle(): Promise<string> {
    const known = titles?.get(this);
    if (known !== undefined) return known;
    const found = (await getAlbums()).find((a) => a.id === this.id);
    if (!found) throw unavailable(PKG, "Album.getTitle", "The album was not found.");
    return found.name;
  }

  /** Delete it (not provided). */
  delete(): Promise<void> {
    return notProvided("Album.delete");
  }

  /** Add existing assets (not provided: save new files with `Asset.create(file, album)`). */
  add(_assets: Asset | Asset[]): Promise<void> {
    return notProvided("Album.add");
  }

  /** Remove assets (not provided). */
  removeAssets(_assets: Asset[]): Promise<void> {
    return notProvided("Album.removeAssets");
  }

  /**
   * Make an album (or return the one of that name). `assetsRefs` given as file paths are saved
   * into it; existing assets cannot be moved here.
   *
   * @param name The name.
   * @param assetsRefs File paths to save into it.
   * @param _moveAssets Ignored.
   * @returns The album.
   */
  static async create(
    name: string,
    assetsRefs: string[] | Asset[] = [],
    _moveAssets?: boolean,
  ): Promise<Album> {
    const made = await createAlbum(name);
    const album = albumWith(made.id, made.name);
    for (const ref of assetsRefs) {
      if (typeof ref === "string") await Asset.create(ref, album);
    }
    return album;
  }

  /**
   * Delete albums (not provided).
   *
   * @param _albums The albums.
   * @param _deleteAssets Ignored.
   * @returns Rejects.
   */
  static delete(_albums: Album[], _deleteAssets?: boolean): Promise<void> {
    return notProvided("Album.delete");
  }

  /**
   * The album named `title`, or null.
   *
   * @param title The name.
   * @returns The album, or null.
   */
  static async get(title: string): Promise<Album | null> {
    const found = (await getAlbums()).find((a) => a.name === title);
    return found ? albumWith(found.id, found.name) : null;
  }

  /**
   * Every album (none outside the shell).
   *
   * @returns The albums.
   */
  static async getAll(): Promise<Album[]> {
    return (await getAlbums()).map((a) => albumWith(a.id, a.name));
  }
}

/** The plugin's `types` for the `MEDIA_TYPE` values a query asked for. */
function listedTypes(types: readonly unknown[]): "photos" | "videos" | "all" {
  const photos = types.includes(MediaType.IMAGE);
  const videos = types.includes(MediaType.VIDEO);
  return photos && !videos ? "photos" : videos && !photos ? "videos" : "all";
}

/**
 * A query over the library: `limit`, `offset`, `album` and a `MEDIA_TYPE` filter (`eq` /
 * `within`) are applied, newest first; other filters and sort orders are not (they are
 * accepted and ignored).
 */
export class Query {
  #limit = 25;
  #offset = 0;
  #albumId: string | undefined;
  #types: readonly unknown[] = [];

  /** A query over every asset. */
  constructor() {}

  /** Only assets whose `field` is `value` (`MEDIA_TYPE` only). */
  eq(field: AssetField, value: unknown): Query {
    if (field === AssetField.MEDIA_TYPE) this.#types = [value];
    return this;
  }

  /** Only assets whose `field` is one of `values` (`MEDIA_TYPE` only). */
  within(field: AssetField, values: unknown[]): Query {
    if (field === AssetField.MEDIA_TYPE) this.#types = values;
    return this;
  }

  /** Greater than (ignored). */
  gt(_field: AssetField, _value: number): Query {
    return this;
  }

  /** Greater than or equal (ignored). */
  gte(_field: AssetField, _value: number): Query {
    return this;
  }

  /** Less than (ignored). */
  lt(_field: AssetField, _value: number): Query {
    return this;
  }

  /** Less than or equal (ignored). */
  lte(_field: AssetField, _value: number): Query {
    return this;
  }

  /** At most `limit` assets. */
  limit(limit: number): Query {
    this.#limit = limit;
    return this;
  }

  /** Skip the first `offset` assets. */
  offset(offset: number): Query {
    this.#offset = offset;
    return this;
  }

  /** The order (ignored: newest first). */
  orderBy(_sortDescriptors: unknown): Query {
    return this;
  }

  /** Only `album`'s assets. */
  album(album: Album): Query {
    this.#albumId = album.id;
    return this;
  }

  /** Run it: the matching assets (iOS; none elsewhere). */
  async exe(): Promise<Asset[]> {
    const items = await getRecentMedia({
      limit: this.#offset + this.#limit,
      types: listedTypes(this.#types),
      ...(this.#albumId ? { albumId: this.#albumId } : {}),
    });
    return items.slice(this.#offset).map(listedAsset);
  }

  /** The matching assets' metadata (not provided: use `exe()` and the asset getters). */
  exeForMetadata(): Promise<never[]> {
    return notProvided("Query.exeForMetadata");
  }
}

/**
 * Let the user change the limited selection (not provided: the system Settings).
 *
 * @param _mediaTypes Ignored.
 * @returns Rejects.
 */
export function presentPermissionsPicker(_mediaTypes?: ("photo" | "video")[]): Promise<void> {
  return notProvided("presentPermissionsPicker");
}
