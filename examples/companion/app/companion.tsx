// Loopy on screen: the companion reducer (lib/companion-state.ts), the desktop event stream other
// programs' messages arrive on, the window chrome (lib/window-setup.ts) and, when turned on, its
// bubbles read aloud with the OS's voice (lib/speech.ts). In a browser (`denext dev`) the same
// component renders in the page with a row of demo buttons.
//
// Voice (lib/use-voice.ts): hold Space, click Loopy, or press the global shortcut to talk to Loopy
// through OpenAI's Realtime API; the transcripts show in the bubble, Loopy listens, thinks and
// lip-syncs, and the model sets its mood. Tools (web search, a browser window, memory) run on the
// Deno side; a web search's sources show as links that open in the user's browser, and a browser
// action that would submit something asks in the bubble first. The settings panel turns each way
// of talking and each tool on or off, takes the API key (write-only), lists and forgets memories,
// and sets Loopy's size.
"use client";
import { useEffect, useMemo, useReducer, useRef, useState } from "denext";
import type { Dispatch, RefObject } from "denext";
import { onDesktopEvent } from "denext/desktop/client";
import { registerShortcut } from "denext/desktop/app";
import { openExternal, speak, stopSpeaking } from "denext/mobile";
import { Loopy } from "../components/Loopy.tsx";
import { SpeechBubble } from "../components/SpeechBubble.tsx";
import { VoiceBubble } from "../components/VoiceBubble.tsx";
import { VoiceSettings } from "../components/VoiceSettings.tsx";
import {
  type CompanionEvent,
  type CompanionModel,
  companionReducer,
  INITIAL_COMPANION,
} from "../lib/companion-state.ts";
import {
  type LoopyModel,
  type LoopyMood,
  type LoopyState,
  nextTimer,
} from "../lib/loopy-machine.ts";
import { type LoopyMessage, parseSayRequest, type SayRequest } from "../lib/messages.ts";
import { dragWindowBy, quit, setupWindow, type WindowSetup } from "../lib/window-setup.ts";
import { readAloudOn, saveReadAloud, spokenText } from "../lib/speech.ts";
import { useVoice, type VoiceControls } from "../lib/use-voice.ts";
import type { KeyStatus, MemoryItem, VoiceBackend } from "../lib/voice-backend.ts";
import { voiceBackend } from "../lib/voice-bridge.ts";
import { transcriptHoldMs, type VoiceModel, voiceNudge, voiceStage } from "../lib/voice-machine.ts";
import {
  DEFAULT_SETTINGS,
  featuresOf,
  GLOBAL_SHORTCUT,
  loadSettings,
  type LoopySettings,
  saveSettings,
  scaleFromQuery,
} from "../lib/voice-settings.ts";

/** Where the page answers a message's buttons (desktop.ts routes it to the inbox). */
const REPLY_PATH = "/_loopy/reply";

/** Things Loopy says when poked. Its own lines. */
const POKE_LINES = ["Boing!", "Still here, still springy.", "Careful, I'm load-bearing.", "Hi!"];

/** The demo messages the browser view offers. */
const DEMOS: ReadonlyArray<{ label: string; say: SayRequest }> = [
  { label: "Hello", say: { text: "Hello! I'm Loopy. I hold things together." } },
  { label: "Think", say: { text: "Hmm, let me turn that over…", mood: "thinking" } },
  { label: "Point", say: { text: "Over here! Something needs you.", mood: "attention" } },
  { label: "Cheer", say: { text: "All done. Nicely bent!", mood: "success" } },
  {
    label: "Ask",
    say: {
      text: "Shall I keep an eye on things?",
      actions: [{ id: "yes", label: "Yes" }, { id: "no", label: "Not now" }],
    },
  },
];

/** A message built on the page (Loopy's own lines and the demos). */
const local = (say: SayRequest): LoopyMessage => parseSayRequest(say).message;

/** Squash and stretch, through the Web Animations API where the engine has it. */
function squash(el: Element | null): void {
  const target = el as (Element & { animate?: Element["animate"] }) | null;
  if (typeof target?.animate !== "function") return;
  target.animate([
    { transform: "scale(1, 1)" },
    { transform: "scale(1.18, 0.8)", offset: 0.3 },
    { transform: "scale(0.9, 1.12)", offset: 0.6 },
    { transform: "scale(1.03, 0.97)", offset: 0.85 },
    { transform: "scale(1, 1)" },
  ], { duration: 420, easing: "ease-out" });
}

