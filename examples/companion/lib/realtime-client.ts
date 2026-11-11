// The page's WebRTC connection to OpenAI's Realtime API, with an ephemeral client secret from the
// backend (lib/voice-backend.ts): the microphone track goes up, the model's voice comes back as a
// remote track, and JSON events travel on the `oai-events` data channel.
//
// https://developers.openai.com/api/docs/guides/voice-webrtc ("Connecting using an ephemeral
// token"): POST the SDP offer to `/v1/realtime/calls` with `Authorization: Bearer <secret>` and
// `Content-Type: application/sdp`; the answer is the SDP to set as the remote description.
//
// The microphone track is disabled outside a push-to-talk turn, so nothing is heard between turns.
// The browser APIs are injected, so the flow is unit-tested with fakes.

/** Where the SDP offer goes. */
export const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** The data channel the Realtime API's events travel on. */
export const EVENTS_CHANNEL = "oai-events";

/** Why the microphone could not be opened. */
export type MicProblem = "no_api" | "denied" | "no_device" | "failed";

/** The microphone could not be opened (see {@linkcode micErrorMessage}). */
export class MicUnavailableError extends Error {
  override readonly name = "MicUnavailableError";
  constructor(readonly problem: MicProblem) {
    super(`microphone unavailable: ${problem}`);
  }
}

/** What {@linkcode openMicrophone} needs: `navigator.mediaDevices`, or none. */
export type MediaDevicesLike = Pick<MediaDevices, "getUserMedia"> | undefined;

/** Open the microphone, or throw a {@linkcode MicUnavailableError} saying why not. */
export async function openMicrophone(devices: MediaDevicesLike): Promise<MediaStream> {
  if (typeof devices?.getUserMedia !== "function") throw new MicUnavailableError("no_api");
  try {
    return await devices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicUnavailableError("denied");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new MicUnavailableError("no_device");
    }
    throw new MicUnavailableError("failed");
  }
}

/**
 * What to tell the user when the microphone could not be opened.
 *
 * In the desktop app only the packaged app has the microphone (`desktop.capabilities.microphone`,
 * granted to the window's own origin); a `denext desktop run` / `dev` window is refused every
 * request, as is an app the OS keeps from the microphone (macOS's Privacy & Security, Windows'
 * privacy switches).
 *
 * @param problem Why the microphone didn't open.
 * @param desktop Running in the desktop app.
 * @param reason Windows: which privacy switch refuses (`appCapabilities().microphoneAccessReason`).
 */
export function micErrorMessage(
  problem: MicProblem,
  desktop: boolean,
  reason?: string | null,
): string {
  if (desktop) return desktopMicMessage(problem, reason ?? null);
  switch (problem) {
    case "no_api":
      return "This page has no microphone access (it needs https or localhost).";
    case "denied":
      return "Microphone permission was denied. Allow it in the browser's site settings.";
    case "no_device":
      return "I can't find a microphone.";
    case "failed":
      return "The microphone didn't start.";
  }
}

/**
 * Why a session could not open, worded for the user. A microphone the desktop app is refused asks
 * `blockedReason` which Windows privacy switch is off, if one is (`null` elsewhere).
 */
export async function openProblem(
  err: unknown,
  desktop: boolean,
  blockedReason: () => Promise<string | null>,
): Promise<string> {
  if (!(err instanceof MicUnavailableError)) {
    return (err as Error)?.message || "I couldn't start listening.";
  }
  const reason = desktop && err.problem === "denied"
    ? await blockedReason().catch(() => null)
    : null;
  return micErrorMessage(err.problem, desktop, reason);
}

