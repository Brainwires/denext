// `denext mobile add background-audio`: install the native `DenextNowPlaying` plugin behind
// `setNowPlaying()` / `clearNowPlaying()` / `onMediaControl()` / `setAudioSession()`
// (denext/mobile) and expo-audio's lock-screen calls in React Native mode. iOS:
// `DenextNowPlayingPlugin.swift`, added to the Xcode app target and registered by
// `DenextBridgeViewController`. Android: `dev/denext/nowplaying/DenextNowPlayingPlugin.java` and
// `DenextNowPlayingService.java`, the plugin registered from `MainActivity` (the capability's
// manifest edit declares the service). Both compose with every other denext native feature in
// either order (see mobile-native-install.ts). Running it twice changes nothing.

import {
  NOW_PLAYING_ANDROID_FILES,
  NOW_PLAYING_IOS_FILES,
} from "./now-playing-native-templates.ts";
import {
  type NativeInstallOptions,
  type NativeInstallReport,
  NOW_PLAYING_TEMPLATES,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

/** The foreground service's class, as AndroidManifest.xml names it. */
export const NOW_PLAYING_SERVICE = "dev.denext.nowplaying.DenextNowPlayingService";

/**
 * Install the native `DenextNowPlaying` plugin (behind `setNowPlaying()` in `denext/mobile`) into
 * the Capacitor project at `opts.dir`: `DenextNowPlayingPlugin.swift` in the Xcode app target,
 * registered by `DenextBridgeViewController` (the storyboard and SceneDelegate switched to it
 * while they are stock), and the Java plugin and its media-playback service, the plugin
 * registered from `MainActivity`. Idempotent; an unedited template from an earlier denext is
 * upgraded, and customised files are never rewritten without `force`, only reported under `kept`
 * and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
function addNowPlayingToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  return installRegisteredPlugin(opts, {
    feature: "background-audio",
    iosFiles: NOW_PLAYING_IOS_FILES,
    androidFiles: NOW_PLAYING_ANDROID_FILES,
    androidDir: "android/app/src/main/java/dev/denext/nowplaying",
    kind: NOW_PLAYING_TEMPLATES,
    registration: {
      needle: "DenextNowPlayingPlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextNowPlayingPlugin())` after " +
        "super.capacitorDidLoad().",
    },
  });
}

/** `background-audio`'s native step: the DenextNowPlaying plugin and its registration. */
export const NOW_PLAYING_INSTALL: NativeInstallStep = {
  label: "DenextNowPlaying plugin (background audio, lock-screen / notification controls) + " +
    "its registration in DenextBridgeViewController / MainActivity",
  run: addNowPlayingToProject,
};
