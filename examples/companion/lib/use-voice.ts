// Loopy's voice in the page: one hook that opens a Realtime session on the first turn (the
// microphone, an ephemeral secret from the backend, WebRTC), runs push-to-talk turns on it, relays
// the model's tool calls to the backend, and measures the two audio levels Loopy is drawn from (the
// microphone while listening, Loopy's voice while speaking). The session closes after a few idle
// minutes and opens again on the next turn.
"use client";
import { useEffect, useReducer, useRef, useState } from "denext";
import type { LoopyMood } from "./loopy-machine.ts";
import { levelStep, rmsLevel, smoothLevel } from "./lip-sync.ts";
import {
  connectRealtime,
  micErrorMessage,
  MicUnavailableError,
  openMicrophone,
  type RealtimeConnection,
} from "./realtime-client.ts";
import { relayToolCalls } from "./tool-relay.ts";
import type { VoiceBackend } from "./voice-backend.ts";
import { INITIAL_VOICE, type ServerEvent, type VoiceModel, voiceReducer } from "./voice-machine.ts";

/** A turn shorter than this is a slip of the key: dropped, not sent. */
const MIN_TURN_MS = 250;

/** How long an idle session stays open. */
const IDLE_CLOSE_MS = 3 * 60_000;

/** What {@linkcode useVoice} returns. */
export interface VoiceControls {
  readonly voice: VoiceModel;
  /** The lip-sync step while speaking, the microphone's while listening (0–4). */
  readonly level: number;
  /** Start a turn (opens the session first when there is none). */
  readonly begin: () => void;
  /** Send the turn (or drop it when it was too short). */
  readonly end: () => void;
  /** Start a turn, or send the one in progress. */
  readonly toggle: () => void;
  /** Hide the transcript. */
  readonly clear: () => void;
}

/** The audio graph that measures a stream's level. */
interface Meter {
  readonly analyser: AnalyserNode;
  readonly buffer: Uint8Array<ArrayBuffer>;
}

/** A meter on `stream` in `ctx` (not routed to the speakers: the audio element plays it). */
function meter(ctx: AudioContext, stream: MediaStream): Meter {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return { analyser, buffer: new Uint8Array(analyser.fftSize) };
}

/** The current RMS level of a meter. */
function sample(m: Meter | null): number {
  if (!m) return 0;
  m.analyser.getByteTimeDomainData(m.buffer);
  return rmsLevel(m.buffer);
}

/** The page's audio context (made on the first turn, a user gesture), or `null` without one. */
function audioContext(): AudioContext | null {
  try {
    return typeof AudioContext === "function" ? new AudioContext() : null;
  } catch {
    return null;
  }
}

/** The live parts of a session. */
interface Session {
  conn: RealtimeConnection | null;
  ctx: AudioContext | null;
  mic: Meter | null;
  out: Meter | null;
  audio: HTMLAudioElement | null;
  round: number;
  listenSince: number;
  wantListen: boolean;
}

const newSession = (): Session => ({
  conn: null,
  ctx: null,
  mic: null,
  out: null,
  audio: null,
  round: 0,
  listenSince: 0,
  wantListen: false,
});

/** Close everything a session holds. */
function teardown(s: Session): void {
  s.conn?.close();
  s.audio?.pause();
  void s.ctx?.close().catch(() => {});
  Object.assign(s, newSession());
}

/** The level loop: the steps Loopy is drawn from, set only when they change. */
function useLevels(
  session: { current: Session },
  phase: VoiceModel["phase"],
): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (phase !== "listening" && phase !== "speaking") {
      setLevel(0);
      return;
    }
    let smoothed = 0;
    let shown = -1;
    let frame = 0;
    const tick = () => {
      const s = session.current;
      smoothed = smoothLevel(smoothed, sample(phase === "speaking" ? s.out : s.mic));
      const step = levelStep(smoothed);
      if (step !== shown) setLevel(shown = step);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);
  return level;
}

/** Play the model's voice and measure it. */
function playRemote(s: Session, stream: MediaStream): void {
  s.audio ??= new Audio();
  s.audio.autoplay = true;
  s.audio.srcObject = stream;
  s.out = s.ctx ? meter(s.ctx, stream) : null;
}

/**
 * Open a session into `s`: the audio context, the microphone (measured), an ephemeral secret from
 * the backend and the WebRTC connection.
 */