/** {@linkcode micErrorMessage} in the desktop app. */
function desktopMicMessage(problem: MicProblem, reason: string | null): string {
  switch (problem) {
    case "no_api":
      return "This window has no microphone. The packaged app has one " +
        "(`denext task desktop:package`); or talk to me in a browser with `denext task dev`.";
    case "denied":
      if (reason) return `I can't hear you: ${reason}.`;
      return "I can't hear you: the microphone is blocked. Allow Loopy under Microphone in your " +
        "system's privacy settings. A `denext task desktop` window never has the microphone; " +
        "the packaged app (`denext task desktop:package`) does.";
    case "no_device":
      return "I can't find a microphone.";
    case "failed":
      return "The microphone didn't start.";
  }
}

/** The browser APIs a connection needs (tests pass fakes). */
export interface RealtimeDeps {
  readonly RTCPeerConnection: typeof RTCPeerConnection;
  readonly fetch: typeof fetch;
}

/** An open Realtime session. */
export interface RealtimeConnection {
  /** Send a client event (dropped while the channel is not open). */
  send(event: Record<string, unknown>): void;
  /** Turn the microphone track on or off (off: nothing is sent). */
  setMicOn(on: boolean): void;
  /** Close the connection and stop the microphone. */
  close(): void;
}

/** What {@linkcode connectRealtime} needs. */
export interface ConnectOptions {
  /** The ephemeral client secret. */
  readonly secret: string;
  /** The open microphone. */
  readonly mic: MediaStream;
  /** Each server event from the data channel. */
  readonly onEvent: (event: { type: string } & Record<string, unknown>) => void;
  /** The model's voice, as a stream to play and measure. */
  readonly onRemoteStream: (stream: MediaStream) => void;
  /** The connection failed or closed. */
  readonly onClose: () => void;
  readonly deps?: RealtimeDeps;
}

/** Wait for the data channel to open (or fail). */
function channelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.addEventListener("open", () => resolve(), { once: true });
    channel.addEventListener("close", () => reject(new Error("data channel closed")), {
      once: true,
    });
  });
}

/** The SDP answer for `offer`, from OpenAI. */
async function exchangeSdp(doFetch: typeof fetch, secret: string, offer: string): Promise<string> {
  const res = await doFetch(CALLS_URL, {
    method: "POST",
    body: offer,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/sdp" },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`OpenAI refused the voice connection (${res.status}).`);
  }
  return await res.text();
}

/** Parse one data-channel message, or `null` when it isn't an event. */
function parseEvent(data: unknown): ({ type: string } & Record<string, unknown>) | null {
  if (typeof data !== "string") return null;
  try {
    const e = JSON.parse(data);
    return typeof e?.type === "string" ? e : null;
  } catch {
    return null;
  }
}

/**
 * Open a Realtime session over WebRTC. The microphone starts disabled.
 *
 * @returns The connection, once the data channel is open.
 */
export async function connectRealtime(options: ConnectOptions): Promise<RealtimeConnection> {
  const deps = options.deps ?? { RTCPeerConnection, fetch: fetch.bind(globalThis) };
  const pc = new deps.RTCPeerConnection();
  const tracks = options.mic.getAudioTracks();
  for (const t of tracks) {
    t.enabled = false;
    pc.addTrack(t, options.mic);
  }
  pc.ontrack = (e) => options.onRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
  const channel = pc.createDataChannel(EVENTS_CHANNEL);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const t of options.mic.getTracks()) t.stop();
    try {
      channel.close();
      pc.close();
    } catch { /* already closed */ }
  };
  channel.addEventListener("message", (e) => {
    const event = parseEvent((e as MessageEvent).data);
    if (event) options.onEvent(event);
  });
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await exchangeSdp(deps.fetch, options.secret, offer.sdp ?? "");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    await channelOpen(channel);
  } catch (err) {
    close();
    throw err;
  }
  channel.addEventListener("close", () => {
    close();
    options.onClose();
  });
  return {
    send(event) {
      if (!closed && channel.readyState === "open") channel.send(JSON.stringify(event));
    },
    setMicOn(on) {
      for (const t of tracks) t.enabled = on;
    },
    close,
  };
}
