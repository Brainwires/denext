// Which page navigations Loopy's browser lets through while it acts. A navigation that posts (a
// form submitted by a click, or by the page's own script after one) is held while one of Loopy's
// actions runs and for a moment after, until the user says yes; a GET goes through, and so does
// everything the user does in the window themselves between Loopy's actions. A confirmed action
// runs with posts allowed. Pure apart from the clock, so it is unit-tested; voice/chrome.ts feeds
// it Chrome's paused requests (CDP `Fetch.requestPaused`).

/** How long after an action a post it caused is still held (a script may submit a beat later). */
export const GUARD_GRACE_MS = 1_500;

/** How long a confirmed action may post. */
export const APPROVED_MS = 10_000;

/** A paused navigation request. */
export interface PausedRequest {
  readonly method: string;
  readonly url: string;
}

/** What to do with a paused navigation. */
export type GateDecision = "continue" | "hold" | "fail";

/** The gate. */
export interface PostGate {
  /** An action starts (posts are held from now). */
  begin(): void;
  /** The action ended (posts stay held for {@linkcode GUARD_GRACE_MS}). */
  end(): void;
  /** Allow posts for {@linkcode APPROVED_MS} (the user said yes). */
  approve(): void;
  /**
   * The decision for a paused navigation: `continue` for a GET or HEAD, outside an action, or
   * while approved; `hold` for the first post during an action; `fail` for another one while one
   * is already held.
   */
  decide(request: PausedRequest, holding: boolean): GateDecision;
}

/** Whether `method` only reads. */
const reads = (method: string) => method === "GET" || method === "HEAD";

/** A post gate on `now`. */
export function createPostGate(now: () => number = Date.now): PostGate {
  let active = 0;
  let guardUntil = 0;
  let approvedUntil = 0;
  return {
    begin() {
      active++;
    },
    end() {
      active = Math.max(0, active - 1);
      guardUntil = now() + GUARD_GRACE_MS;
    },
    approve() {
      approvedUntil = now() + APPROVED_MS;
    },
    decide(request, holding) {
      if (reads(request.method.toUpperCase())) return "continue";
      const t = now();
      if (t < approvedUntil) return "continue";
      if (active === 0 && t >= guardUntil) return "continue";
      return holding ? "fail" : "hold";
    },
  };
}
