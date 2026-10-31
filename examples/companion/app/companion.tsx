// Loopy on screen: the companion reducer (lib/companion-state.ts), the desktop event stream other
// programs' messages arrive on, the window chrome (lib/window-setup.ts) and, when turned on, its
// bubbles read aloud with the OS's voice (lib/speech.ts). In a browser (`denext dev`) the same
// component renders in the page with a row of demo buttons.
"use client";
import { useEffect, useReducer, useRef, useState } from "denext";
import type { Dispatch, RefObject } from "denext";
import { onDesktopEvent } from "denext/desktop/client";
import { speak, stopSpeaking } from "denext/mobile";
import { Loopy } from "../components/Loopy.tsx";
import { SpeechBubble } from "../components/SpeechBubble.tsx";
import {
  type CompanionEvent,
  companionReducer,
  INITIAL_COMPANION,
} from "../lib/companion-state.ts";
import { type LoopyModel, nextTimer } from "../lib/loopy-machine.ts";
import { type LoopyMessage, parseSayRequest, type SayRequest } from "../lib/messages.ts";
import { dragWindowBy, quit, setupWindow } from "../lib/window-setup.ts";
import { readAloudOn, saveReadAloud, spokenText } from "../lib/speech.ts";

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
): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    let alive = true;
    let unfollow = () => {};
    const enqueue = (message: LoopyMessage) => dispatch({ type: "enqueue", message });
    // Clicks go through the transparent window everywhere but Loopy, its bubble and its buttons
    // (the elements marked `data-loopy-hit` under the page's root, followed as they come and go).
    setupWindow(rootRef.current).then((setup) => {
      if (!alive) return setup.stop();
      unfollow = setup.stop;
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

/** The read-aloud toggle. */
function VoiceToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title="Read Loopy's messages aloud"
      onClick={() => onChange(!on)}
    >
      {on ? "Voice on" : "Voice off"}
    </button>
  );
}

/** Fold up / Call Loopy, the read-aloud toggle, and Quit on desktop. */
function Controls(
  { shown, desktop, readAloud, onReadAloud, onFold, onCall }: {
    shown: boolean;
    desktop: boolean;
    readAloud: boolean;
    onReadAloud: (on: boolean) => void;
    onFold: () => void;
    onCall: () => void;
  },
) {
  return (
    <nav class="controls" data-loopy-hit="">
      <button type="button" onClick={shown ? onFold : onCall}>
        {shown ? "Fold up" : "Call Loopy"}
      </button>
      <VoiceToggle on={readAloud} onChange={onReadAloud} />
      {desktop && <button type="button" onClick={() => void quit()}>Quit</button>}
    </nav>
  );
}

/** The browser view's demo buttons. */
function Demo({ onSay }: { onSay: (message: LoopyMessage) => void }) {
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

/** Loopy, its bubble, and (in a browser) the demo buttons. */
export function Companion() {
  const [model, dispatch] = useReducer(companionReducer, INITIAL_COMPANION);
  const stageRef = useRef<HTMLDivElement>(null);
  const squashRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const desktop = useDesktop(dispatch, stageRef, rootRef);
  useTimedMoves(model.loopy, dispatch);
  const current = model.queue[0];
  const [readAloud, setReadAloud] = useReadAloud(current);
  const shown = model.loopy.state !== "hidden";
  const enqueue = (message: LoopyMessage) => dispatch({ type: "enqueue", message });

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
    if (!current) enqueue(local({ text: POKE_LINES[Math.floor(Math.random() * 4)] }));
  };

  return (
    <main class={`companion${desktop ? " is-desktop" : ""}`} ref={rootRef}>
      <BubbleSlot message={current} onFinish={finish} />
      <div class="stage" ref={stageRef}>
        <div class="squash" ref={squashRef} data-loopy-hit="">
          <Loopy state={model.loopy.state} />
          {shown && <button type="button" class="poke" aria-label="Poke Loopy" onClick={poke} />}
        </div>
      </div>
      <Controls
        shown={shown}
        desktop={desktop}
        readAloud={readAloud}
        onReadAloud={setReadAloud}
        onFold={foldUp}
        onCall={() => dispatch({ type: "show" })}
      />
      {!desktop && <Demo onSay={enqueue} />}
    </main>
  );
}
