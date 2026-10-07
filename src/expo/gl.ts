/**
 * `expo-gl` for denext: `GLView` as a `<canvas>` with a WebGL 2 context (WebGL 1 where 2 is
 * missing), handed to `onContextCreate` with Expo's additions — `endFrameEXP()` (a no-op: the
 * browser presents the frame), `flushEXP()` (`gl.flush()`), `contextId`, and `texImage2D` /
 * `texSubImage2D` accepting an `expo-asset` `Asset`. The same code draws in the Capacitor
 * shell's WebView (WKWebView and the Android WebView both have WebGL 2) and in a browser.
 *
 * The canvas is sized to its layout box at the device pixel ratio (and follows resizes, as the
 * native drawing buffer does). The ref's `takeSnapshotAsync` encodes the canvas (a `blob:`
 * URL in `uri` and `localUri`). Context loss calls `onContextLost`, a restore re-creates the
 * context and calls `onContextCreate` again.
 *
 * Not available (a WebView has no API for them): GL on a worklet / UI runtime
 * (`enableExperimentalWorkletSupport`; `getWorkletContext` returns undefined), camera textures
 * (`createCameraTextureAsync`) and `destroyObjectAsync` reject with `ERR_UNAVAILABLE`.
 *
 * @example
 * ```ts
 * import { GLView } from "denext/expo/gl";
 * import { h } from "denext/jsx-runtime";
 *
 * h(GLView, {
 *   style: { width: 300, height: 300 },
 *   onContextCreate: (gl) => {
 *     gl.clearColor(0, 0.5, 1, 1);
 *     gl.clear(gl.COLOR_BUFFER_BIT);
 *     gl.endFrameEXP();
 *   },
 * });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useImperativeHandle, useRef } from "../runtime/hooks.ts";
import { CodedError, hostView, unavailable, viewStyle } from "./internal/common.ts";

/** What the native view reports when its surface exists. */
export interface SurfaceCreateEvent {
  /** The native event. */
  nativeEvent: {
    /** The context's id. */
    exglCtxId: number;
  };
}

/** Options for a snapshot. */
export interface SnapshotOptions {
  /** Flip vertically (ignored: the canvas is already upright). */
  flip?: boolean;
  /** The framebuffer to read (ignored: the canvas's). */
  framebuffer?: WebGLFramebuffer;
  /** A region (ignored: the whole canvas). */
  rect?: { x: number; y: number; width: number; height: number };
  /** The image format (default `jpeg`). */
  format?: "jpeg" | "png" | "webp";
  /** The quality, 0–1 (default 1). */
  compress?: number;
}

/** A snapshot. */
export interface GLSnapshot {
  /** A `blob:` URL of the image. */
  uri: string | Blob | null;
  /** The same URL. */
  localUri: string;
  /** Its width. */
  width: number;
  /** Its height. */
  height: number;
}

/** What Expo's GL logging can show (logging is not available here). */
export enum GLLoggingOption {
  /** Nothing. */
  DISABLED = 0,
  /** Every method call. */
  METHOD_CALLS = 1,
  /** `getError` after each call. */
  GET_ERRORS = 2,
  /** Constants by name. */
  RESOLVE_CONSTANTS = 4,
  /** Shortened strings. */
  TRUNCATE_STRINGS = 8,
  /** All of them. */
  ALL = 15,
}

/** The context `onContextCreate` receives: WebGL plus Expo's additions. */
export interface ExpoWebGLRenderingContext extends WebGL2RenderingContext {
  /** The context's id. */
  contextId: number;
  /** End the frame (a no-op here: the browser presents it). */
  endFrameEXP(): void;
  /** Flush the commands (`gl.flush()`). */
  flushEXP(): void;
  /** Expo's GL logging (not available here: does nothing). */
  __expoSetLogging(option: GLLoggingOption): void;
}

/** A component, a native handle, or nothing (what Expo's camera texture takes). */
// deno-lint-ignore no-explicit-any
export type ComponentOrHandle = null | number | Record<string, any>;

/** A GL object (`destroyObjectAsync`). */
export interface WebGLObject {
  /** Its id. */
  id: number;
}

/** What the ref exposes. */
export interface GLViewHandle {
  /** The canvas, once mounted. */
  canvas?: HTMLCanvasElement;
  /** The context, once created. */
  gl?: ExpoWebGLRenderingContext;
  /** The context's id. */
  exglCtxId?: number;
  /** Snapshot the canvas. */
  takeSnapshotAsync(options?: SnapshotOptions): Promise<GLSnapshot>;
  /** Not available here: rejects with `ERR_UNAVAILABLE`. */
  createCameraTextureAsync(cameraRefOrHandle: ComponentOrHandle): Promise<WebGLTexture>;
  /** Not available here: rejects with `ERR_UNAVAILABLE`. */
  destroyObjectAsync(glObject: WebGLObject): Promise<boolean>;
}

