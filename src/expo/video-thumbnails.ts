/**
 * `expo-video-thumbnails` for denext: a frame of a video as a JPEG, drawn by the page — a
 * `<video>` element seeked to `time`, painted on a `<canvas>`, and returned as a `blob:` URL.
 * It runs the same in the Capacitor shell's WebView and in a browser (Expo's own web build
 * throws).
 *
 * The video must be one the page may read pixels from: same-origin, a `blob:` / `data:` URL,
 * a `capacitor://` / `https://localhost` file of the shell, or a cross-origin URL served with
 * CORS. `headers` are sent by fetching the video first (it is then read from memory). The
 * format is what the WebView can decode (H.264 / HEVC MP4 on iOS, H.264 / VP9 on Android).
 *
 * @example
 * ```ts
 * import { getThumbnailAsync } from "denext/expo/video-thumbnails";
 *
 * const { uri, width, height } = await getThumbnailAsync(videoUrl, { time: 15000, quality: 0.8 });
 * ```
 *
 * @module
 */

import { CodedError } from "./internal/common.ts";

/** Options for {@linkcode getThumbnailAsync}. */
export interface VideoThumbnailsOptions {
  /** JPEG quality, 0–1 (default 1). */
  quality?: number;
  /** The frame's time in milliseconds (default 0). */
  time?: number;
  /** HTTP headers to send when fetching the video. */
  headers?: Record<string, string>;
}

/** The thumbnail. */
export interface VideoThumbnailsResult {
  /** A `blob:` URL of the JPEG. */
  uri: string;
  /** Its width in pixels (the video's). */
  width: number;
  /** Its height in pixels (the video's). */
  height: number;
}

/** The DOM this needs, or null (SSR, a worker). */
function dom(): Document | null {
  const doc = (globalThis as { document?: Document }).document;
  return typeof doc?.createElement === "function" ? doc : null;
}

/** A failed thumbnail, as Expo reports it. */
function failure(message: string): CodedError {
  return new CodedError("ERR_VIDEO_THUMBNAILS", `denext/expo: ${message}`);
}

/** Resolve on `event` of `target`, reject on its `error`. */
function once(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      reject(failure(`the video could not be loaded (${target.error?.message ?? "error"})`));
    };
    target.addEventListener(event, done);
    target.addEventListener("error", fail);
  });
}

/** The video's source: the URL itself, or (with headers) a `blob:` URL of its fetched bytes. */
async function source(url: string, headers?: Record<string, string>): Promise<{
  src: string;
  release: () => void;
}> {
  if (!headers || Object.keys(headers).length === 0) return { src: url, release: () => {} };
  const res = await fetch(url, { headers });
  if (!res.ok) throw failure(`fetching the video failed (HTTP ${res.status})`);
  const src = URL.createObjectURL(await res.blob());
  return { src, release: () => URL.revokeObjectURL(src) };
}

/** The canvas as a JPEG blob. */
function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(failure("the frame could not be encoded")),
      "image/jpeg",
      quality,
    );
  });
}

/**
 * A frame of the video at `sourceFilename` as a JPEG.
 *
 * @param sourceFilename The video's URL.
 * @param options The frame's time, the JPEG quality and request headers.
 * @returns The thumbnail's `blob:` URL and size.
 * @throws A `CodedError` when there is no DOM, the video cannot be loaded or decoded, or its
 *   pixels may not be read (a cross-origin video without CORS).
 */
export async function getThumbnailAsync(
  sourceFilename: string,
  options: VideoThumbnailsOptions = {},
): Promise<VideoThumbnailsResult> {
  const doc = dom();
  if (!doc) {
    throw new CodedError(
      "ERR_UNAVAILABLE",
      "denext/expo: expo-video-thumbnails needs a page (a <video> and a <canvas>).",
    );
  }
  const { src, release } = await source(sourceFilename, options.headers);
  const video = doc.createElement("video");
  try {
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    const loaded = once(video, "loadeddata");
    video.src = src;
    await loaded;
    const seconds = Math.max(0, (options.time ?? 0) / 1000);
    const target = Number.isFinite(video.duration) ? Math.min(seconds, video.duration) : seconds;
    if (target > 0 || video.currentTime !== 0) {
      const seeked = once(video, "seeked");
      video.currentTime = target;
      await seeked;
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw failure("the video has no picture to draw");
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw failure("no 2D canvas");
    ctx.drawImage(video, 0, 0, width, height);
    let blob: Blob;
    try {
      blob = await jpeg(canvas, Math.max(0, Math.min(1, options.quality ?? 1)));
    } catch (err) {
      if (err instanceof CodedError) throw err;
      throw failure(`the frame may not be read (a cross-origin video needs CORS): ${err}`);
    }
    return { uri: URL.createObjectURL(blob), width, height };
  } finally {
    video.removeAttribute("src");
    video.load?.();
    release();
  }
}