/** Tell a sender waiting on `message`'s buttons what happened (`null`: closed unanswered). */
function reply(desktop: boolean, message: LoopyMessage, actionId: string | null): void {
  if (!desktop || message.actions.length === 0) return;
  fetch(REPLY_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: message.id, action: actionId }),
  }).then((r) => r.body?.cancel(), () => {});
}

/** Loopy's first words. */
function hello(desktop: boolean): LoopyMessage {
  const how = desktop ? "Programs can talk to me through my inbox." : "Try the buttons.";
  return local({ text: `Hi, I'm Loopy! ${how}` });
}

/** Make `el` drag the window; returns the undo. */
function dragRegion(el: HTMLElement | null): () => void {
  return el ? dragWindowBy(el) : () => {};
}

/**
 * The window chrome, the drag region, the inbox's messages and a hello, once. Returns whether
 * this is a desktop window.
 */
function useDesktop(
  dispatch: Dispatch<CompanionEvent>,
  stageRef: RefObject<HTMLDivElement | null>,
  rootRef: RefObject<HTMLElement | null>,
  windowRef: RefObject<WindowSetup | null>,
): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    let alive = true;
    let unfollow = () => {};
    const enqueue = (message: LoopyMessage) => dispatch({ type: "enqueue", message });
    // Clicks go through the transparent window everywhere but Loopy, its bubble and its buttons
    // (the elements marked `data-loopy-hit` under the page's root, followed as they come and go).
    setupWindow(rootRef.current, initialScale()).then((setup) => {
      if (!alive) return setup.stop();
      unfollow = setup.stop;
      windowRef.current = setup;
      setDesktop(setup.desktop);
      enqueue(hello(setup.desktop));
    });
    const undrag = dragRegion(stageRef.current);
    const stop = onDesktopEvent<LoopyMessage>("loopy", "say", enqueue);
    dispatch({ type: "show" });
    return () => {
      alive = false;
      unfollow();
      undrag();
      stop();
    };
  }, []);
  return desktop;
}

/** End timed moves on time, and blink now and then while idle. */
function useTimedMoves(loopy: LoopyModel, dispatch: Dispatch<CompanionEvent>): void {
  useEffect(() => {
    const next = nextTimer(loopy.state);
    if (!next) return;
    const timer = setTimeout(() => dispatch(next.event), next.ms);
    return () => clearTimeout(timer);
  }, [loopy]);
}

/** Loopy's size at launch: `?scale=` (dev), else the kept setting. */
function initialScale(): number {
  const query = typeof location === "undefined" ? undefined : scaleFromQuery(location.search);
  return query ?? loadSettings(pageStorage()).scale;
}

/**
 * The kept settings, with a `?scale=` query (dev) taking the size's place until the slider moves.
 * Returns them and the setter (which keeps them).
 */
function useSettings(): [LoopySettings, (next: LoopySettings) => void] {
  const [settings, setSettings] = useState<LoopySettings>(DEFAULT_SETTINGS);
  useEffect(() => setSettings({ ...loadSettings(pageStorage()), scale: initialScale() }), []);
  const update = (next: LoopySettings) => {
    saveSettings(pageStorage(), next);
    setSettings(next);
  };
  return [settings, update];
}

/** Resize the desktop window when the size setting changes (the first size is set up front). */
function useWindowScale(windowRef: RefObject<WindowSetup | null>, scale: number): void {
  useEffect(() => {
    void windowRef.current?.rescale(scale);
  }, [scale]);
}

/** Hold Space to talk while the page has the focus (not while typing in a field). */
function usePushToTalk(on: boolean, controls: VoiceControls): void {
  const ref = useRef(controls);
  ref.current = controls;
  useEffect(() => {
    if (!on) return;
    const typing = (e: KeyboardEvent) =>
      (e.target as Element | null)?.closest?.("input, textarea, [contenteditable]") != null;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e)) return;
      e.preventDefault();
      if (!e.repeat) ref.current.begin();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e)) return;
      e.preventDefault();
      ref.current.end();
    };
    globalThis.addEventListener("keydown", down);
    globalThis.addEventListener("keyup", up);
    return () => {
      globalThis.removeEventListener("keydown", down);
      globalThis.removeEventListener("keyup", up);
    };
  }, [on]);
}

