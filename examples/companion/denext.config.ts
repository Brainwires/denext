import type { DenextConfig } from "denext/server";

// Loopy's desktop window: a small transparent, frameless overlay that never takes the focus from
// the app you are typing in, floats above other windows on every Space (over full-screen apps too,
// at the "status" level), and stays off the Dock and the taskbar. The page lets clicks through
// everywhere but Loopy, its bubble and its buttons (a hit region, lib/window-setup.ts). With no Dock
// icon the tray icon is the way back: show / hide Loopy, quit (desktop.ts).
export default {
  desktop: {
    app: {
      // Keys the OS data folder (where the inbox file lives) and the window's storage.
      identifier: "dev.denext.loopy",
      name: "Loopy",
      // The app icon on each OS (icons/: original art, 1024 px; the .ico holds 16 to 256 px).
      icons: {
        macos: "./icons/macos.png",
        linux: "./icons/linux.png",
        windows: "./icons/windows.ico",
      },
      // A companion, not an app you switch to: the accessory activation policy, so no Dock icon or
      // menu bar from the first frame (runtime 3.0.0-denext.6; the tray brings Loopy back).
      activationPolicy: "accessory",
    },
    window: {
      // Loopy at its default size, 125 % of the 260 × 300 base (lib/placement.ts WINDOW_SIZE ×
      // lib/voice-settings.ts SCALE.default), so the first frame needs no resize; the page resizes
      // the window to the size setting after that.
      width: 325,
      height: 375,
      title: "Loopy",
      resizable: false,
      // Creation-time (written to .deno-desktop/app.json): Loopy stands on the desktop itself.
      frameless: true,
      transparent: true,
      focusable: false,
      // Above other windows, the menu bar and full-screen apps (macOS has the levels; Windows and
      // Linux float it), on every Space including a full-screen app's (visibleOnFullScreen).
      alwaysOnTop: "status",
      visibleOnAllWorkspaces: true,
      skipTaskbar: true,
      // Linux Wayland: a window can't ask to be on top, on every workspace, off the taskbar or
      // unfocused there; a layer-shell surface is all of those (KDE Plasma, wlroots compositors,
      // with libgtk-layer-shell installed; runtime 3.0.0-denext.7). An ordinary window elsewhere.
      overlay: true,
    },
    backdrop: "none",
    // Loopy's voice is WebRTC, which Linux's system WebView (WebKitGTK) doesn't have: Chromium
    // (CEF) there, the system WebView on macOS and Windows. CEF paints the window opaque, so on
    // Linux Loopy stands in a small square of its own.
    backend: { linux: "cef" },
    tray: {
      icon: "/tray.png",
      tooltip: "Loopy",
      menu: [
        { id: "show", label: "Show Loopy" },
        { id: "hide", label: "Hide Loopy" },
        { separator: true },
        // Loopy's own Quit (desktop.ts): it kills the browser, then quits the app.
        { id: "quit", label: "Quit Loopy" },
      ],
    },
    // The inbox file (token + port), the memory database and the browser profile go in the app's
    // data folder, so the packaged app writes there. Listening on loopback is in the baseline, and
    // so is connecting to it (the browser's DevTools socket). The voice backend (voice/) talks to
    // api.openai.com only: Realtime sessions, web search and embeddings. `run` is Chrome or
    // Chromium where they install (voice/chrome.ts CHROME_PATHS), nothing else.
    extraPermissions: {
      write: ["$APPDATA"],
      net: ["api.openai.com"],
      run: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ],
    },
    // Just the app bundle: no installers for an example.
    installers: { macos: [], linux: [], windows: [] },
    // The OpenAI key lives in the OS keychain (desktop.ts hands the secure store to the voice
    // backend only, never to the page); the push-to-talk shortcut works from any app; a web
    // search's source links open in the system browser (http and https only, nothing else the
    // shell capability can do). The microphone is granted to the window's own origin only, in the
    // packaged app (`denext task desktop:package`; a `desktop run` window has none); macOS asks
    // the user once, with this text.
    capabilities: {
      secureStore: true,
      globalShortcuts: true,
      shell: { openExternal: ["https:", "http:"] },
      microphone: {
        usageDescription: "Loopy listens to you only while you talk to it: hold Space, click " +
          "Loopy or press its shortcut.",
      },
    },
  },
} satisfies DenextConfig;