async function openSession(
  s: Session,
  backend: VoiceBackend,
  on: { onEvent: (e: ServerEvent) => void; onClose: () => void },
): Promise<void> {
  s.ctx = audioContext();
  const mic = await openMicrophone(globalThis.navigator?.mediaDevices);
  s.mic = s.ctx ? meter(s.ctx, mic) : null;
  const secret = await backend.session();
  s.conn = await connectRealtime({
    secret: secret.value,
    mic,
    onEvent: (e) => on.onEvent(e as ServerEvent),
    onRemoteStream: (stream) => playRemote(s, stream),
    onClose: on.onClose,
  });
}

/** Why a session could not open, worded for the user. */
function openProblem(err: unknown, desktop: boolean): string {
  if (err instanceof MicUnavailableError) return micErrorMessage(err.problem, desktop);
  return (err as Error)?.message || "I couldn't start listening.";
}

/**
 * Loopy's voice.
 *
 * @param backend The voice backend (lib/voice-backend.ts).
 * @param desktop Running in the desktop app (for the microphone message).
 * @param onMood Called with each mood the model sets.
 */
export function useVoice(
  backend: VoiceBackend,
  desktop: boolean,
  onMood: (mood: LoopyMood) => void,
): VoiceControls {
  const [voice, dispatch] = useReducer(voiceReducer, INITIAL_VOICE);
  const latest = useRef(voice);
  latest.current = voice;
  const session = useRef<Session>(newSession());
  const level = useLevels(session, voice.phase);
  const moodRef = useRef(onMood);
  moodRef.current = onMood;

  const onEvent = (event: ServerEvent) => {
    dispatch({ type: "server", event });
    if (event.type !== "response.done") return;
    const s = session.current;
    void relayToolCalls(event, {
      call: (c) => backend.tool(c),
      send: (e) => s.conn?.send(e),
      onMood: (mood) => {
        dispatch({ type: "mood", mood });
        moodRef.current(mood);
      },
      round: ++s.round,
    });
  };

  const startListening = () => {
    const s = session.current;
    if (!s.conn) return;
    if (latest.current.phase === "speaking" || latest.current.phase === "thinking") {
      s.conn.send({ type: "response.cancel" });
      s.conn.send({ type: "output_audio_buffer.clear" });
    }
    s.conn.send({ type: "input_audio_buffer.clear" });
    s.conn.setMicOn(true);
    s.listenSince = Date.now();
    s.round = 0;
    dispatch({ type: "listen" });
  };

  const open = async () => {
    const s = session.current;
    dispatch({ type: "connect" });
    try {
      await openSession(s, backend, {
        onEvent,
        onClose: () => {
          teardown(s);
          dispatch({ type: "closed" });
        },
      });
      dispatch({ type: "connected" });
      if (s.wantListen) startListening();
    } catch (err) {
      teardown(s);
      dispatch({ type: "failed", message: openProblem(err, desktop), closed: true });
    }
  };

  const begin = () => {
    const s = session.current;
    s.wantListen = true;
    void s.ctx?.resume().catch(() => {});
    if (latest.current.phase === "listening") return;
    if (latest.current.phase === "off") void open();
    else if (latest.current.phase !== "connecting") startListening();
  };

  const end = () => {
    const s = session.current;
    s.wantListen = false;
    if (latest.current.phase !== "listening" || !s.conn) return;
    s.conn.setMicOn(false);
    if (Date.now() - s.listenSince < MIN_TURN_MS) {
      s.conn.send({ type: "input_audio_buffer.clear" });
      dispatch({ type: "cancel" });
      return;
    }
    s.conn.send({ type: "input_audio_buffer.commit" });
    s.conn.send({ type: "response.create" });
    dispatch({ type: "send" });
  };

  // Close a session nobody has used for a while; and everything on unmount.
  useEffect(() => {
    if (voice.phase !== "ready") return;
    const timer = setTimeout(() => {
      teardown(session.current);
      dispatch({ type: "closed" });
    }, IDLE_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [voice.phase]);
  useEffect(() => () => teardown(session.current), []);

  return {
    voice,
    level,
    begin,
    end,
    toggle: () =>
      latest.current.phase === "listening" || latest.current.phase === "connecting"
        ? end()
        : begin(),
    clear: () => dispatch({ type: "clear" }),
  };
}