/**
 * The global shortcut (desktop): press to talk, press again to send. Returns why it could not be
 * registered, if it couldn't.
 */
function useGlobalShortcut(on: boolean, controls: VoiceControls): string | null {
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef(controls);
  ref.current = controls;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let release = () => {};
    registerShortcut(GLOBAL_SHORTCUT, () => ref.current.toggle()).then((s) => {
      setProblem(null);
      if (alive) release = () => void s.unregister().catch(() => {});
      else void s.unregister().catch(() => {});
    }, (err) => setProblem((err as Error)?.message || "The shortcut could not be registered."));
    return () => {
      alive = false;
      release();
    };
  }, [on]);
  return problem;
}

/** The backend's word on the key, asked again whenever `ask` changes. */
function useVoiceStatus(
  backend: VoiceBackend,
  ask: unknown,
): [KeyStatus | null, (s: KeyStatus) => void] {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  useEffect(() => {
    let alive = true;
    backend.status().then((s) => alive && setStatus(s), () => {});
    return () => {
      alive = false;
    };
  }, [backend, ask]);
  return [status, setStatus];
}

/** Hide the transcript a while after a turn ends. */
function useTranscriptTimeout(voice: VoiceModel, clear: () => void): void {
  const hold = transcriptHoldMs(voice);
  useEffect(() => {
    if (hold === null) return;
    const timer = setTimeout(clear, hold);
    return () => clearTimeout(timer);
  }, [voice.phase, hold]);
}

/** The page's storage, where the read-aloud toggle is kept (none during SSR). */
function pageStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read each bubble aloud while `on` (the OS's voice; see lib/speech.ts), and stop when it closes.
 * Returns the toggle's state and its setter.
 */
function useReadAloud(message: LoopyMessage | undefined): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(readAloudOn(pageStorage())), []);
  useEffect(() => {
    if (!on || !message) return;
    void speak(spokenText(message)).catch(() => {}); // no engine here: the bubble alone
    return () => void stopSpeaking();
  }, [on, message?.id]);
  const toggle = (next: boolean) => {
    saveReadAloud(pageStorage(), next);
    setOn(next);
  };
  return [on, toggle];
}

/** The speech bubble for the message on screen, if any. */
function BubbleSlot(
  { message, onFinish }: {
    message: LoopyMessage | undefined;
    onFinish: (message: LoopyMessage, actionId: string | null) => void;
  },
) {
  return (
    <div class="bubble-slot">
      {message && (
        <SpeechBubble
          key={message.id}
          message={message}
          onAction={(id) => onFinish(message, id)}
          onClose={() => onFinish(message, null)}
        />
      )}
    </div>
  );
}

/** The read-aloud toggle (kept under its old storage key, lib/speech.ts). */
function ReadAloudToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title="Read Loopy's messages aloud"
      onClick={() => onChange(!on)}
    >
      {on ? "Read aloud on" : "Read aloud off"}
    </button>
  );
}

/** Fold up / Call Loopy, the read-aloud toggle, and Quit on desktop. */
function Controls(
  { shown, desktop, readAloud, onReadAloud, onFold, onCall, onSettings }: {
    shown: boolean;
    desktop: boolean;
    readAloud: boolean;
    onReadAloud: (on: boolean) => void;
    onFold: () => void;
    onCall: () => void;
    onSettings: () => void;
  },
) {
  return (
    <nav class="controls" data-loopy-hit="">
      <button type="button" onClick={shown ? onFold : onCall}>
        {shown ? "Fold up" : "Call Loopy"}
      </button>
      <ReadAloudToggle on={readAloud} onChange={onReadAloud} />
      <button type="button" aria-label="Settings" title="Settings" onClick={onSettings}>⚙</button>
      {desktop && <button type="button" onClick={() => void quit()}>Quit</button>}
    </nav>
  );
}