/** `GLView` props (plus any view prop). */
export interface GLViewProps {
  /** Called with the context once the canvas exists (and again after a restore). */
  onContextCreate(gl: ExpoWebGLRenderingContext): void;
  /** Multisampling: any value above 0 asks for an antialiased context (default 4). */
  msaaSamples?: number;
  /** GL on a worklet runtime (not available here: ignored). */
  enableExperimentalWorkletSupport?: boolean;
  /** Called with the canvas. */
  nativeRef_EXPERIMENTAL?(callback: ComponentOrHandle | HTMLCanvasElement | null): unknown;
  /** Called when the context is restored after a loss. */
  onContextRestored?: (gl?: ExpoWebGLRenderingContext) => void;
  /** Called when the context is lost. */
  onContextLost?: () => void;
  /** The WebGL context attributes. */
  webglContextAttributes?: WebGLContextAttributes;
  /** The ref ({@linkcode GLViewHandle}). */
  ref?: unknown;
  /** The style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** The next context id. */
let nextContextId = 1;

/** The image an `expo-asset` `Asset` stands for, or the value itself. */
function textureSource(value: unknown): unknown {
  const asset = value as { downloadAsync?: unknown; localUri?: string; uri?: string } | null;
  if (!asset || typeof asset !== "object" || typeof asset.downloadAsync !== "function") {
    return value;
  }
  const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement }).Image;
  if (!ImageCtor) return value;
  const image = new ImageCtor();
  image.src = asset.localUri || asset.uri || "";
  return image;
}

/** `gl` with Expo's additions. */
function asExpoContext(gl: WebGL2RenderingContext): ExpoWebGLRenderingContext {
  const ctx = gl as ExpoWebGLRenderingContext & Record<string, unknown>;
  if (typeof ctx.endFrameEXP === "function") return ctx;
  ctx.contextId = nextContextId++;
  ctx.endFrameEXP = () => {};
  ctx.flushEXP = () => gl.flush();
  ctx.__expoSetLogging = () => {};
  for (const name of ["texImage2D", "texSubImage2D"] as const) {
    // deno-lint-ignore no-explicit-any
    const original = (gl as any)[name].bind(gl) as (...args: unknown[]) => void;
    ctx[`_expo_${name}`] = original;
    // deno-lint-ignore no-explicit-any
    (ctx as any)[name] = (...args: unknown[]) => {
      const last = args.length - 1;
      return original(...args.slice(0, last), textureSource(args[last]));
    };
  }
  return ctx;
}

/** A WebGL 2 context on `canvas` (WebGL 1 where 2 is missing), with Expo's additions. */
function createContext(
  canvas: HTMLCanvasElement,
  attributes?: WebGLContextAttributes,
): ExpoWebGLRenderingContext {
  const gl = (canvas.getContext("webgl2", attributes) ??
    canvas.getContext("webgl", attributes)) as WebGL2RenderingContext | null;
  if (!gl) throw new CodedError("ERR_GL_INVALID", "denext/expo: this WebView has no WebGL.");
  return asExpoContext(gl);
}

/** The canvas encoded as an image. */
async function snapshot(
  canvas: HTMLCanvasElement | undefined,
  options: SnapshotOptions = {},
): Promise<GLSnapshot> {
  if (!canvas) {
    throw new CodedError(
      "ERR_GL_INVALID",
      "Attempting to use the GL context before it has been created.",
    );
  }
  const type = `image/${options.format ?? "jpeg"}`;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, options.compress ?? 1)
  );
  if (!blob) throw new CodedError("ERR_GL_SNAPSHOT", "Failed to save the GL context");
  const url = URL.createObjectURL(blob);
  return { uri: url, localUri: url, width: canvas.width, height: canvas.height };
}

/** The canvases of contexts made by {@linkcode GLView.createContextAsync}. */
const offscreen = new Map<number, HTMLCanvasElement>();

/** The live state behind one view. */
interface Live {
  canvas?: HTMLCanvasElement;
  gl?: ExpoWebGLRenderingContext;
  props: GLViewProps;
}

