// What the backend's admin endpoint reports about Edge Functions: the deployed functions (their
// names, `verifyJwt` and when their file last changed) and the recent invocations, kept in a
// small bounded ring in this process. An invocation records only its function, status, duration
// and time: never a request body, a header, a query or a caller — nothing a request carried.

/** One finished invocation. */
export interface Invocation {
  /** The function. */
  readonly name: string;
  /** The response status (`0` when the call threw before answering). */
  readonly status: number;
  /** How long it took, ms. */
  readonly ms: number;
  /** When it finished (epoch ms). */
  readonly at: number;
}

/** How many invocations the ring keeps (the oldest is dropped first). */
const MAX_INVOCATIONS = 200;

/** A bounded ring of the most recent invocations. */
export class InvocationRing {
  readonly #items: Invocation[] = [];
  #next = 0;

  /**
   * @param capacity How many it keeps.
   */
  constructor(readonly capacity: number = MAX_INVOCATIONS) {}

  /**
   * Record one invocation (overwriting the oldest once full).
   *
   * @param invocation The invocation.
   */
  push(invocation: Invocation): void {
    if (this.#items.length < this.capacity) this.#items.push(invocation);
    else this.#items[this.#next] = invocation;
    this.#next = (this.#next + 1) % this.capacity;
  }

  /**
   * The kept invocations, newest first.
   *
   * @returns A copy.
   */
  list(): Invocation[] {
    const ordered = this.#items.length < this.capacity
      ? [...this.#items]
      : [...this.#items.slice(this.#next), ...this.#items.slice(0, this.#next)];
    return ordered.reverse();
  }
}

/** One deployed function. */
export interface DeployedFunction {
  /** Its name (its route). */
  readonly name: string;
  /** Whether a caller must present a valid identity. */
  readonly verifyJwt: boolean;
  /** When its entry file last changed (epoch ms), when the file system says. */
  readonly modified: number | null;
}

/** The functions part of the admin endpoint. */
export interface FunctionsAdmin {
  /** The functions in the functions directory, sorted by name. */
  functions(): Promise<DeployedFunction[]>;
  /** The recent invocations, newest first. */
  invocations(): Invocation[];
}

const SLOT = Symbol.for("denext.backend.functionsAdmin");
type Holder = { [SLOT]?: FunctionsAdmin };

/**
 * Install (or clear, with `undefined`) the functions admin view (`setupFunctions` does).
 *
 * @param admin The view.
 */
export function installFunctionsAdmin(admin: FunctionsAdmin | undefined): void {
  (globalThis as Holder)[SLOT] = admin;
}

/**
 * The installed functions admin view, when Edge Functions are configured.
 *
 * @returns The view, or `undefined`.
 */
export function functionsAdmin(): FunctionsAdmin | undefined {
  return (globalThis as Holder)[SLOT];
}

/**
 * Time a call and record it in `ring`: its status (`0` for a throw), duration and time.
 *
 * @param ring The ring.
 * @param name The function.
 * @param call The call.
 * @returns What the call returned.
 */
export async function recorded(
  ring: InvocationRing,
  name: string,
  call: () => Promise<Response>,
): Promise<Response> {
  const started = performance.now();
  let status = 0;
  try {
    const response = await call();
    status = response.status;
    return response;
  } finally {
    ring.push({
      name,
      status,
      ms: Math.round(performance.now() - started),
      at: Date.now(),
    });
  }
}
