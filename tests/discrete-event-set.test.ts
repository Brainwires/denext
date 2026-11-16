// Pins denext's discrete-event set to React DOM's `getEventPriority` (ReactDOMEventListener):
// a commit an update from one of these causes runs its passive effects at its end, and pending
// passive effects flush before one is dispatched. Every other event keeps the deferred flush,
// as React's continuous and default priorities do.
import { assertEquals } from "@std/assert";
import { beginEventDispatch, endEventDispatch } from "../src/client/event-priority.ts";

/** React DOM's DiscreteEventPriority cases, verbatim. */
const REACT_DISCRETE = [
  "cancel",
  "click",
  "close",
  "contextmenu",
  "copy",
  "cut",
  "auxclick",
  "dblclick",
  "dragend",
  "dragstart",
  "drop",
  "focusin",
  "focusout",
  "input",
  "invalid",
  "keydown",
  "keypress",
  "keyup",
  "mousedown",
  "mouseup",
  "paste",
  "pause",
  "play",
  "pointercancel",
  "pointerdown",
  "pointerup",
  "ratechange",
  "reset",
  "resize",
  "seeked",
  "submit",
  "touchcancel",
  "touchend",
  "touchstart",
  "volumechange",
  "change",
  "selectionchange",
  "textInput",
  "compositionstart",
  "compositionend",
  "compositionupdate",
  "beforeblur",
  "afterblur",
  "beforeinput",
  "blur",
  "fullscreenchange",
  "focus",
  "hashchange",
  "popstate",
  "select",
  "selectstart",
];

/** React DOM's ContinuousEventPriority cases, verbatim. */
const REACT_CONTINUOUS = [
  "drag",
  "dragenter",
  "dragexit",
  "dragleave",
  "dragover",
  "mousemove",
  "mouseout",
  "mouseover",
  "pointermove",
  "pointerout",
  "pointerover",
  "scroll",
  "toggle",
  "touchmove",
  "wheel",
  "mouseenter",
  "mouseleave",
  "pointerenter",
  "pointerleave",
];

/** A sample of events React gives DefaultEventPriority, near-misses of discrete names included. */
const REACT_DEFAULT = [
  "message",
  "load",
  "error",
  "abort",
  "playing",
  "durationchange",
  "timeupdate",
  "progress",
  "loadeddata",
  "canplay",
  "ended",
  "emptied",
  "seeking",
  "waiting",
  "devicechange",
  "visibilitychange",
  "animationend",
  "transitionend",
  "keyboard",
  "clicked",
  "inputs",
  "selected",
  "focuschange",
  "beforeunload",
  "storage",
  "online",
  "offline",
];

function isDiscrete(type: string): boolean {
  const d = beginEventDispatch(type);
  endEventDispatch(d);
  return d;
}

Deno.test("discrete event set: every React DiscreteEventPriority event is discrete", () => {
  assertEquals(REACT_DISCRETE.filter((t) => !isDiscrete(t)), []);
});

Deno.test("discrete event set: React's continuous events are not discrete", () => {
  assertEquals(REACT_CONTINUOUS.filter(isDiscrete), []);
});

Deno.test("discrete event set: React's default-priority events are not discrete", () => {
  assertEquals(REACT_DEFAULT.filter(isDiscrete), []);
});
