// A WHIP sender for the demo: the runtime's fake camera (`DENO_FAKE_MEDIA_DEVICES=1`: a moving
// test card, 640×480 at 30 fps, pre-encoded in every codec) published to the viewer's WHIP
// endpoint. `denext task send [-- --codec h265] [--url http://127.0.0.1:8189/whip] [--seconds 60]`.
//
// Needs a runtime with media devices (3.0.0-denext.26 or later). Ctrl-C ends the session (a WHIP
// DELETE), as does `--seconds`.

const args = { codec: "h264", url: "http://127.0.0.1:8189/whip", seconds: "0" };
for (let i = 0; i < Deno.args.length; i++) {
  const [flag, inline] = Deno.args[i].split("=", 2);
  const key = flag.replace(/^--/, "") as keyof typeof args;
  if (!(key in args)) {
    console.error(`unknown option ${flag} (--codec, --url, --seconds)`);
    Deno.exit(2);
  }
  args[key] = inline ?? Deno.args[++i] ?? "";
}
const mime =
  ({ h264: "video/H264", h265: "video/H265", vp9: "video/VP9" } as Record<string, string>)[
    args.codec
  ];
if (!mime) {
  console.error("--codec is h264, h265 or vp9");
  Deno.exit(2);
}
if (!navigator.mediaDevices?.getUserMedia) {
  console.error("this runtime has no media devices (needs denext's runtime 3.0.0-denext.26+)");
  Deno.exit(1);
}

const stream = await navigator.mediaDevices.getUserMedia({ video: true });
const [track] = stream.getVideoTracks();
const pc = new RTCPeerConnection();
const transceiver = pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
// Offer the chosen codec only (plus retransmission), so the viewer decodes what was asked for.
const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
const chosen = codecs.filter((c) =>
  c.mimeType.toLowerCase() === mime.toLowerCase() || /\/rtx$/i.test(c.mimeType)
);
if (chosen.length) transceiver.setCodecPreferences(chosen);

await pc.setLocalDescription(await pc.createOffer());
await new Promise<void>((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  const timer = setTimeout(resolve, 2000);
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === "complete") {
      clearTimeout(timer);
      resolve();
    }
  };
});

const response = await fetch(args.url, {
  method: "POST",
  headers: { "content-type": "application/sdp" },
  body: pc.localDescription!.sdp,
});
if (response.status !== 201) {
  console.error(`WHIP ${response.status}: ${await response.text()}`);
  Deno.exit(1);
}
const session = new URL(response.headers.get("location")!, args.url);
await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
console.log(`sending ${args.codec} to ${args.url} (session ${session.pathname}); Ctrl-C to stop`);
pc.onconnectionstatechange = () => console.log(`connection: ${pc.connectionState}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await fetch(session, { method: "DELETE" }).then((r) => r.body?.cancel()).catch(() => {});
  pc.close();
  track.stop();
  Deno.exit(0);
}
Deno.addSignalListener("SIGINT", stop);
const seconds = Number(args.seconds);
if (seconds > 0) setTimeout(stop, seconds * 1000);
