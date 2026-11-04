// The companion's whole state: Loopy's move (lib/loopy-machine.ts) and the queue of messages
// waiting to be said, the first one on screen. A pure reducer, so the page component stays thin
// and the flow is unit-tested: a message springs Loopy up in its mood, the next one takes over
// when a bubble closes, and folding up drops them all.

import { INITIAL_MODEL, type LoopyEvent, type LoopyModel, transition } from "./loopy-machine.ts";
import type { LoopyMessage } from "./messages.ts";

/** The most messages waiting behind the one on screen; more are dropped. */
export const MAX_QUEUE = 20;

/** Loopy's move and the messages to say. */
export interface CompanionModel {
  readonly loopy: LoopyModel;
  /** The message on screen first, then the waiting ones. */
  readonly queue: readonly LoopyMessage[];
}

/** What can happen: one of Loopy's own events, or a message arriving, finishing, or all dropped. */
export type CompanionEvent =
  | LoopyEvent
  | { readonly type: "enqueue"; readonly message: LoopyMessage }
  | { readonly type: "finish"; readonly id: string }
  | { readonly type: "foldUp" };

/** Nothing to say, folded away. */
export const INITIAL_COMPANION: CompanionModel = { loopy: INITIAL_MODEL, queue: [] };

/** Loopy's move for `message` coming on screen. */
const sayIt = (loopy: LoopyModel, message: LoopyMessage) =>
  transition(loopy, { type: "say", mood: message.mood });

/** A new message: on screen at once when nothing else is, else at the back of the queue. */
function enqueue(model: CompanionModel, message: LoopyMessage): CompanionModel {
  if (model.queue.length > MAX_QUEUE) return model;
  const queue = [...model.queue, message];
  return { queue, loopy: model.queue.length === 0 ? sayIt(model.loopy, message) : model.loopy };
}

/** The message on screen is done: say the next one, or settle down. */
function finish(model: CompanionModel, id: string): CompanionModel {
  if (model.queue[0]?.id !== id) return model;
  const queue = model.queue.slice(1);
  const loopy = queue.length > 0
    ? sayIt(model.loopy, queue[0])
    : transition(model.loopy, { type: "settle" });
  return { queue, loopy };
}

/** The next model for `event`. */
export function companionReducer(model: CompanionModel, event: CompanionEvent): CompanionModel {
  switch (event.type) {
    case "enqueue":
      return enqueue(model, event.message);
    case "finish":
      return finish(model, event.id);
    case "foldUp":
      return { queue: [], loopy: transition(model.loopy, { type: "dismiss" }) };
    default:
      return { ...model, loopy: transition(model.loopy, event) };
  }
}
