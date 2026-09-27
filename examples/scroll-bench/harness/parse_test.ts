import { assertEquals, assertExists } from "@std/assert";
import {
  burstIntervals,
  classifyLogcat,
  findMarkers,
  harnessLineMs,
  logcatEpochMs,
  logcatPid,
  parseAmStart,
  parseArgs,
  parseGfx,
  parseRendererPids,
  parseSfLatency,
  parseSfLayers,
  parseTotalPss,
  parseWmSize,
  pct,
  shortN,
  stats,
  summarizeIntervals,
} from "./parse.ts";

Deno.test("parseArgs: positional, --k v, --k=v and boolean flags", () => {
  const { positional, flags } = parseArgs([
    "matrix",
    "--config",
    "a.json",
    "--dry-run",
    "--only=rn-",
  ]);
  assertEquals(positional, ["matrix"]);
  assertEquals(flags, { config: "a.json", "dry-run": true, only: "rn-" });
});

Deno.test("parseAmStart", () => {
  const out =
    "Status: ok\nLaunchState: COLD\nActivity: x/.Main\nTotalTime: 812\nWaitTime: 830\nComplete";
  assertEquals(parseAmStart(out), {
    totalTimeMs: 812,
    waitTimeMs: 830,
    launchState: "COLD",
  });
  assertEquals(parseAmStart("nothing").totalTimeMs, null);
});

Deno.test("parseWmSize prefers the override size", () => {
  assertEquals(parseWmSize("Physical size: 1080x2400"), { w: 1080, h: 2400 });
  assertEquals(
    parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600"),
    { w: 720, h: 1600 },
  );
  assertEquals(parseWmSize("?"), null);
});

Deno.test("parseTotalPss: both dumpsys formats", () => {
  assertEquals(parseTotalPss("   TOTAL PSS:   123456   TOTAL RSS: 1"), 123456);
  assertEquals(parseTotalPss("        TOTAL    98765    1000"), 98765);
});

Deno.test("parseRendererPids keeps WebView renderers only", () => {
  const ps = "  PID NAME\n 812 com.android.webview:sandboxed_process0:org.chromium\n 900 com.x\n";
  assertEquals([...parseRendererPids(ps)], [[
    812,
    "com.android.webview:sandboxed_process0:org.chromium",
  ]]);
});

Deno.test("parseGfx", () => {
  const g = parseGfx(
    "Total frames rendered: 400\nJanky frames: 12 (3.00%)\nJanky frames (legacy): 20 (5.00%)\n" +
      "50th percentile: 8ms\n90th percentile: 14ms\n95th percentile: 18ms\n99th percentile: 40ms\n" +
      "50th gpu percentile: 2ms\n99th gpu percentile: 9ms\n",
  );
  assertEquals(g.totalFrames, 400);
  assertEquals(g.jankyPct, 3);
  assertEquals(g.jankyLegacyPct, 5);
  assertEquals([g.p50Ms, g.p90Ms, g.p95Ms, g.p99Ms], [8, 14, 18, 40]);
  assertEquals([g.gpuP50Ms, g.gpuP99Ms], [2, 9]);
});

Deno.test("parseSfLayers unwraps Android 15 RequestedLayerState names", () => {
  const list = [
    "RequestedLayerState{com.brainwires.rnscrollbench/com.brainwires.rnscrollbench.MainActivity#1234 parentId=12 z=0}",
    "RequestedLayerState{Splash Screen com.brainwires.rnscrollbench#99 parentId=1 z=0}",
    "com.other/Main#5",
    "com.brainwires.rnscrollbench/com.brainwires.rnscrollbench.MainActivity#1234",
  ].join("\n");
  assertEquals(parseSfLayers(list, "com.brainwires.rnscrollbench"), [
    "com.brainwires.rnscrollbench/com.brainwires.rnscrollbench.MainActivity#1234",
  ]);
});

Deno.test("parseSfLatency drops pending rows and sorts", () => {
  const out = "16666667\n1 3000000000 1\n1 9223372036854775807 1\n1 1000000000 1\n\n";
  assertEquals(parseSfLatency(out), {
    periodNs: 16666667,
    present: [1000000000, 3000000000],
  });
});

