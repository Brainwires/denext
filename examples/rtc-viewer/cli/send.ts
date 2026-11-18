// The CLI sender: joins a room on the app's signalling hub and sends video to every viewer with
// the runtime's own WebRTC (denext's Deno has `RTCPeerConnection`).
//
//   deno task send                       # http://127.0.0.1:3000, room "demo"
//   deno task send --url http://host:3000 --room lab --size 640x360 --fps 15
//
// The source, with `--source auto` (the default):
//   1. a camera from `navigator.mediaDevices.getUserMedia()`: the runtime's fake camera with
//      `DENO_FAKE_MEDIA_DEVICES=1` (a runtime that has it; see the README);
//   2. else a generated test pattern, encoded here as H.264 I_PCM frames (cli/h264.ts) and fed to
//      a `Deno.webrtc.EncodedMediaTrack`, which works on any runtime with WebRTC media.

import { startSender } from "../lib/rtc/peers.ts";
import { encodeFrame, H264_FMTP } from "./h264.ts";
import { testPattern } from "./pattern.ts";

/** The parsed command line. */
export interface SendOptions {
  url: string;
  room: string;
  width: number;
  height: number;
  fps: number;
  source: "auto" | "camera" | "pattern";
  /** STUN / TURN URLs (`--ice stun:stun.l.google.com:19302`, repeatable). */
  ice: string[];
}

const USAGE = `usage: send.ts [--url http://127.0.0.1:3000] [--room demo] [--size 320x180]
                [--fps 15] [--source auto|camera|pattern] [--ice stun:host:port]...`;

/** What each option does to the options being read. */
const OPTIONS: Record<string, (options: SendOptions, value: string) => void> = {
  "--url": (o, v) => o.url = v,
  "--room": (o, v) => o.room = v,
  "--fps": (o, v) => o.fps = Number(v),
  "--ice": (o, v) => o.ice.push(v),
  "--size": (o, v) => {
    const m = /^(\d+)x(\d+)$/.exec(v);
    if (!m) throw new Error(`--size is WIDTHxHEIGHT, got ${v}`);
    [o.width, o.height] = [Number(m[1]), Number(m[2])];
  },
  "--source": (o, v) => {
    if (v !== "auto" && v !== "camera" && v !== "pattern") {
      throw new Error(`--source is auto, camera or pattern, got ${v}`);
    }
    o.source = v;
  },
};

/** Reads `args` (`--name value` pairs) into {@link SendOptions}; throws on a bad one. */
export function parseSendArgs(args: string[]): SendOptions {
  const options: SendOptions = {
    url: "http://127.0.0.1:3000",
    room: "demo",
    width: 320,
    height: 180,
    fps: 15,
    source: "auto",
    ice: [],
  };
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i], args[i + 1]];
    const apply = Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : undefined;
    if (!apply) throw new Error(`unknown option ${name}\n${USAGE}`);
    if (value === undefined) throw new Error(`${name} needs a value\n${USAGE}`);
    apply(options, value);
  }
  if (!(options.fps > 0 && options.fps <= 60)) throw new Error("--fps is 1–60");
  const { width, height } = options;
  if (width % 2 || height % 2 || Math.min(width, height) < 16) {
    throw new Error("--size needs even dimensions of at least 16");
  }
  return options;
}

/** A video source the sender offers. */
export interface Source {
  track: MediaStreamTrack;
  label: string;
  stop(): void;
}

/** The runtime's camera (`DENO_FAKE_MEDIA_DEVICES=1` gives a fake one), else `null`. */
async function cameraSource(): Promise<Source | null> {
  const media = (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
  if (typeof media?.getUserMedia !== "function") return null;
  const stream = await media.getUserMedia({ video: true, audio: false });
  const [track] = stream.getVideoTracks();
  if (!track) return null;
  return {
    track,
    label: `camera "${track.label}"`,
    stop: () => track.stop(),
  };
}

/** The generated pattern as H.264 I_PCM on an `EncodedMediaTrack`, `fps` frames a second. */
export function patternSource(
  width: number,
  height: number,
  fps: number,
): Source {
  const webrtc = (Deno as unknown as { webrtc?: typeof Deno.webrtc }).webrtc;
  if (!webrtc?.EncodedMediaTrack) {
    throw new Error(
      "this Deno has no Deno.webrtc.EncodedMediaTrack: run it with `denext`'s Deno",
    );
  }
  const track = new webrtc.EncodedMediaTrack({
    kind: "video",
    mimeType: "video/H264",
    sdpFmtpLine: H264_FMTP,
    label: "test pattern",
  });
  let index = 0;
  const duration = 1000 / fps;
  const timer = setInterval(() => {
    track.writeFrame(encodeFrame(testPattern(width, height, index), index), {
      duration,
    });
    index++;
  }, duration);
  return {
    track,
    label: `test pattern ${width}x${height} @ ${fps} fps (H.264 I_PCM)`,
    stop() {
      clearInterval(timer);
      track.stop();
    },
  };
}

/** Picks the source `options.source` names (see the header). */
async function openSource(options: SendOptions): Promise<Source> {
  if (options.source !== "pattern") {
    const camera = await cameraSource().catch(() => null);
    if (camera) return camera;
    if (options.source === "camera") {
      throw new Error(
        "no camera: this runtime has no navigator.mediaDevices.getUserMedia " +
          "(the fake camera, DENO_FAKE_MEDIA_DEVICES=1, needs a runtime that has it)",
      );
    }
  }
  return patternSource(options.width, options.height, options.fps);
}

if (import.meta.main) {
  let options: SendOptions;
  try {
    options = parseSendArgs(Deno.args);
  } catch (err) {
    console.error((err as Error).message);
    Deno.exit(2);
  }
  const source = await openSource(options);
  const hub = new URL("/api/signal", options.url);
  const sender = startSender({
    url: hub,
    room: options.room,
    track: source.track,
    rtcConfig: { iceServers: options.ice.map((urls) => ({ urls })) },
    onStatus: (s) => console.log(`[send] ${s}`),
  });
  console.log(
    `[send] ${source.label} → ${hub} room "${options.room}" (Ctrl-C stops)`,
  );
  Deno.addSignalListener("SIGINT", () => {
    sender.close();
    source.stop();
    Deno.exit(0);
  });
}
