// examples/rtc-viewer: the pieces that run headless. The signalling hub (directly and as the app's
// route handler), the pipeline's fallback selection, the codec strings, the overlay's numbers,
// the aspect fit, the full-screen method and the CLI's arguments; the app's routes conform.
// The WebRTC loopback and the WGSL on a real adapter are in rtc-viewer-webrtc.test.ts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createTestApp, createTestClient } from "denext/testing";
import { SignalHub } from "../examples/rtc-viewer/lib/signal/hub.ts";
import { hubUrl } from "../examples/rtc-viewer/lib/signal/client.ts";
import { isPeerId, isRoomName, parsePostBody } from "../examples/rtc-viewer/lib/signal/protocol.ts";
import {
  type Capabilities,
  describePipeline,
  parseOverride,
  parseTapOverride,
  selectPipeline,
} from "../examples/rtc-viewer/lib/pipeline/plan.ts";
import { codecString, parseFmtp } from "../examples/rtc-viewer/lib/pipeline/codec.ts";
import { inboundFromReport, StatsMeter } from "../examples/rtc-viewer/lib/pipeline/stats.ts";
import { fitScale } from "../examples/rtc-viewer/lib/pipeline/shaders.ts";
import { fullscreenMethod } from "../examples/rtc-viewer/lib/fullscreen-method.ts";
import { parseSendArgs } from "../examples/rtc-viewer/cli/send.ts";

const APP = fromFileUrl(new URL("../examples/rtc-viewer", import.meta.url));
const ORIGIN = "http://hub.test";

// ---------------------------------------------------------------------------------------------
// Signalling: the wire format and the hub.

Deno.test("rtc-viewer protocol: names, ids and POST bodies are validated", () => {
  assert(isRoomName("demo") && isRoomName("lab_2-b"));
  assert(!isRoomName("") && !isRoomName("a/b") && !isRoomName("x".repeat(41)));
  assert(
    isPeerId(crypto.randomUUID()) && !isPeerId("short") &&
      !isPeerId("a b c d e f"),
  );
  const from = crypto.randomUUID();
  const to = crypto.randomUUID();
  assertEquals(
    parsePostBody({
      from,
      to,
      token: "t",
      data: { type: "offer", sdp: "v=0" },
    }),
    { from, to, token: "t", data: { type: "offer", sdp: "v=0" } },
  );
  assertEquals(
    parsePostBody({ from, to, token: "t", data: { type: "offer" } }),
    null,
  );
  assertEquals(
    parsePostBody({ from, to, token: "t", data: { type: "eval", sdp: "" } }),
    null,
  );
  assertEquals(
    parsePostBody({ from: "x", to, token: "t", data: { type: "restart" } }),
    null,
  );
  assertEquals(
    parsePostBody({
      from,
      to,
      token: "t",
      data: { type: "candidate", candidate: null },
    })?.data,
    { type: "candidate", candidate: null },
  );
});

/** An SSE event: its name and parsed data. */
interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** A joined peer: its stream, read event by event. */
class Joined {
  readonly id = crypto.randomUUID();
  #reader: ReadableStreamDefaultReader<string> | null = null;
  #buffer = "";
  token = "";

  constructor(readonly role: "sender" | "viewer") {}

  async join(
    hub: SignalHub,
    room = "demo",
    origin?: string,
  ): Promise<Response> {
    const url = `${ORIGIN}/api/signal?room=${room}&id=${this.id}&role=${this.role}`;
    const res = await hub.handle(
      new Request(url, { headers: origin ? { origin } : {} }),
    );
    if (res.ok) {
      this.#reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      const welcome = await this.next();
      assertEquals(welcome.event, "welcome");
      this.token = welcome.data.token as string;
    }
    return res;
  }