Deno.test("burstIntervals splits at gaps > 100 ms; pct is nearest-rank", () => {
  const ms = (x: number) => x * 1e6;
  assertEquals(burstIntervals([ms(0), ms(16), ms(33), ms(500), ms(516)]), [
    16,
    17,
    16,
  ]);
  assertEquals(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assertEquals(pct([], 50), null);
});

Deno.test("summarizeIntervals: missed vsync > 1.5 periods", () => {
  const s = summarizeIntervals([16, 17, 16, 34, 16, 50], 16_666_667);
  assertEquals(s.intervals, 6);
  assertEquals(s.missedVsyncPct, 33.3);
  assertEquals(s.maxMs, 50);
  assertEquals(s.vsyncPeriodMs, 16.67);
});

Deno.test("logcat epoch lines: timestamp, pid, markers, harness line", () => {
  const log = [
    "1727430000.100  4321  4321 I SCROLLBENCH_HARNESS: launch-rn-flash-chat-10k",
    '1727430001.350  5555  5601 I ReactNativeJS: SCROLLBENCH_READY {"app":"rn","list":"flash","ms":900}',
    '1727430002.000  6000  6000 I Capacitor/Console: File: https://localhost/_denext/client/index.js - Line 1 - Msg: SCROLLBENCH_ACTION {"op":"append","ok":true,"ms":41}',
  ].join("\n");
  assertEquals(logcatEpochMs(log.split("\n")[0]), 1727430000100);
  assertEquals(logcatPid(log.split("\n")[1]), 5555);
  assertEquals(harnessLineMs(log, "launch-rn-flash-chat-10k"), 1727430000100);
  const hits = findMarkers(log);
  assertEquals(hits.map((h) => h.marker), ["ready", "action"]);
  assertEquals(hits[0].data.list, "flash");
  assertEquals(hits[0].epochMs! - 1727430000100, 1250);
  assertEquals(hits[1].data.ms, 41);
});

Deno.test("classifyLogcat: package/pid-scoped failures only", () => {
  const pkg = "com.brainwires.rnscrollbench";
  const other = "1727430000.1 999 999 E AndroidRuntime: FATAL EXCEPTION: main\n" +
    "1727430000.1 999 999 E AndroidRuntime: Process: com.google.other, PID: 999";
  assertEquals(classifyLogcat(other, pkg, 5555), null);
  const crash = "1727430000.1 5555 5555 E AndroidRuntime: FATAL EXCEPTION: main\n" +
    `1727430000.1 5555 5555 E AndroidRuntime: Process: ${pkg}, PID: 5555`;
  assertEquals(classifyLogcat(crash, pkg, 5555)?.failure, "crashed");
  assertEquals(classifyLogcat(crash, pkg, null)?.failure, "crashed");
  const oom =
    "1727430000.1 5555 5555 E AndroidRuntime: java.lang.OutOfMemoryError: Failed to allocate\n" +
    crash;
  assertEquals(classifyLogcat(oom, pkg, 5555)?.failure, "oom");
  const lmk =
    `1727430000.1 400 400 I lowmemorykiller: Kill '${pkg}' (5555), uid 10200, oom_score_adj 0`;
  assertEquals(classifyLogcat(lmk, pkg, 5555)?.failure, "oom");
  const anr = `1727430000.1 500 520 E ActivityManager: ANR in ${pkg} (${pkg}/.MainActivity)`;
  assertEquals(classifyLogcat(anr, pkg, 5555)?.failure, "anr");
  const gone =
    "1727430000.1 5555 5555 E chromium: Render process (6000)'s crash wasn't handled; onRenderProcessGone";
  assertExists(classifyLogcat(gone, "com.brainwires.denext.scrollbench", 5555));
});

Deno.test("stats and shortN", () => {
  assertEquals(stats([3, null, 1, 2]), {
    n: 3,
    median: 2,
    mean: 2,
    min: 1,
    max: 3,
  });
  assertEquals(stats([]).median, null);
  assertEquals([shortN(1000), shortN(10_000_000), shortN(1500)], [
    "1k",
    "10M",
    "1500",
  ]);
});
