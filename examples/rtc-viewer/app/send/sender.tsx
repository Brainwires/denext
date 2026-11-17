"use client";
// The sender page: picks a source (the camera through getUserMedia, or a canvas test pattern),
// optionally a codec, and joins the room as its sender (lib/rtc/peers.ts).

import { useEffect, useRef, useState } from "denext";
import { startSender } from "../../lib/rtc/peers.ts";
import { hubUrl } from "../../lib/signal/client.ts";
import { startPattern } from "../../lib/test-pattern.ts";

type SourceKind = "pattern" | "camera";

/** Codecs the viewer's WebCodecs path can name (lib/pipeline/codec.ts); "auto" leaves it be. */
const CODECS = ["auto", "video/VP8", "video/VP9", "video/H264", "video/AV1"];

async function openSource(
  kind: SourceKind,
): Promise<{ track: MediaStreamTrack; stop(): void }> {
  if (kind === "pattern") return startPattern();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720 },
    audio: false,
  });
  const [track] = stream.getVideoTracks();
  return { track, stop: () => track.stop() };
}

/** Puts `mimeType` first in the transceiver's codec list (where the engine allows it). */
function preferCodec(transceiver: RTCRtpTransceiver, mimeType: string): void {
  const all = RTCRtpReceiver.getCapabilities?.("video")?.codecs ?? [];
  const chosen = all.filter((c) => c.mimeType.toLowerCase() === mimeType.toLowerCase());
  if (!chosen.length || !transceiver.setCodecPreferences) return;
  transceiver.setCodecPreferences([
    ...chosen,
    ...all.filter((c) => !chosen.includes(c)),
  ]);
}

export function Sender() {
  const preview = useRef<HTMLVideoElement>(null);
  const [kind, setKind] = useState<SourceKind>("pattern");
  const [codec, setCodec] = useState("auto");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [room, setRoom] = useState("demo");

  useEffect(() => {
    setRoom(new URLSearchParams(location.search).get("room") || "demo");
  }, []);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let cleanup = () => {};
    const note = (line: string) => setLog((lines) => [...lines.slice(-7), line]);
    openSource(kind).then((source) => {
      if (stopped) return source.stop();
      preview.current!.srcObject = new MediaStream([source.track]);
      const sender = startSender({
        url: hubUrl(location),
        room,
        track: source.track,
        rtcConfig: {
          iceServers: new URLSearchParams(location.search).getAll("ice").map((
            urls,
          ) => ({ urls })),
        },
        prepare: codec === "auto" ? undefined : (t) => preferCodec(t, codec),
        onStatus: note,
      });
      cleanup = () => {
        sender.close();
        source.stop();
      };
    }, (err) => {
      note(`source: ${err}`);
      setRunning(false);
    });
    return () => {
      stopped = true;
      cleanup();
    };
  }, [running]);

  return (
    <div class="sender">
      <h1>Sender</h1>
      <p>
        Every viewer in room <strong>{room}</strong> receives this. Open{" "}
        <a href={`/?room=${room}`}>the viewer</a> in another tab or device.
      </p>
      <div class="row">
        <label>
          Source{" "}
          <select
            value={kind}
            disabled={running}
            onChange={(e) => setKind((e.target as HTMLSelectElement).value as SourceKind)}
          >
            <option value="pattern">Test pattern (canvas)</option>
            <option value="camera">Camera (getUserMedia)</option>
          </select>
        </label>
        <label>
          Codec{" "}
          <select
            value={codec}
            disabled={running}
            onChange={(e) => setCodec((e.target as HTMLSelectElement).value)}
          >
            {CODECS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setRunning((on) => !on)}>
          {running ? "Stop" : "Start sending"}
        </button>
      </div>
      <video ref={preview} class="preview" playsInline muted autoPlay />
      <pre class="log">{log.join("\n") || "idle"}</pre>
    </div>
  );
}
