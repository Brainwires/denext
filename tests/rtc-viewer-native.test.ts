// examples/rtc-viewer-native's JavaScript control path, without the native library or a peer
// connection: the control API over a fake binding (lib/viewer.ts), the ABI tables against the Rust
// source (lib/native.ts ↔ native/src), the SDP helpers, the transform worker's pump and the WHIP
// endpoint over a fake peer. The decode round trips are the library's own tests (`cargo test` in
// native/) and examples/rtc-viewer-native/tests/native-ffi.check.ts runs this API on the built library.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  codecFromMime,
  CODECS,
  libraryCandidates,
  libraryFileName,
  type NativeBinding,
  STAT_FIELDS,
} from "../examples/rtc-viewer-native/lib/native.ts";
import {
  check,
  frameBytes,
  NativeViewer,
  parseStats,
  ViewerError,
} from "../examples/rtc-viewer-native/lib/viewer.ts";
import { negotiatedVideoCodec, preferDecodable } from "../examples/rtc-viewer-native/lib/sdp.ts";
import { createPump } from "../examples/rtc-viewer-native/lib/pump.ts";
import { type PeerLike, WhipReceiver } from "../examples/rtc-viewer-native/lib/receiver.ts";

const native = (path: string) =>
  Deno.readTextFileSync(
    fromFileUrl(new URL(`../examples/rtc-viewer-native/native/${path}`, import.meta.url)),
  );

// --- The ABI tables match the Rust source -------------------------------------------------------

Deno.test("rtc-viewer-native: STAT_FIELDS is native/src/stats.rs's FIELDS", () => {
  const source = native("src/stats.rs");
  const block = /pub const FIELDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const fields = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assertEquals(fields, [...STAT_FIELDS]);
});

Deno.test("rtc-viewer-native: CODECS are native/src/codec.rs's numbers", () => {
  const source = native("src/codec.rs");
  const rust = Object.fromEntries(
    [...source.matchAll(/^\s+(H264|H265|Vp9|Av1|Vp8) = (\d+),/gm)].map((m) => [
      m[1].toLowerCase(),
      Number(m[2]),
    ]),
  );
  assertEquals(rust, { ...CODECS });
});

Deno.test("rtc-viewer-native: the error codes are native/src/viewer.rs's", () => {
  const source = native("src/viewer.rs");
  const codes = [...source.matchAll(/Self::(\w+)(?:\(_\))? => (-\d+),/g)].map((m) => Number(m[2]));
  assertEquals(codes, [-1, -2, -3, -4, -5, -6, -7]);
  const named = codes.map((code) => {
    try {
      check(code, "x");
    } catch (err) {
      return (err as ViewerError).code;
    }
  });
  assertEquals(named, [
    "bad-argument",
    "unsupported-codec",
    "unsupported-platform",
    "platform",
    "not-main-thread",
    "already-open",
    "no-device",
  ]);
});

Deno.test("rtc-viewer-native: codecs from WebRTC MIME types", () => {
  assertEquals(codecFromMime("video/H264"), "h264");
  assertEquals(codecFromMime("video/H265"), "h265");
  assertEquals(codecFromMime("video/HEVC"), "h265");
  assertEquals(codecFromMime("video/VP9"), "vp9");
  assertEquals(codecFromMime("video/AV1"), "av1");
  assertEquals(codecFromMime("video/rtx"), null);
  assertEquals(codecFromMime("audio/opus"), null);
});

Deno.test("rtc-viewer-native: where the library is looked for", () => {
  assertEquals(libraryFileName("darwin"), "librtcviewer.dylib");
  assertEquals(libraryFileName("linux"), "librtcviewer.so");
  assertEquals(libraryFileName("windows"), "rtcviewer.dll");
  assertEquals(
    libraryCandidates({
      execPath: "/Applications/V.app/Contents/MacOS/v",
      cwd: "/p",
      os: "darwin",
      override: "/x/lib.dylib",
    }),
    [
      "/x/lib.dylib",
      "/Applications/V.app/Contents/MacOS/../Frameworks/librtcviewer.dylib",
      "/Applications/V.app/Contents/MacOS/librtcviewer.dylib",
      "/p/native/target/release/librtcviewer.dylib",
    ],
  );
  assertEquals(
    libraryCandidates({ execPath: "C:\\V\\v.exe", cwd: "C:\\p", os: "windows" }),
    ["C:\\V\\rtcviewer.dll", "C:\\p\\native\\target\\release\\rtcviewer.dll"],
  );
});

// --- The control API over a fake library --------------------------------------------------------