  /** The next named event (comments and `retry:` lines skipped). */
  async next(): Promise<SseEvent> {
    while (true) {
      const end = this.#buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) return { event, data: JSON.parse(data) };
        continue;
      }
      const { value, done } = await this.#reader!.read();
      if (done) throw new Error("stream ended");
      this.#buffer += value;
    }
  }

  post(
    hub: SignalHub,
    to: string,
    data: unknown,
    token = this.token,
  ): Promise<Response> {
    return hub.handle(
      new Request(`${ORIGIN}/api/signal?room=demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: this.id, token, to, data }),
      }),
    );
  }

  async leave(): Promise<void> {
    await this.#reader?.cancel();
  }
}

Deno.test("rtc-viewer hub: peers meet, messages relay, a leave is announced", async () => {
  const hub = new SignalHub();
  const sender = new Joined("sender");
  const viewer = new Joined("viewer");
  try {
    assertEquals(
      (await sender.join(hub)).headers.get("content-type"),
      "text/event-stream",
    );
    await viewer.join(hub);
    assertEquals(await sender.next(), {
      event: "join",
      data: { id: viewer.id, role: "viewer" },
    });

    const offer = { type: "offer", sdp: "v=0\r\n" };
    assertEquals((await sender.post(hub, viewer.id, offer)).status, 204);
    assertEquals(await viewer.next(), {
      event: "message",
      data: { from: sender.id, data: offer },
    });

    // Another peer's token does not sign for this one.
    assertEquals(
      (await viewer.post(hub, sender.id, { type: "restart" }, sender.token))
        .status,
      403,
    );
    assertEquals(
      (await viewer.post(hub, crypto.randomUUID(), { type: "restart" })).status,
      404,
    );

    await viewer.leave();
    assertEquals(await sender.next(), {
      event: "leave",
      data: { id: viewer.id },
    });
    assertEquals(hub.peers("demo"), [{ id: sender.id, role: "sender" }]);
  } finally {
    await viewer.leave();
    await sender.leave();
    hub.close();
  }
  assertEquals(hub.peers("demo"), []);
});

Deno.test("rtc-viewer hub: one sender per room, caps and bad requests", async () => {
  const hub = new SignalHub({
    maxPeersPerRoom: 2,
    maxRooms: 1,
    maxMessageBytes: 256,
  });
  const first = new Joined("sender");
  const viewer = new Joined("viewer");
  try {
    await first.join(hub);
    assertEquals((await new Joined("sender").join(hub)).status, 409);
    await viewer.join(hub);
    assertEquals(
      (await new Joined("viewer").join(hub)).status,
      503,
      "room full",
    );
    assertEquals(
      (await new Joined("viewer").join(hub, "other")).status,
      503,
      "too many rooms",
    );
    assertEquals(
      (await new Joined("viewer").join(hub, "no/slash")).status,
      400,
    );
    const big = { type: "offer", sdp: "x".repeat(300) };
    assertEquals((await first.post(hub, viewer.id, big)).status, 413);
    const bad = await hub.handle(
      new Request(`${ORIGIN}/api/signal?room=demo`, {
        method: "POST",
        body: "{nope",
      }),
    );
    assertEquals(bad.status, 400);
    const put = await hub.handle(
      new Request(`${ORIGIN}/api/signal?room=demo`, { method: "PUT" }),
    );
    assertEquals(put.status, 405);
  } finally {
    await viewer.leave();
    await first.leave();
    hub.close();
  }
});

Deno.test("rtc-viewer hub: only same-origin and listed origins may connect (CORS)", async () => {
  const hub = new SignalHub({ allowedOrigins: ["capacitor://localhost"] });
  const viewer = new Joined("viewer");
  try {
    assertEquals(
      (await new Joined("viewer").join(hub, "demo", "https://evil.test"))
        .status,
      403,
    );
    const ok = await viewer.join(hub, "demo", "capacitor://localhost");
    assertEquals(
      ok.headers.get("access-control-allow-origin"),
      "capacitor://localhost",
    );
    const preflight = await hub.handle(
      new Request(`${ORIGIN}/api/signal?room=demo`, {
        method: "OPTIONS",
        headers: { origin: "capacitor://localhost" },
      }),
    );
    assertEquals(preflight.status, 204);
    assertEquals(
      preflight.headers.get("access-control-allow-methods"),
      "GET, POST",
    );
  } finally {
    await viewer.leave();
    hub.close();
  }
});

Deno.test("rtc-viewer hub: an aborted request ends its stream and leaves the room", async () => {
  const hub = new SignalHub();
  const abort = new AbortController();
  const id = crypto.randomUUID();
  const res = await hub.handle(
    new Request(`${ORIGIN}/api/signal?room=demo&id=${id}&role=viewer`, {
      signal: abort.signal,
    }),
  );
  assertEquals(hub.peers("demo").length, 1);
  abort.abort();
  assertEquals(hub.peers("demo"), []);
  await res.body!.cancel();
});

Deno.test("rtc-viewer client: the hub URL is this origin's, or ?signal=", () => {
  assertEquals(
    hubUrl({ href: "http://a.test:3000/?room=x" }).href,
    "http://a.test:3000/api/signal",
  );
  assertEquals(
    hubUrl({ href: "capacitor://localhost/?signal=https://hub.example" }).href,
    "https://hub.example/api/signal",
  );
  assertEquals(
    hubUrl({ href: "http://a.test/?signal=http://h.test:8000/custom/signal" })
      .href,
    "http://h.test:8000/custom/signal",
  );
});

Deno.test("rtc-viewer route: /api/signal is the hub, in the app", async () => {
  await using app = await createTestApp(APP);
  const client = createTestClient(app, { origin: "http://localhost" });
  assertEquals((await client.get("/api/signal")).status, 400, "no room");
  const bogus = await client.post("/api/signal?room=demo", {
    json: {
      from: crypto.randomUUID(),
      token: "x",
      to: crypto.randomUUID(),
      data: { type: "restart" },
    },
  });
  assertEquals(bogus.status, 403, "not a peer of the room");

  // A stream through the app's own handler: its welcome names the peers already there.
  const abort = new AbortController();
  const id = crypto.randomUUID();
  const res = await app(
    new Request(`http://localhost/api/signal?room=route&id=${id}&role=viewer`, {
      signal: abort.signal,
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!text.includes("event: welcome")) {
    text += (await reader.read()).value ?? "";
  }
  assert(text.includes('"peers":[]'), text);
  abort.abort();
  await reader.cancel();
});

