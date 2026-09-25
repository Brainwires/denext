/**
 * `expo-asset` for denext: `Asset.fromModule` for bundled files. In a denext build a
 * `require("./logo.png")` / `import logo from "./logo.png"` is already the file's URL, so an
 * asset is that URL; `downloadAsync` has nothing to download and marks it ready.
 *
 * Metro's numeric asset ids have no counterpart here: `fromModule` takes a URL string or
 * `{ uri }` and throws for a number.
 *
 * @example
 * ```ts
 * import { Asset } from "denext/expo/asset";
 *
 * const logo = await Asset.fromModule(logoUrl).downloadAsync();
 * console.log(logo.localUri);
 * ```
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";

/** The URL prefix of Android's embedded resources (kept for API compatibility). */
export const ANDROID_EMBEDDED_URL_BASE_RESOURCE = "file:///android_res/";

/** What an {@linkcode Asset} is made from. */
export interface AssetDescriptor {
  /** The file name, without extension. */
  name: string;
  /** The extension (`"png"`). */
  type: string;
  /** A content hash. */
  hash?: string | null;
  /** The URL. */
  uri: string;
  /** The width, for an image. */
  width?: number | null;
  /** The height, for an image. */
  height?: number | null;
}

/** A module reference: a bundled file's URL, `{ uri }`, or (unsupported) a Metro id. */
export type AssetModule = string | number | { uri: string; width?: number; height?: number };

/** `uri`'s file name and extension. */
function nameAndType(uri: string): { name: string; type: string } {
  const file = decodeURIComponent(uri.split(/[?#]/)[0].split("/").pop() ?? "");
  const dot = file.lastIndexOf(".");
  return dot > 0
    ? { name: file.slice(0, dot), type: file.slice(dot + 1) }
    : { name: file, type: "" };
}

/** A bundled file. */
export class Asset {
  /** The file name. */
  name: string;
  /** The extension. */
  type: string;
  /** A content hash (none here). */
  hash: string | null;
  /** The URL. */
  uri: string;
  /** The loadable URL, once downloaded. */
  localUri: string | null = null;
  /** The width, for an image. */
  width: number | null;
  /** The height, for an image. */
  height: number | null;
  /** Whether {@linkcode Asset.downloadAsync} ran. */
  downloaded = false;

  /**
   * Create it.
   *
   * @param descriptor The asset's name, type and URL.
   */
  constructor({ name, type, hash = null, uri, width = null, height = null }: AssetDescriptor) {
    this.name = name;
    this.type = type;
    this.hash = hash;
    this.uri = uri;
    this.width = width;
    this.height = height;
  }

  /**
   * The asset for a bundled module.
   *
   * @param moduleId The file's URL or `{ uri }`.
   * @returns The asset.
   */
  static fromModule(moduleId: AssetModule): Asset {
    if (typeof moduleId === "number") {
      throw new TypeError(
        "Asset.fromModule: numeric Metro asset ids are not supported in a denext build " +
          "(import the file, which gives its URL)",
      );
    }
    if (typeof moduleId === "string") return Asset.fromURI(moduleId);
    const asset = Asset.fromURI(moduleId.uri);
    asset.width = moduleId.width ?? null;
    asset.height = moduleId.height ?? null;
    return asset;
  }

  /**
   * The asset for a URL.
   *
   * @param uri The URL.
   * @returns The asset.
   */
  static fromURI(uri: string): Asset {
    return new Asset({ ...nameAndType(uri), uri });
  }

  /**
   * The assets for several modules, downloaded.
   *
   * @param moduleId One module or several.
   * @returns The assets.
   */
  static loadAsync(moduleId: AssetModule | AssetModule[]): Promise<Asset[]> {
    return Promise.all([moduleId].flat().map((m) => Asset.fromModule(m).downloadAsync()));
  }

  /** Mark the asset ready (its URL is already loadable): `localUri` becomes `uri`. */
  downloadAsync(): Promise<this> {
    this.localUri = this.uri;
    this.downloaded = true;
    return Promise.resolve(this);
  }
}

/**
 * Hook form of {@linkcode Asset.loadAsync}.
 *
 * @param moduleIds One module or several.
 * @returns `[assets, error]`: assets once loaded, the error if it failed.
 */
export function useAssets(
  moduleIds: AssetModule | AssetModule[],
): [Asset[] | undefined, Error | undefined] {
  const [state, setState] = useState<[Asset[] | undefined, Error | undefined]>([
    undefined,
    undefined,
  ]);
  const key = JSON.stringify(moduleIds);
  useEffect(() => {
    let active = true;
    Asset.loadAsync(moduleIds).then(
      (assets) => active && setState([assets, undefined]),
      (err: Error) => active && setState([undefined, err]),
    );
    return () => void (active = false);
  }, [key]);
  return state;
}
