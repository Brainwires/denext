// Loopy's animation state machine: a pure reducer the page runs with `useReducer`. Each state is
// one of Loopy's moves (styles.css draws them from the `data-state` attribute); the timed ones end
// on their own when the page sends `settle` after {@linkcode stateDurationMs}.
//
//   hidden ─show/say─▶ appear ─settle─▶ idle ◀─settle─ blink / celebrate
//                                       │ ▲
//                         say(mood) ────┘ └──── settle ─ think / point (held while a bubble is up)
//   any visible state ─dismiss─▶ dismiss ─settle─▶ hidden

/** A move Loopy can be in. */
export type LoopyState =
  | "hidden"
  | "appear"
  | "idle"
  | "blink"
  | "think"
  | "point"
  | "celebrate"
  | "dismiss";

/** How a message wants Loopy to look while it speaks. */
export type LoopyMood = "neutral" | "thinking" | "attention" | "success";

/** Every mood, for validation. */
export const MOODS: readonly LoopyMood[] = ["neutral", "thinking", "attention", "success"];

/** What the machine holds. */
export interface LoopyModel {
  /** The move on screen. */
  readonly state: LoopyState;
  /** The mood to take once an `appear` lands (a message that arrived while Loopy was hidden). */
  readonly pendingMood: LoopyMood | null;
}

/** What can happen to Loopy. */
export type LoopyEvent =
  | { readonly type: "show" }
  | { readonly type: "say"; readonly mood: LoopyMood }
  | { readonly type: "blink" }
  | { readonly type: "settle" }
  | { readonly type: "dismiss" };

/** Where Loopy starts: folded away until the page shows it. */
export const INITIAL_MODEL: LoopyModel = { state: "hidden", pendingMood: null };

/** The move a mood maps to. */
export function moodState(mood: LoopyMood): LoopyState {
  switch (mood) {
    case "thinking":
      return "think";
    case "attention":
      return "point";
    case "success":
      return "celebrate";
    case "neutral":
      return "idle";
  }
}

/**
 * How long a timed move lasts before the page sends `settle` (its CSS animation is the same
 * length), or `null` for a move that holds until something else happens.
 */
export function stateDurationMs(state: LoopyState): number | null {
  switch (state) {
    case "appear":
      return 650;
    case "blink":
      return 160;
    case "celebrate":
      return 1200;
    case "dismiss":
      return 450;
    default:
      return null;
  }
}

/**
 * What the page should send on its own, and after how long: `settle` once a timed move ends, or a
 * `blink` 2.5–6 s into an idle spell. `null` while a move holds.
 *
 * @param state The move on screen.
 * @param random A number in [0, 1) that picks the blink delay (`Math.random` by default).
 */
export function nextTimer(
  state: LoopyState,
  random: () => number = Math.random,
): { readonly event: LoopyEvent; readonly ms: number } | null {
  if (state === "idle") return { event: { type: "blink" }, ms: 2_500 + random() * 3_500 };
  const ms = stateDurationMs(state);
  return ms === null ? null : { event: { type: "settle" }, ms };
}

/** Whether Loopy is on screen (anything but `hidden` and the fold-away). */
export function isVisible(state: LoopyState): boolean {
  return state !== "hidden" && state !== "dismiss";
}

const at = (state: LoopyState, pendingMood: LoopyMood | null = null): LoopyModel => ({
  state,
  pendingMood,
});

/** Where `settle` goes from the current move. */
function settled(model: LoopyModel): LoopyModel {
  switch (model.state) {
    case "appear":
      return at(model.pendingMood ? moodState(model.pendingMood) : "idle");
    case "blink":
    case "celebrate":
    case "think":
    case "point":
      return at("idle");
    case "dismiss":
      return at("hidden");
    default:
      return model;
  }
}

/**
 * The next model for `event`. Unknown or meaningless events (a blink while hidden, a settle while
 * idle) return the model unchanged, so the page may send them freely.
 */
export function transition(model: LoopyModel, event: LoopyEvent): LoopyModel {
  switch (event.type) {
    case "show":
      return model.state === "hidden" || model.state === "dismiss" ? at("appear") : model;
    case "say":
      // Hidden (or folding away): spring back up first, then take the mood.
      if (!isVisible(model.state)) return at("appear", event.mood);
      // Still landing: take the mood once the landing ends.
      if (model.state === "appear") return at("appear", event.mood);
      return at(moodState(event.mood));
    case "blink":
      return model.state === "idle" ? at("blink") : model;
    case "settle":
      return settled(model);
    case "dismiss":
      return isVisible(model.state) ? at("dismiss") : model;
  }
}