Deno.test("rtc-viewer conformance: every page renders (probeApp)", async () => {
  // In the example's own import map (its client components import denext/mobile and
  // denext/desktop/window, which the repository's map doesn't name): examples/rtc-viewer/probe.ts.
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      `${APP}/deno.json`,
      `${APP}/probe.ts`,
      "--json",
    ],
    cwd: APP,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(stdout);
  const line = text.trim().split("\n").at(-1) ?? "";
  assert(
    line.startsWith("{"),
    `probe printed no report: ${text}\n${new TextDecoder().decode(stderr)}`,
  );
  const result = JSON.parse(line) as {
    ok: boolean;
    report: string;
    routes: { path: string; rendered: boolean; interactive: boolean }[];
  };
  assert(result.ok && code === 0, result.report);
  for (const path of ["/", "/send"]) {
    const route = result.routes.find((r) => r.path === path);
    assert(
      route?.rendered && route.interactive,
      `${path} renders an interactive island`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The pipeline's choices and numbers.

const FULL: Capabilities = {
  webrtc: true,
  scriptTransform: true,
  encodedStreams: true,
  webCodecs: true,
  webgpu: true,
  webgl2: true,
};

Deno.test("rtc-viewer plan: the full pipeline, then each fallback", () => {
  assertEquals(selectPipeline(FULL), {
    tap: "script-transform",
    renderer: "webgpu",
    fallback: null,
  });
  // Chromium before RTCRtpScriptTransform: encoded insertable streams.
  assertEquals(
    selectPipeline({ ...FULL, scriptTransform: false }).tap,
    "encoded-streams",
  );
  // iOS before 26 (no WebGPU): WebGL2, and the overlay says why.
  assertEquals(selectPipeline({ ...FULL, webgpu: false }), {
    tap: "script-transform",
    renderer: "webgl2",
    fallback: "no WebGPU adapter",
  });
  const noCodecs = selectPipeline({ ...FULL, webCodecs: false });
  assertEquals([noCodecs.tap, noCodecs.renderer], [null, "video"]);
  assertEquals(noCodecs.fallback, "no WebCodecs VideoDecoder");
  const noTap = selectPipeline({
    ...FULL,
    scriptTransform: false,
    encodedStreams: false,
  });
  assertEquals(noTap.renderer, "video");
  assertEquals(
    selectPipeline({ ...FULL, webgpu: false, webgl2: false }).renderer,
    "video",
  );
  assertEquals(
    selectPipeline({ ...FULL, webrtc: false }).fallback,
    "no WebRTC in this engine",
  );
});

Deno.test("rtc-viewer plan: ?tap= picks a tap the engine has", () => {
  assertEquals(parseTapOverride("encoded-streams"), "encoded-streams");
  assertEquals(parseTapOverride("nope"), null);
  assertEquals(selectPipeline(FULL, null, "encoded-streams").tap, "encoded-streams");
  assertEquals(
    selectPipeline({ ...FULL, encodedStreams: false }, null, "encoded-streams").tap,
    "script-transform",
  );
  assertEquals(
    selectPipeline({ ...FULL, scriptTransform: false }, null, "script-transform").tap,
    "encoded-streams",
  );
});

Deno.test("rtc-viewer plan: ?renderer= only steps down", () => {
  assertEquals(parseOverride("webgl2"), "webgl2");
  assertEquals(parseOverride("bogus"), null);
  assertEquals(selectPipeline(FULL, "webgl2").renderer, "webgl2");
  assertEquals(selectPipeline(FULL, "video").renderer, "video");
  assertEquals(
    selectPipeline({ ...FULL, webgpu: false }, "webgpu").renderer,
    "webgl2",
  );
  assertEquals(
    describePipeline(selectPipeline(FULL)),
    "script-transform → WebCodecs → WebGPU (WGSL)",
  );
  assertEquals(
    describePipeline(selectPipeline(FULL, "video")),
    "remote track → <video>",
  );
});

Deno.test("rtc-viewer codec: WebRTC codecs map to WebCodecs strings", () => {
  assertEquals(parseFmtp("a=1; b = two;c").get("b"), "two");
  assertEquals(codecString("video/VP8"), "vp8");
  assertEquals(codecString("video/VP9", "profile-id=0"), "vp09.00.10.08");
  assertEquals(codecString("video/VP9", "profile-id=2"), "vp09.02.10.10");
  assertEquals(
    codecString(
      "video/H264",
      "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032",
    ),
    "avc1.640032",
  );
  assertEquals(codecString("video/h264"), "avc1.42e01f");
  assertEquals(codecString("video/AV1"), "av01.0.05M.08");
  assertEquals(codecString("video/H265"), "hvc1.1.6.L93.B0");
  assertEquals(codecString("video/rtx"), null);
});

Deno.test("rtc-viewer stats: fps and decode time over a sliding second", () => {
  const meter = new StatsMeter(1000);
  for (let i = 0; i < 30; i++) meter.frame(i * 33, 2 + (i % 2), 1280, 720);
  const s = meter.snapshot(990);
  assertEquals([s.width, s.height], [1280, 720]);
  assertEquals(s.fps, 30);
  assertEquals(s.decodeMs, 2.5);
  assertEquals(meter.snapshot(5000).fps, 0, "an idle stream reads 0 fps");
});

Deno.test("rtc-viewer stats: jitter and codec from an inbound-rtp report", () => {
  const report: [string, Record<string, unknown>][] = [
    ["A", { type: "inbound-rtp", kind: "audio", jitter: 1 }],
    ["V", {
      type: "inbound-rtp",
      kind: "video",
      jitter: 0.004,
      codecId: "C",
      framesDecoded: 9,
    }],
    ["C", {
      type: "codec",
      mimeType: "video/H264",
      sdpFmtpLine: "profile-level-id=42e01f",
    }],
  ];
  assertEquals(inboundFromReport(report), {
    jitterMs: 4,
    mimeType: "video/H264",
    sdpFmtpLine: "profile-level-id=42e01f",
    framesDecoded: 9,
  });
  assertEquals(inboundFromReport([]).jitterMs, null);
});

Deno.test("rtc-viewer display: the aspect fit letterboxes and pillarboxes", () => {
  assertEquals(fitScale(1920, 1080, 1920, 1080), [1, 1]);
  assertEquals(fitScale(1920, 1080, 1000, 1000), [1, 0.5625], "letterbox");
  assertEquals(fitScale(1080, 1920, 1000, 1000), [0.5625, 1], "pillarbox");
  assertEquals(fitScale(0, 0, 100, 100), [1, 1], "no picture yet");
});

Deno.test("rtc-viewer full screen: each target's method", () => {
  assertEquals(fullscreenMethod("desktop", false), "desktop-window");
  assertEquals(fullscreenMethod("ios", false), "mobile-immersive");
  assertEquals(fullscreenMethod("android", true), "mobile-immersive");
  assertEquals(fullscreenMethod("web", true), "fullscreen-api");
  assertEquals(
    fullscreenMethod("web", false),
    "none",
    "iPhone Safari has no element full screen",
  );
});

Deno.test("rtc-viewer CLI: arguments", () => {
  assertEquals(parseSendArgs([]).url, "http://127.0.0.1:3000");
  const o = parseSendArgs([
    "--room",
    "lab",
    "--size",
    "640x360",
    "--fps",
    "10",
    "--source",
    "pattern",
  ]);
  assertEquals([o.room, o.width, o.height, o.fps, o.source], [
    "lab",
    640,
    360,
    10,
    "pattern",
  ]);
  assertEquals(parseSendArgs(["--ice", "stun:a:1", "--ice", "stun:b:2"]).ice, [
    "stun:a:1",
    "stun:b:2",
  ]);
  assertThrows(() => parseSendArgs(["--size", "641x360"]), Error, "even");
  assertThrows(() => parseSendArgs(["--fps", "0"]), Error, "1–60");
  assertThrows(
    () => parseSendArgs(["--source", "screen"]),
    Error,
    "auto, camera or pattern",
  );
  assertThrows(() => parseSendArgs(["--bogus", "1"]), Error, "unknown option");
  assertThrows(() => parseSendArgs(["--room"]), Error, "needs a value");
});
