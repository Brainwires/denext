// The native half of `setNowPlaying()` / `clearNowPlaying()` / `onMediaControl()` /
// `setAudioSession()` (denext/mobile, and expo-audio's `setAudioModeAsync` /
// `setActiveForLockScreen` in React Native mode), embedded as text so it ships inside the JSR
// package: `denext mobile add background-audio` writes it into a Capacitor project.
//
// - iOS: `ios/App/App/DenextNowPlayingPlugin.swift`, registered by `DenextBridgeViewController`.
//   `configureSession` sets the `AVAudioSession` category (`.playback` for background audio,
//   with `UIBackgroundModes: audio`); `setNowPlaying` fills `MPNowPlayingInfoCenter` and binds
//   the `MPRemoteCommandCenter` commands the page offers; each command sends `mediaControl`.
// - Android: `dev/denext/nowplaying/DenextNowPlayingPlugin.java` (registered from
//   `MainActivity`) and `DenextNowPlayingService.java` (declared in AndroidManifest.xml). A
//   framework `MediaSession` and a media-style notification carry the info and the controls; the
//   `mediaPlayback` foreground service keeps the app alive while it plays in the background.
//   Framework APIs only, so the app needs no androidx.media dependency.
//
// Edit these as source in native-templates/now-playing.ts:
// they are compiled only in an app (against Capacitor 8). Every `\``, `\${` and `\\` there is an
// escaped template-literal character, not part of the Swift/Java.
//
// Every file is written through `renderNowPlayingTemplate`, which puts a marker line on top:
// the template generation and the SHA-256 of the rest of the file. A file whose marker still
// matches its body is an unedited denext template and is upgraded in place by a later run; an
// edited one is kept. Bump NOW_PLAYING_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/now-playing.ts (the readable source, not
// published) is packed with the others into native-templates.packed.ts by
// `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the templates, stamped into every file the installer writes. */
export const NOW_PLAYING_TEMPLATE_VERSION = 1;

/**
 * A template as the installer writes it: a first line
 * `// denext-now-playing-template: <NOW_PLAYING_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256 of
 * everything after that line), then the template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderNowPlayingTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("now-playing", NOW_PLAYING_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited now-playing template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineNowPlayingTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("now-playing", text) === true;
}

/** The iOS files, for `ios/App/App/`. */
export const NOW_PLAYING_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.nowPlaying.NOW_PLAYING_IOS_FILES;

/** The Android files, for `android/app/src/main/java/dev/denext/nowplaying/`. */
export const NOW_PLAYING_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.nowPlaying.NOW_PLAYING_ANDROID_FILES;
