// Which requests Loopy's browser lets through while it acts. Every request that isn't a plain read
// — a form submit, a script's `fetch` / XHR POST, a beacon, of any resource type — is held while one
// of Loopy's actions runs and for a moment after, until the user says yes; a GET, HEAD or CORS
// preflight goes through, and so does everything the page does while Loopy isn't acting (the user's
// own clicks in the window). A confirmed action runs with writes allowed; the yes ends when an
// action the user didn't approve starts. Pure apart from the
// clock, so it is unit-tested; voice/chrome.ts feeds it Chrome's paused requests (CDP
// `Fetch.requestPaused`) and the tools ask the user about what it holds (voice/browser-tools.ts).

/** How long after an action a write it caused is still held (a script may send a beat later). */
export const GUARD_GRACE_MS = 1_500;

/** How long a confirmed action may write. */
export const APPROVED_MS = 10_000;

/** A paused request. */
export interface PausedRequest {
  readonly method: string;
  readonly url: string;
}

/** What to do with a paused request. */
export type GateDecision = "continue" | "hold";

/** The gate. */
export interface PostGate {
  /** An action starts (writes are held from now). */
  begin(): void;
  /** The action ended (writes stay held for {@linkcode GUARD_GRACE_MS}). */
  end(): void;
  /** Allow writes for {@linkcode APPROVED_MS} (the user said yes). */
  approve(): void;
  /** Take a yes back (an action the user didn't approve starts). */
  revoke(): void;
  /** Whether writes are being held now (an action runs, or its grace hasn't passed). */
  guarding(): boolean;
  /** Whether the user's yes still lets writes through. */
  approvedNow(): boolean;
  /**
   * The decision for a paused request: `continue` for a read (GET, HEAD, OPTIONS), outside an
   * action and its grace, or while approved; else `hold`.
   */
  decide(request: PausedRequest): GateDecision;
}

/** The methods that only read (OPTIONS: a CORS preflight; the request it clears is held). */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A gate on `now`. */
export function createPostGate(now: () => number = Date.now): PostGate {
  let active = 0;
  let guardUntil = 0;
  let approvedUntil = 0;
  const guarding = () => active > 0 || now() < guardUntil;
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
    revoke() {
      approvedUntil = 0;
    },
    guarding,
    approvedNow: () => now() < approvedUntil,
    decide(request) {
      if (READS.has(request.method.toUpperCase())) return "continue";
      if (now() < approvedUntil || !guarding()) return "continue";
      return "hold";
    },
  };
}
