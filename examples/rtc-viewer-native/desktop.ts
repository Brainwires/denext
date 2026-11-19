// Entry for `deno desktop`: serves the control page from `out/`, runs the `rtcviewer` extension
// (desktop/rtc-viewer.ts) in this process, starts the WHIP endpoint and opens the video window
// full-screen right away (black until a sender connects: `denext task send`).
//
// Environment: RTCV_PORT (WHIP port, default 8189), RTCV_DISPLAY (display index, default 0),
// RTCV_WINDOWED=1 (a 1280×720 window instead of full-screen), RTCV_OPEN=0 (don't open the video
// window at launch), RTCV_NATIVE_LIB (the library's path), RTCV_PLAY=<file> (play a clip in a
// loop instead of waiting for a sender: lib/clip.ts), RTCV_LOG_STATS=1 (the stats on stdout every
// two seconds).
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { viewerApp } from "./desktop/rtc-viewer.ts";
import { parseClip } from "./lib/clip.ts";

const caps = await resolveDesktopCapabilities(config, { base: import.meta.url });
const app = await runDesktop({ importMetaUrl: import.meta.url, ...caps });
const viewer = viewerApp();

const env = (name: string) => Deno.env.get(name) ?? "";
const display = Number(env("RTCV_DISPLAY") || 0);
const report = (what: string) => (err: unknown) =>
  console.error(`rtc-viewer-native: ${what}:`, err instanceof Error ? err.message : err);

viewer.startWhip({ port: Number(env("RTCV_PORT") || 8189) });
if (env("RTCV_OPEN") !== "0") {
  viewer.open({ fullscreen: env("RTCV_WINDOWED") !== "1", display }).catch(report("open"));
}
if (env("RTCV_PLAY")) {
  try {
    viewer.play(env("RTCV_PLAY"), parseClip(env("RTCV_PLAY"), Deno.readFileSync(env("RTCV_PLAY"))));
  } catch (err) {
    report("play")(err);
  }
}
if (env("RTCV_LOG_STATS") === "1") {
  setInterval(() => {
    const { viewer: v, transport } = viewer.stats();
    if (v) console.log(`rtc-viewer-native stats ${JSON.stringify({ ...v, transport })}`);
  }, 2000);
}

app.tray?.onMenuItem((id) => {
  switch (id) {
    case "fullscreen":
      viewer.open({ fullscreen: true, display }).catch(report("open"));
      break;
    case "windowed":
      viewer.open({ fullscreen: false, display }).catch(report("open"));
      break;
    case "hide":
      viewer.hide().catch(report("hide"));
      break;
    case "controls":
      app.windows.get("main")?.show();
      break;
    case "quit":
      viewer.shutdown().finally(() => app.quit());
      break;
  }
});
