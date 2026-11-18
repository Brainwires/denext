// Which full-screen mechanism a target uses. Pure (lib/fullscreen.ts applies it).

/** How a target goes full screen. */
export type FullscreenMethod =
  | "desktop-window"
  | "mobile-immersive"
  | "fullscreen-api"
  | "none";

/**
 * The method for `platform` (`runtimePlatform()` from `denext/mobile`), given whether the page has
 * the Fullscreen API: the Deno Desktop window's own full screen, the Capacitor shell's immersive
 * mode (system bars hidden), else the Fullscreen API (absent on iPhone Safari: `none`).
 */
export function fullscreenMethod(
  platform: string,
  fullscreenApi: boolean,
): FullscreenMethod {
  if (platform === "desktop") return "desktop-window";
  if (platform === "ios" || platform === "android") return "mobile-immersive";
  return fullscreenApi ? "fullscreen-api" : "none";
}