/** A fake library: records calls; `results` overrides what a function returns. */
function fakeBinding(results: Partial<Record<keyof NativeBinding, number>> = {}) {
  const calls: string[] = [];
  const pushed: Uint8Array[] = [];
  let next = 7;
  const binding: NativeBinding = {
    path: "/fake/librtcviewer.dylib",
    create: (codec, flags) => {
      calls.push(`create ${codec} ${flags}`);
      return results.create ?? next++;
    },
    setCodec: (id, codec) => {
      calls.push(`setCodec ${id} ${codec}`);
      return results.setCodec ?? 0;
    },
    push: (id, frame) => {
      calls.push(`push ${id} ${frame.byteLength}`);
      pushed.push(frame);
      return results.push ?? 0;
    },
    flush: () => 0,
    stats: (_id, out) => {
      out.fill(0);
      out[STAT_FIELDS.indexOf("pushed")] = pushed.length;
      out[STAT_FIELDS.indexOf("hardware")] = -1;
      out[STAT_FIELDS.indexOf("decodeP95")] = 1.5;
      return results.stats ?? out.length;
    },
    requestOpen: (id, display, fullscreen) => {
      calls.push(`requestOpen ${id} ${display} ${fullscreen}`);
      return results.requestOpen ?? 0;
    },
    requestClose: (id) => {
      calls.push(`requestClose ${id}`);
      return 0;
    },
    mainFn: () => Deno.UnsafePointer.create(0x1000n),
    startOffscreen: () => 0,
    stopOffscreen: () => 0,
    destroy: (id) => {
      calls.push(`destroy ${id}`);
      return 0;
    },
    close: () => {},
  };
  return { binding, calls, pushed };
}

/** A UI-thread runner that records what it was asked to call and answers `answer`. */
function fakeMain(answer = 0n) {
  const runs: { fn: bigint; context: bigint }[] = [];
  const run = (fn: Deno.PointerValue, context: Deno.PointerValue) => {
    runs.push({
      fn: Deno.UnsafePointer.value(fn) as bigint,
      context: Deno.UnsafePointer.value(context) as bigint,
    });
    return Promise.resolve(answer);
  };
  return { run, runs };
}

Deno.test("rtc-viewer-native: open runs rtcv_main on the UI thread with the viewer's id", async () => {
  const { binding, calls } = fakeBinding();
  const main = fakeMain();
  const viewer = NativeViewer.create(binding, main.run, "h265");
  assertEquals(viewer.id, 7);
  assertEquals(calls, ["create 2 0"]);
  await viewer.open();
  assertEquals(calls.at(-1), "requestOpen 7 0 true");
  assertEquals(main.runs, [{ fn: 0x1000n, context: 7n }]);
  assertEquals(viewer.window, { fullscreen: true, display: 0 });
  // The same options again: nothing to do.
  await viewer.open({ fullscreen: true, display: 0 });
  assertEquals(main.runs.length, 1);
  // Other options: close, then open there.
  await viewer.open({ fullscreen: false, display: 1.7 });
  assertEquals(calls.slice(-2), ["requestClose 7", "requestOpen 7 1 false"]);
  assertEquals(main.runs.length, 3);
  await viewer.hide();
  assertEquals(viewer.window, null);
  await viewer.hide(); // already hidden
  assertEquals(main.runs.length, 4);
});

Deno.test("rtc-viewer-native: a native refusal on the UI thread rejects open", async () => {
  const { binding } = fakeBinding();
  // rtcv_main's -5 comes back as an unsigned pointer-sized integer.
  const main = fakeMain(BigInt.asUintN(64, -5n));
  const viewer = NativeViewer.create(binding, main.run, "h264");
  const err = await assertRejects(() => viewer.open(), ViewerError);
  assertEquals(err.code, "not-main-thread");
  assertEquals(viewer.window, null);
  // The queue goes on after a failure.
  await viewer.close();
  assert(viewer.closed);
});