/** Size the canvas's drawing buffer to its box at the device pixel ratio. */
function fitCanvas(canvas: HTMLCanvasElement): void {
  const scale = (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
  const width = Math.max(1, Math.round((canvas.clientWidth || 300) * scale));
  const height = Math.max(1, Math.round((canvas.clientHeight || 150) * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

/** Create the view's context and hand it to `onContextCreate`. */
function startContext(live: Live): void {
  const canvas = live.canvas!;
  const { msaaSamples = 4, webglContextAttributes } = live.props;
  fitCanvas(canvas);
  live.gl = createContext(canvas, { antialias: msaaSamples > 0, ...webglContextAttributes });
  live.props.onContextCreate?.(live.gl);
}

/**
 * A view that draws with WebGL.
 *
 * @param props `onContextCreate`, the context options, style and view props.
 * @returns The view.
 */
export function GLView(props: GLViewProps): VNode {
  const {
    onContextCreate: _create,
    onContextRestored: _restored,
    onContextLost: _lost,
    webglContextAttributes: _attributes,
    msaaSamples: _msaa,
    enableExperimentalWorkletSupport: _worklets,
    nativeRef_EXPERIMENTAL: nativeRef,
    ref,
    style,
    ...rest
  } = props;
  const live = useRef<Live>({ props });
  live.current.props = props;
  useImperativeHandle(ref as never, (): GLViewHandle => ({
    get canvas() {
      return live.current.canvas;
    },
    get gl() {
      return live.current.gl;
    },
    get exglCtxId() {
      return live.current.gl?.contextId;
    },
    takeSnapshotAsync: (options) => snapshot(live.current.canvas, options),
    createCameraTextureAsync: () =>
      Promise.reject(
        unavailable("expo-gl", "createCameraTextureAsync", "Camera textures need native GL."),
      ),
    destroyObjectAsync: () =>
      Promise.reject(
        unavailable("expo-gl", "destroyObjectAsync", "WebGL deletes its own objects."),
      ),
  }), []);
  useEffect(() => {
    const canvas = live.current.canvas;
    if (!canvas) return;
    const onLost = (event: Event) => {
      event.preventDefault?.();
      live.current.gl = undefined;
      live.current.props.onContextLost?.();
    };
    const onRestored = () => {
      startContext(live.current);
      live.current.props.onContextRestored?.(live.current.gl);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    startContext(live.current);
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const resize = Observer ? new Observer(() => fitCanvas(canvas)) : undefined;
    resize?.observe(canvas);
    return () => {
      resize?.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      live.current.gl?.getExtension("WEBGL_lose_context")?.loseContext();
      live.current.gl = undefined;
    };
  }, []);
  return h(
    hostView(),
    { ...rest, style: viewStyle(style) } as never,
    h("canvas", {
      ref: (el: HTMLCanvasElement | null) => {
        live.current.canvas = el ?? undefined;
        nativeRef?.(el);
      },
      style: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%" },
    } as never),
  );
}

/**
 * A context with no view: an off-screen canvas the size of the window.
 *
 * @returns The context, or null with no page (SSR).
 */
GLView.createContextAsync = (): Promise<ExpoWebGLRenderingContext | null> => {
  const doc = (globalThis as { document?: Document }).document;
  if (typeof doc?.createElement !== "function") return Promise.resolve(null);
  const canvas = doc.createElement("canvas");
  const g = globalThis as { innerWidth?: number; innerHeight?: number; devicePixelRatio?: number };
  const scale = g.devicePixelRatio ?? 1;
  canvas.width = Math.round((g.innerWidth ?? 300) * scale);
  canvas.height = Math.round((g.innerHeight ?? 150) * scale);
  const gl = createContext(canvas);
  offscreen.set(gl.contextId, canvas);
  return Promise.resolve(gl);
};

/**
 * Release a context made by {@linkcode GLView.createContextAsync}.
 *
 * @param exgl The context or its id.
 * @returns `true`.
 */
GLView.destroyContextAsync = (exgl?: ExpoWebGLRenderingContext | number): Promise<boolean> => {
  const id = typeof exgl === "number" ? exgl : exgl?.contextId;
  const canvas = id === undefined ? undefined : offscreen.get(id);
  if (id !== undefined) offscreen.delete(id);
  if (canvas && typeof exgl === "object") exgl.getExtension("WEBGL_lose_context")?.loseContext();
  return Promise.resolve(true);
};

/**
 * Snapshot a context's canvas.
 *
 * @param exgl The context (or the id of an off-screen one).
 * @param options The format and quality.
 * @returns The snapshot.
 */
GLView.takeSnapshotAsync = (
  exgl?: ExpoWebGLRenderingContext | number,
  options?: SnapshotOptions,
): Promise<GLSnapshot> => {
  const canvas = typeof exgl === "number"
    ? offscreen.get(exgl)
    : (exgl?.canvas as HTMLCanvasElement | undefined);
  return snapshot(canvas, options);
};

/**
 * The context of a worklet runtime: there is none here.
 *
 * @param _contextId The context id.
 * @returns undefined.
 */
GLView.getWorkletContext = (_contextId: number): ExpoWebGLRenderingContext | undefined => undefined;

/** Expo's default props. */
GLView.defaultProps = { msaaSamples: 4, enableExperimentalWorkletSupport: false };

/** Expo's native view component (none here). */
GLView.NativeView = null as unknown;

/**
 * The context of a worklet runtime: there is none here (GL runs on the page's thread).
 *
 * @param contextId The context id.
 * @returns undefined.
 */
export function getWorkletContext(contextId: number): ExpoWebGLRenderingContext | undefined {
  return GLView.getWorkletContext(contextId);
}
