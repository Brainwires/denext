// Which pipeline a page runs, decided from what its engine has. Pure: `selectPipeline` takes the
// detected capabilities (or a test's), so every fallback is unit tested without a browser.

/** How the page reaches the encoded frames a receiver gets. */
export type FrameTap = "script-transform" | "encoded-streams";

/** What draws the picture. */
export type Renderer = "webgpu" | "webgl2" | "video";

/** What the page's engine offers, as far as this pipeline cares. */
export interface Capabilities {
  /** `RTCPeerConnection` exists (WebKitGTK, Linux's system webview, has none). */
  webrtc: boolean;
  /** `RTCRtpScriptTransform` (Safari / WebKit; Chromium 141+ and Firefox too). */
  scriptTransform: boolean;
  /** `RTCRtpReceiver.prototype.createEncodedStreams` (Chromium's encoded insertable streams). */
  encodedStreams: boolean;
  /** WebCodecs' `VideoDecoder` (and `VideoFrame`). */
  webCodecs: boolean;
  /** `navigator.gpu` with an adapter (asked asynchronously; see {@link detectCapabilities}). */
  webgpu: boolean;
  /** A `webgl2` context could be made. */
  webgl2: boolean;
}

/** The chosen pipeline. `tap` is `null` when frames are not read (the `<video>` path). */
export interface Pipeline {
  tap: FrameTap | null;
  renderer: Renderer;
  /** Why it is not the full pipeline (shown in the stats overlay), else `null`. */
  fallback: string | null;
}

/** A forced choice, from the page's `?renderer=` (for testing the fallbacks on a full engine). */
export type RendererOverride = Renderer | null;

/**
 * Picks the pipeline: an encoded-frame tap (script transform first: it is the standard and has
 * key-frame requests; encoded streams on older Chromium) feeding WebCodecs, drawn by WebGPU, else
 * WebGL2. Without a tap or WebCodecs the remote track plays in a plain `<video>`. An override
 * can only step down the chain (a forced `webgpu` on an engine without it still falls back), and
 * `tapOverride` (`?tap=`) picks between the taps only when the engine has the one it names.
 */
export function selectPipeline(
  caps: Capabilities,
  override: RendererOverride = null,
  tapOverride: FrameTap | null = null,
): Pipeline {
  if (!caps.webrtc) {
    return {
      tap: null,
      renderer: "video",
      fallback: "no WebRTC in this engine",
    };
  }
  const tap = pickTap(caps, tapOverride);
  const video = (fallback: string): Pipeline => ({
    tap: null,
    renderer: "video",
    fallback,
  });
  if (override === "video") return video("<video> forced (?renderer=video)");
  if (!tap) {
    return video(
      "no encoded-frame access (RTCRtpScriptTransform / createEncodedStreams)",
    );
  }
  if (!caps.webCodecs) return video("no WebCodecs VideoDecoder");
  if (caps.webgpu && override !== "webgl2") {
    return { tap, renderer: "webgpu", fallback: null };
  }
  if (caps.webgl2) {
    return {
      tap,
      renderer: "webgl2",
      fallback: override === "webgl2" ? "WebGL2 forced (?renderer=webgl2)" : "no WebGPU adapter",
    };
  }
  return video("neither WebGPU nor WebGL2");
}

/** The tap to use: the override when the engine has it, else the script transform first. */
function pickTap(caps: Capabilities, override: FrameTap | null): FrameTap | null {
  if (override === "encoded-streams" && caps.encodedStreams) return override;
  if (override === "script-transform" && caps.scriptTransform) return override;
  if (caps.scriptTransform) return "script-transform";
  return caps.encodedStreams ? "encoded-streams" : null;
}

/** The `?tap=` value, if it names a tap. */
export function parseTapOverride(value: string | null): FrameTap | null {
  return value === "script-transform" || value === "encoded-streams" ? value : null;
}

/** The `?renderer=` value, if it names a renderer. */
export function parseOverride(value: string | null): RendererOverride {
  return value === "webgpu" || value === "webgl2" || value === "video" ? value : null;
}

/** A one-line description for the overlay, e.g. `script-transform → WebCodecs → WebGPU`. */
export function describePipeline(pipeline: Pipeline): string {
  if (!pipeline.tap) return "remote track → <video>";
  const renderer = pipeline.renderer === "webgpu" ? "WebGPU (WGSL)" : "WebGL2";
  return `${pipeline.tap} → WebCodecs → ${renderer}`;
}

/** Reads the capabilities of the engine this runs in (asks WebGPU for an adapter). */
export async function detectCapabilities(
  scope: typeof globalThis = globalThis,
): Promise<
  Capabilities
> {
  const g = scope as unknown as Record<string, unknown>;
  const receiver = g.RTCRtpReceiver as { prototype?: object } | undefined;
  return {
    webrtc: typeof g.RTCPeerConnection === "function",
    scriptTransform: typeof g.RTCRtpScriptTransform === "function",
    encodedStreams: !!receiver?.prototype &&
      "createEncodedStreams" in receiver.prototype,
    webCodecs: typeof g.VideoDecoder === "function" &&
      typeof g.VideoFrame === "function",
    webgpu: await hasGpuAdapter(scope.navigator),
    webgl2: hasWebGl2(scope),
  };
}

async function hasGpuAdapter(nav: Navigator | undefined): Promise<boolean> {
  const gpu = (nav as { gpu?: GPU } | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function hasWebGl2(scope: typeof globalThis): boolean {
  const doc = (scope as { document?: Document }).document;
  if (!doc) return false;
  try {
    return doc.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}