/** The browser view's demo buttons (none in the desktop window). */
function Demo(
  { desktop, onSay }: { desktop: boolean; onSay: (message: LoopyMessage) => void },
) {
  if (desktop) return null;
  return (
    <section class="demo" aria-label="Try Loopy's moods">
      {DEMOS.map((d) => (
        <button type="button" key={d.label} onClick={() => onSay(local(d.say))}>
          {d.label}
        </button>
      ))}
    </section>
  );
}

/** The click target over Loopy's face: talk (click-to-talk) or poke, while Loopy is shown. */
function PokeTarget(
  { shown, clickToTalk, onPoke }: { shown: boolean; clickToTalk: boolean; onPoke: () => void },
) {
  if (!shown) return null;
  const label = clickToTalk ? "Talk to Loopy" : "Poke Loopy";
  return <button type="button" class="poke" aria-label={label} onClick={onPoke} />;
}

/** Loopy on its stage, in the mood of the message on screen, with the poke target while shown. */
function Stage(
  { stageRef, squashRef, state, mood, voice, level, clickToTalk, onPoke }: {
    stageRef: RefObject<HTMLDivElement>;
    squashRef: RefObject<HTMLDivElement>;
    state: LoopyState;
    mood: LoopyMood | undefined;
    voice: "listening" | "thinking" | "speaking" | undefined;
    level: number;
    clickToTalk: boolean;
    onPoke: () => void;
  },
) {
  return (
    <div class="stage" ref={stageRef}>
      <div class="squash" ref={squashRef} data-loopy-hit="">
        <Loopy
          state={state}
          mood={mood}
          voice={voice}
          level={level}
        />
        <PokeTarget shown={state !== "hidden"} clickToTalk={clickToTalk} onPoke={onPoke} />
      </div>
    </div>
  );
}

/** Loopy follows a voice turn: it springs up for one, and a held mood move ends with it. */
function useLoopyFollowsVoice(
  phase: VoiceModel["phase"],
  model: CompanionModel,
  dispatch: Dispatch<CompanionEvent>,
): void {
  useEffect(() => {
    const event = voiceNudge(phase, model.loopy.state, model.queue.length > 0);
    if (event) dispatch(event);
  }, [phase]);
}

/** What Loopy remembers, asked for whenever the panel opens; and forgetting. */
function useMemories(backend: VoiceBackend, open: boolean) {
  const [memories, setMemories] = useState<readonly MemoryItem[] | null>(null);
  const reload = () => backend.memories().then(setMemories, () => setMemories([]));
  useEffect(() => {
    if (!open) {
      setMemories(null);
      return;
    }
    void reload();
  }, [backend, open]);
  return {
    memories,
    forget: (id: number) => void backend.forget(id).then(reload, reload),
    forgetAll: () => void backend.forgetAll().then(reload, reload),
  };
}

/** The settings panel's state, the backend's word on the key, and the memories. */
function useSettingsPanel(backend: VoiceBackend) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useVoiceStatus(backend, open);
  const memory = useMemories(backend, open);
  const keyResult = (p: Promise<KeyStatus>) =>
    p.then((s) => (setStatus(s), null), (err) => (err as Error).message);
  return {
    open,
    status,
    ...memory,
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    setKey: (key: string) => keyResult(backend.setKey(key)),
    clearKey: () => keyResult(backend.clearKey()),
  };
}

/** Everything voice: the settings, the backend, the turns and the ways to start one. */
function useCompanionVoice(
  dispatch: Dispatch<CompanionEvent>,
  desktop: boolean,
  windowRef: RefObject<WindowSetup | null>,
) {
  const [settings, setSettings] = useSettings();
  useWindowScale(windowRef, settings.scale);
  const backend = useMemo(() => voiceBackend(desktop), [desktop]);
  const panel = useSettingsPanel(backend);
  // A mood the model sets plays its move too (a hop for success, a point for attention, …).
  const features = useMemo(() => featuresOf(settings), [
    settings.webSearch,
    settings.browser,
    settings.memory,
  ]);
  const controls = useVoice(backend, desktop, (mood) => dispatch({ type: "say", mood }), features);
  usePushToTalk(settings.pushToTalk, controls);
  const shortcutProblem = useGlobalShortcut(desktop && settings.globalShortcut, controls);
  useTranscriptTimeout(controls.voice, controls.clear);
  return { settings, setSettings, panel, controls, shortcutProblem };
}