Deno.test("rtc-viewer-native: push takes encoded frames and reports what happened", () => {
  const { binding, pushed } = fakeBinding();
  const viewer = NativeViewer.create(binding, fakeMain().run, "h264");
  const bytes = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]);
  assertEquals(viewer.push(bytes), "queued");
  assertEquals(viewer.push(bytes.buffer), "queued");
  assertEquals(viewer.push({ data: bytes.buffer, type: "key" }), "queued");
  assertEquals(viewer.push({ data: bytes.buffer, type: "empty" }), "skipped");
  assertEquals(viewer.push(new ArrayBuffer(0)), "skipped");
  // A view is passed as its own bytes, without a copy.
  const view = new DataView(bytes.buffer, 4, 2);
  viewer.push(view);
  assertEquals(pushed.at(-1)!.buffer, bytes.buffer);
  assertEquals([...pushed.at(-1)!], [0x65, 1]);
  assertThrows(() => viewer.push("nope" as never), ViewerError);
  const waiting = fakeBinding({ push: 1 });
  assertEquals(
    NativeViewer.create(waiting.binding, fakeMain().run, "h264").push(bytes),
    "waiting-for-key-frame",
  );
  const refused = fakeBinding({ push: -4 });
  const err = assertThrows(
    () => NativeViewer.create(refused.binding, fakeMain().run, "h264").push(bytes),
    ViewerError,
  );
  assertEquals(err.code, "platform");
});

Deno.test("rtc-viewer-native: stats, codec switch and close", async () => {
  const { binding, calls } = fakeBinding();
  const viewer = NativeViewer.create(binding, fakeMain().run, "h264", { inspect: true });
  assertEquals(calls[0], "create 1 1");
  viewer.push(new Uint8Array([1]));
  const stats = viewer.stats();
  assertEquals(stats.codec, "h264");
  assertEquals(stats.pushed, 1);
  assertEquals(stats.hardware, null);
  assertEquals(stats.decode.p95, 1.5);
  viewer.setCodec("vp9");
  viewer.setCodec("vp9");
  assertEquals(calls.filter((c) => c.startsWith("setCodec")), ["setCodec 7 3"]);
  assertEquals(viewer.codec, "vp9");
  await viewer.open();
  await viewer.close();
  await viewer.close();
  assertEquals(calls.filter((c) => c.startsWith("destroy")), ["destroy 7"]);
  assertEquals(calls.at(-2), "requestClose 7");
  assertEquals(assertThrows(() => viewer.push(new Uint8Array([1])), ViewerError).code, "closed");
  assertThrows(() => viewer.stats(), ViewerError);
});

Deno.test("rtc-viewer-native: create refusals", () => {
  const { binding } = fakeBinding({ create: -2 });
  const err = assertThrows(() => NativeViewer.create(binding, fakeMain().run, "av1"), ViewerError);
  assertEquals(err.code, "unsupported-codec");
  assertThrows(
    () => NativeViewer.create(fakeBinding().binding, fakeMain().run, "mpeg2" as never),
    ViewerError,
  );
});

Deno.test("rtc-viewer-native: parseStats and frameBytes", () => {
  const values = new Float64Array(STAT_FIELDS.length);
  values[STAT_FIELDS.indexOf("hardware")] = 1;
  values[STAT_FIELDS.indexOf("windowOpen")] = 1;
  values[STAT_FIELDS.indexOf("totalMax")] = 9;
  const stats = parseStats("h265", values);
  assertEquals([stats.hardware, stats.windowOpen, stats.total.max], [true, true, 9]);
  assertEquals(frameBytes(new Uint8Array(0)), null);
  assertEquals(frameBytes(new Uint8Array([1, 2]))?.length, 2);
});

// --- SDP ------------------------------------------------------------------------------------------

const ANSWER = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 97 98 45",
  "a=rtpmap:97 rtx/90000",
  "a=rtpmap:98 H265/90000",
  "a=rtpmap:45 AV1/90000",
  "",
].join("\r\n");

Deno.test("rtc-viewer-native: the negotiated video codec", () => {
  assertEquals(negotiatedVideoCodec(ANSWER), "h265");
  assertEquals(negotiatedVideoCodec("v=0\r\nm=audio 9 RTP 0\r\n"), null);
  assertEquals(
    negotiatedVideoCodec("m=video 9 RTP 96\na=rtpmap:96 VP8/90000\nm=video 9 RTP 97\n"),
    "vp8",
  );
  assertEquals(negotiatedVideoCodec("m=video 9 RTP 96\na=rtpmap:96 rtx/90000\n"), null);
});