/** The settings panel, while it is open. */
function SettingsPanel(
  { panel, settings, onChange, desktop, shortcutProblem }: {
    panel: ReturnType<typeof useSettingsPanel>;
    settings: LoopySettings;
    onChange: (settings: LoopySettings) => void;
    desktop: boolean;
    shortcutProblem: string | null;
  },
) {
  if (!panel.open) return null;
  return (
    <VoiceSettings
      settings={settings}
      onChange={onChange}
      status={panel.status}
      onSetKey={panel.setKey}
      onClearKey={panel.clearKey}
      desktop={desktop}
      shortcutProblem={shortcutProblem}
      memories={panel.memories}
      onForget={panel.forget}
      onForgetAll={panel.forgetAll}
      onClose={panel.close}
    />
  );
}

/** Open a source link in the user's own browser (the system browser on desktop). */
function openLink(url: string): void {
  void openExternal(url).catch(() => {});
}

/** The bubble on screen: the voice turn's while one is up, else the message's. */
function Bubbles(
  { voice, voiceUp, message, onClear, onAnswer, onFinish }: {
    voice: VoiceModel;
    voiceUp: boolean;
    message: LoopyMessage | undefined;
    onClear: () => void;
    onAnswer: (approved: boolean) => void;
    onFinish: (message: LoopyMessage, actionId: string | null) => void;
  },
) {
  if (!voiceUp) return <BubbleSlot message={message} onFinish={onFinish} />;
  return (
    <div class="bubble-slot">
      <VoiceBubble voice={voice} onClose={onClear} onAnswer={onAnswer} onOpenLink={openLink} />
    </div>
  );
}

/** Loopy, its bubble, and (in a browser) the demo buttons. */
export function Companion() {
  const [model, dispatch] = useReducer(companionReducer, INITIAL_COMPANION);
  const stageRef = useRef<HTMLDivElement>(null);
  const squashRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const windowRef = useRef<WindowSetup | null>(null);
  const desktop = useDesktop(dispatch, stageRef, rootRef, windowRef);
  useTimedMoves(model.loopy, dispatch);
  const current = model.queue[0];
  const [readAloud, setReadAloud] = useReadAloud(current);
  const enqueue = (message: LoopyMessage) => dispatch({ type: "enqueue", message });
  const { settings, setSettings, panel, controls, shortcutProblem } = useCompanionVoice(
    dispatch,
    desktop,
    windowRef,
  );
  const { voice } = controls;
  useLoopyFollowsVoice(voice.phase, model, dispatch);
  const stage = voiceStage(voice, model.loopy.state, current);

  const finish = (message: LoopyMessage, actionId: string | null) => {
    reply(desktop, message, actionId);
    dispatch({ type: "finish", id: message.id });
  };
  const foldUp = () => {
    for (const m of model.queue) reply(desktop, m, null);
    dispatch({ type: "foldUp" });
  };
  const poke = () => {
    squash(squashRef.current);
    if (settings.clickToTalk) controls.toggle();
    else if (!current) enqueue(local({ text: POKE_LINES[Math.floor(Math.random() * 4)] }));
  };

  return (
    <main
      class={desktop ? "companion is-desktop" : "companion"}
      ref={rootRef}
      style={{ "--loopy-scale": settings.scale / 100 }}
    >
      <Bubbles
        voice={voice}
        voiceUp={stage.voiceUp}
        message={current}
        onClear={controls.clear}
        onAnswer={controls.answer}
        onFinish={finish}
      />
      <Stage
        stageRef={stageRef}
        squashRef={squashRef}
        state={stage.state}
        mood={stage.mood}
        voice={stage.voice}
        level={controls.level}
        clickToTalk={settings.clickToTalk}
        onPoke={poke}
      />
      <Controls
        shown={model.loopy.state !== "hidden"}
        desktop={desktop}
        readAloud={readAloud}
        onReadAloud={setReadAloud}
        onFold={foldUp}
        onCall={() => dispatch({ type: "show" })}
        onSettings={panel.toggle}
      />
      <Demo desktop={desktop} onSay={enqueue} />
      <SettingsPanel
        panel={panel}
        settings={settings}
        onChange={setSettings}
        desktop={desktop}
        shortcutProblem={shortcutProblem}
      />
    </main>
  );
}