Deno.test("rtc-viewer-native: codec preferences keep what the viewer decodes", () => {
  const caps = [
    { mimeType: "video/VP8" },
    { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" },
    { mimeType: "video/rtx" },
    { mimeType: "video/VP9" },
    { mimeType: "video/H265" },
    { mimeType: "video/AV1" },
  ];
  assertEquals(preferDecodable(caps).map((c) => c.mimeType), [
    "video/H265",
    "video/H264",
    "video/VP9",
    "video/rtx",
  ]);
  assertEquals(preferDecodable(caps, "vp9").map((c) => c.mimeType)[0], "video/VP9");
});

// --- The worker's pump ----------------------------------------------------------------------------

Deno.test("rtc-viewer-native: the pump pushes frames and asks for key frames", () => {
  let clock = 1_000_000;
  let answer = 1;
  const pushes: number[] = [];
  let requests = 0;
  const pump = createPump({
    push: (bytes) => {
      pushes.push(bytes.byteLength);
      return answer;
    },
    requestKeyFrame: () => requests++,
    now: () => clock,
    receiveTimeOrigin: 999_000,
  });
  const frame = (n: number, receiveTime?: number, type = "delta") => ({
    data: new ArrayBuffer(n),
    type,
    getMetadata: () => ({ receiveTime }),
  });
  pump.frame(frame(10, 998)); // waiting for a key frame: one request
  pump.frame(frame(10)); // within 500 ms: no second request
  assertEquals(requests, 1);
  clock += 600;
  pump.frame(frame(10));
  assertEquals(requests, 2);
  answer = 0;
  pump.frame(frame(20, 1500)); // reassembled 100 ms ago on the window's clock
  pump.frame(frame(0));
  pump.frame(frame(5, undefined, "empty"));
  answer = -1;
  pump.frame(frame(5));
  const stats = pump.snapshot();
  assertEquals(pushes, [10, 10, 10, 20, 5]);
  assertEquals(
    [stats.frames, stats.bytes, stats.skipped, stats.refused, stats.keyFrameRequests],
    [4, 50, 2, 1, 2],
  );
  assertEquals(stats.handoffMax, 100);
  assertEquals(stats.handoffMean, (2 + 100) / 2);
  // The hand-off window restarts; the counters don't.
  assertEquals(pump.snapshot().handoffMax, 0);
  // A transform that is gone doesn't break the pump.
  const broken = createPump({
    push: () => 1,
    requestKeyFrame: () => {
      throw new Error("closed");
    },
    now: () => 0,
    receiveTimeOrigin: 0,
  });
  broken.frame(frame(1));
  assertEquals(broken.snapshot().keyFrameRequests, 1);
});

// --- The WHIP endpoint ----------------------------------------------------------------------------

class FakePeer implements PeerLike {
  connectionState = "new";
  iceGatheringState = "new";
  localDescription: { sdp: string } | null = null;
  ontrack: PeerLike["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  closed = false;
  preferences: unknown[] = [];
  transceivers = [{
    receiver: { track: { kind: "video" } },
    direction: "sendrecv",
    setCodecPreferences: (codecs: unknown[]) => {
      this.preferences = codecs;
    },
  }];
  constructor(readonly answer: string) {}
  setRemoteDescription() {
    this.ontrack?.({ receiver: "the-receiver", track: { kind: "video" } });
    return Promise.resolve();
  }
  createAnswer() {
    return Promise.resolve({ type: "answer" as const, sdp: this.answer });
  }
  setLocalDescription(desc: { sdp?: string }) {
    this.localDescription = { sdp: desc.sdp ?? "" };
    queueMicrotask(() => {
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.();
    });
    return Promise.resolve();
  }
  getTransceivers() {
    return this.transceivers;
  }
  close() {
    this.closed = true;
  }
}

function whip(answer = ANSWER) {
  const peers: FakePeer[] = [];
  const events: string[] = [];
  let n = 0;
  const receiver = new WhipReceiver({
    peer: () => {
      const p = new FakePeer(answer);
      peers.push(p);
      return p;
    },
    capabilities: () => [{ mimeType: "video/H264" }, { mimeType: "video/H265" }],
    attach: (r, id) => {
      events.push(`attach ${r} ${id}`);
      return { close: () => events.push(`detach ${id}`) };
    },
    ready: (codec, id) => {
      events.push(`ready ${codec} ${id}`);
    },
    ended: (id) => events.push(`ended ${id}`),
    newId: () => `s${++n}`,
  });
  const post = (body: string, type = "application/sdp") =>
    receiver.handle(
      new Request("http://127.0.0.1/whip", {
        method: "POST",
        headers: { "content-type": type },
        body,
      }),
    );
  return { receiver, peers, events, post };
}

Deno.test("rtc-viewer-native: WHIP answers an offer and ends the session on DELETE", async () => {
  const { receiver, peers, events, post } = whip();
  const res = await post("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n");
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("content-type"), "application/sdp");
  assertEquals(res.headers.get("location"), "/whip/s1");
  assertEquals(await res.text(), ANSWER);
  assertEquals(events, ["attach the-receiver s1", "ready h265 s1"]);
  assertEquals(peers[0].transceivers[0].direction, "recvonly");
  assertEquals(
    (peers[0].preferences as { mimeType: string }[]).map((c) => c.mimeType),
    ["video/H265", "video/H264"],
  );
  assertEquals(receiver.session()?.codec, "h265");

  const unknown = await receiver.handle(
    new Request("http://127.0.0.1/whip/nope", { method: "DELETE" }),
  );
  assertEquals(unknown.status, 404);
  await unknown.body?.cancel();
  const gone = await receiver.handle(new Request("http://127.0.0.1/whip/s1", { method: "DELETE" }));
  assertEquals(gone.status, 200);
  assert(peers[0].closed);
  assertEquals(events.slice(-2), ["detach s1", "ended s1"]);
  assertEquals(receiver.session(), null);
});

Deno.test("rtc-viewer-native: a second offer replaces the session", async () => {
  const { receiver, peers, post } = whip();
  await (await post("m=video 9 RTP 96\r\n")).body?.cancel();
  await (await post("m=video 9 RTP 96\r\n")).body?.cancel();
  assert(peers[0].closed);
  assert(!peers[1].closed);
  assertEquals(receiver.session()?.id, "s2");
  // The peer failing ends it.
  peers[1].connectionState = "failed";
  peers[1].onconnectionstatechange?.();
  assertEquals(receiver.session(), null);
});

Deno.test("rtc-viewer-native: WHIP refusals", async () => {
  const { receiver, post } = whip();
  const cases: [Promise<Response>, number][] = [
    [post("m=video 9 RTP 96\r\n", "text/plain"), 415],
    [post("v=0\r\nm=audio 9 RTP 0\r\n"), 400],
    [receiver.handle(new Request("http://127.0.0.1/whip")), 405],
    [receiver.handle(new Request("http://127.0.0.1/whip/s1", { method: "PATCH" })), 405],
    [receiver.handle(new Request("http://127.0.0.1/elsewhere")), 404],
    [receiver.handle(new Request("http://127.0.0.1/whip", { method: "OPTIONS" })), 204],
  ];
  for (const [response, status] of cases) {
    const res = await response;
    assertEquals(res.status, status);
    await res.body?.cancel();
  }
  // An answer with no codec the viewer decodes: 406, and the peer is closed.
  const vp8 = whip("m=video 9 RTP 96\r\na=rtpmap:96 VP8/90000\r\n");
  const res = await vp8.post("m=video 9 RTP 96\r\n");
  assertEquals(res.status, 406);
  await res.body?.cancel();
  assert(vp8.peers[0].closed);
  assertEquals(vp8.receiver.session(), null);
});

// --- File playback ----------------------------------------------------------------------------------

Deno.test("rtc-viewer-native: clips from files", async () => {
  const { parseClip, parseRecords, splitAnnexB } = await import(
    "../examples/rtc-viewer-native/lib/clip.ts"
  );
  // The fake camera's clip: 30 frames, the first a key frame with its parameter sets.
  const bin = Deno.readFileSync(
    fromFileUrl(
      new URL("../examples/rtc-viewer-native/native/tests/fixtures/h264.bin", import.meta.url),
    ),
  );
  const clip = parseClip("/x/h264.bin", bin);
  assertEquals(clip.codec, "h264");
  assertEquals(clip.frames.length, 30);
  // Joined back into one Annex B stream (each frame starts at its AUD), it splits the same way.
  const stream = new Uint8Array(clip.frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of clip.frames) {
    stream.set(f, at);
    at += f.length;
  }
  const units = splitAnnexB(stream, "h264");
  assertEquals(units.length, 30);
  assertEquals(units.map((u) => u.length), clip.frames.map((f) => f.length));
  assertEquals(parseClip("a.264", stream).frames.length, 30);
  assertEquals(parseClip("a.hevc", new Uint8Array([0, 0, 1, 70, 1])).codec, "h265");
  assertEquals(splitAnnexB(new Uint8Array([0, 0, 1, 0x65, 1]), "h264").length, 1); // no AUD
  assertEquals(splitAnnexB(new Uint8Array(0), "h264").length, 0);
  // A truncated record ends the list.
  assertEquals(parseRecords(new Uint8Array([2, 0, 0, 0, 9, 9, 5, 0, 0, 0, 1])).length, 1);
  assertThrows(() => parseClip("clip.bin", bin), Error, "after its codec");
  assertThrows(() => parseClip("clip.mp4", bin), Error, ".bin clip or an Annex B");
});
