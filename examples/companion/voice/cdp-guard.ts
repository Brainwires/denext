// What Loopy's browser watches, target by target. The page Loopy drives is attached over the
// DevTools protocol with `Target.setAutoAttach { waitForDebuggerOnStart, flatten }`, so every
// target it starts — a cross-site iframe (its own process), a dedicated, shared or service worker —
// is attached paused, guarded, and only then resumed (`Runtime.runIfWaitingForDebugger`),
// recursively. A target that can't be guarded is closed, and never resumed.
//
// Two guards, both on every target:
// - requests: `Fetch` interception of every request (documents, fetch / XHR, beacons, any resource
//   type) feeds the post gate (voice/post-gate.ts). A dedicated worker has no `Fetch` domain; its
//   requests reach its parent's interception, which is checked (a worker under no intercepted
//   parent is closed);
// - connections Fetch never sees (WebSocket, WebTransport, RTCPeerConnection, RTCDataChannel): a
//   script run before the target's own code ({@linkcode guardScript}) refuses to create them
//   while Loopy is acting or in the grace after, and reports the attempt through a binding, so the
//   user is asked the same way. Outside Loopy's windows they work as usual. (`navigator.sendBeacon`
//   is a request Fetch intercepts, a `Ping`, so it is held and asked about like any other.)
//
// The protocol connection is an interface, so all of this is unit-tested with a fake one.

import type { HeldPost } from "./browser-tools.ts";
import type { PausedRequest, PostGate } from "./post-gate.ts";

/** A DevTools protocol connection with flattened sessions (`sessionId` names a target). */
export interface Cdp {
  /** Send a command; rejects with the protocol's error. */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  /** Every event, with the session it came from. */
  onEvent(listener: (event: CdpEvent) => void): void;
}

/** A protocol event. */
export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

/** Something the guards hold until the user answers. */
export interface HeldItem extends HeldPost {
  /** `request`: a paused request (released or failed); `connection`: a refused connection. */
  readonly kind: "request" | "connection";
  readonly sessionId: string;
  /** The paused request's id (requests only). */
  readonly requestId?: string;
}

/** The binding the guard script reports refused connections through. */
const ATTEMPT_BINDING = "__loopyAttempt";

/** The global the guard script answers to (with the per-launch token). */
const GUARD_GLOBAL = "__loopyGuard";

/** Every request, at the request stage. */
const ALL_REQUESTS = { patterns: [{ urlPattern: "*", requestStage: "Request" }] };

/** How targets are attached: every child, paused at start, on this one connection. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/**
 * The script that runs first in every document and worker: it wraps the connection constructors
 * (and their prototypes' `constructor`, and `createDataChannel`) so that, while Loopy acts, they
 * throw `NotAllowedError` and report the attempt instead. Every wrapper is non-configurable and
 * non-writable, and only a caller holding `token` can switch the guard.
 *
 * @param token The per-launch secret that switches the guard.
 */
export function guardScript(token: string): string {
  return `(() => {
  const g = globalThis;
  if (Object.getOwnPropertyDescriptor(g, ${JSON.stringify(GUARD_GLOBAL)})) return;
  const T = ${JSON.stringify(token)};
  let acting = false;
  const lock = (o, k, v) => { try { Object.defineProperty(o, k, { value: v, writable: false, configurable: false }); } catch {} };
  const refuse = (kind, target) => {
    try { const r = g[${
    JSON.stringify(ATTEMPT_BINDING)
  }]; if (typeof r === "function") r(JSON.stringify({ kind, url: String(target) })); } catch {}
    throw new DOMException("Loopy's browser holds this connection until the user allows it.", "NotAllowedError");
  };
  const wrap = (name, targetOf) => {
    const Orig = g[name];
    if (typeof Orig !== "function") return;
    const W = new Proxy(Orig, {
      construct(t, args, nt) { if (acting) refuse(name, targetOf(args)); return Reflect.construct(t, args, nt); },
      apply(t, self, args) { if (acting) refuse(name, targetOf(args)); return Reflect.apply(t, self, args); },
    });
    if (Orig.prototype) lock(Orig.prototype, "constructor", W);
    lock(g, name, W);
  };
  wrap("WebSocket", (a) => a[0]);
  wrap("WebTransport", (a) => a[0]);
  const pc = typeof g.RTCPeerConnection === "function" ? g.RTCPeerConnection.prototype : null;
  wrap("RTCPeerConnection", () => "a peer-to-peer connection");
  wrap("webkitRTCPeerConnection", () => "a peer-to-peer connection");
  if (pc && typeof pc.createDataChannel === "function") {
    const open = pc.createDataChannel;
    lock(pc, "createDataChannel", function (...a) { if (acting) refuse("RTCDataChannel", a[0]); return open.apply(this, a); });
  }
  Object.defineProperty(g, ${JSON.stringify(GUARD_GLOBAL)}, {
    value: (t, on) => { if (t === T) acting = on === true; },
    writable: false, configurable: false, enumerable: false,
  });
})();`;
}

/** The expression that switches the guard in one context. */
export function guardSwitch(token: string, on: boolean): string {
  return `globalThis.${GUARD_GLOBAL}?.(${JSON.stringify(token)}, ${on})`;
}

/** The kinds of target attached. */
type TargetKind = "page" | "worker" | "other";

/** How a target is guarded. */
function kindOf(type: unknown): TargetKind {
  if (type === "page" || type === "iframe") return "page";
  if (type === "worker") return "worker";
  return "other"; // service and shared workers, worklets, anything new: guarded on their own
}

/** One attached target. */
interface Session {
  readonly id: string;
  readonly targetId: string;
  readonly kind: TargetKind;
  /** Whether its requests are intercepted (its own `Fetch`, or its parent's). */
  readonly intercepted: boolean;
  /** Its documents' main-world contexts (page targets). */
  readonly contexts: Set<number>;
  /** The new-document script that starts documents switched on, while acting. */
  actingScript?: string;
}

/** What {@linkcode createTargetGuard} needs. */
export interface TargetGuardOptions {
  readonly cdp: Cdp;
  readonly gate: PostGate;
  /** The per-launch secret the guard script answers to. */
  readonly token: string;
  /** Something was held (a write, or a refused connection). */
  readonly onHold: (item: HeldItem) => void;
}

/** The guards over one page and everything it starts. */
export interface TargetGuard {
  /** Guard the page target attached as `sessionId` (and, from now on, every child). */
  attachPage(sessionId: string, targetId: string): Promise<void>;
  /** Switch the connection guard on (Loopy acts) or off, in every document and worker. */
  setActing(on: boolean): Promise<void>;
  /** Let a held request go on, or fail it. */
  release(item: HeldItem, allow: boolean): Promise<void>;
  /** The targets attached now (for tests and diagnostics). */
  sessions(): readonly { id: string; kind: string; intercepted: boolean }[];
}

/** A string field of a protocol object. */
/** A created execution context's id when it is its document's main world, else `null`. */
function defaultContextId(params: Record<string, unknown>): number | null {
  const ctx = params.context as { id?: unknown; auxData?: { isDefault?: unknown } } | undefined;
  return typeof ctx?.id === "number" && ctx.auxData?.isDefault === true ? ctx.id : null;
}

const str = (o: unknown, k: string) => {
  const v = (o as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v : "";
};

/** The guards. */
export function createTargetGuard(options: TargetGuardOptions): TargetGuard {
  const { cdp, gate, token } = options;
  const sessions = new Map<string, Session>();
  let acting = false;
  const send = (m: string, p: Record<string, unknown>, s: string) => cdp.send(m, p, s);

  /** Guard a page or iframe target: requests, the script, contexts, children. */
  const guardPage = async (s: Session) => {
    await send("Fetch.enable", ALL_REQUESTS, s.id);
    await send("Runtime.addBinding", { name: ATTEMPT_BINDING }, s.id);
    await send("Page.enable", {}, s.id); // new-document scripts need the Page domain on
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: guardScript(token),
      runImmediately: true,
    }, s.id);
    if (acting) await switchPage(s, true);
    await send("Runtime.enable", {}, s.id);
    await send("Target.setAutoAttach", AUTO_ATTACH, s.id);
  };

  /**
   * Guard a worker: its requests (its own `Fetch`, or a dedicated worker's parent's), then queue
   * the binding, the children and the script. A paused worker answers only `Fetch` until it
   * resumes; what is queued runs on resume, before the worker's own script.
   *
   * @returns The queued commands (wrapped, so awaiting this doesn't wait for them), to await
   *   once the worker is resumed.
   */
  const guardWorker = async (s: Session): Promise<{ queued: Promise<unknown> }> => {
    if (s.kind === "other") await send("Fetch.enable", ALL_REQUESTS, s.id);
    else if (!s.intercepted) throw new Error("a dedicated worker under no intercepted parent");
    const queued = Promise.all([
      send("Runtime.addBinding", { name: ATTEMPT_BINDING }, s.id),
      send("Target.setAutoAttach", AUTO_ATTACH, s.id),
      send("Runtime.evaluate", {
        expression: `${guardScript(token)}; ${guardSwitch(token, acting)}`,
      }, s.id),
    ]);
    queued.catch(() => {}); // awaited after the resume; never an unhandled rejection meanwhile
    return { queued };
  };

  /** Close a target that couldn't be guarded (it is never resumed). */
  const reject = async (s: Session) => {
    sessions.delete(s.id);
    await cdp.send("Target.closeTarget", { targetId: s.targetId }).catch(() => {});
  };

  /** Guard a child attached paused, then resume it; close it when guarding fails. */
  const attachChild = async (params: Record<string, unknown>, parent?: string) => {
    const info = params.targetInfo as Record<string, unknown> | undefined;
    const id = str(params, "sessionId");
    const kind = kindOf(info?.type);
    const s: Session = {
      id,
      targetId: str(info, "targetId"),
      kind,
      intercepted: kind !== "worker" ||
        (parent !== undefined && sessions.get(parent)?.intercepted === true),
      contexts: new Set(),
    };
    sessions.set(id, s);
    try {
      if (kind === "page") {
        await guardPage(s);
        await send("Runtime.runIfWaitingForDebugger", {}, id);
      } else {
        const { queued } = await guardWorker(s);
        await send("Runtime.runIfWaitingForDebugger", {}, id);
        const results = await queued as { exceptionDetails?: unknown }[];
        if (results.some((r) => r?.exceptionDetails)) throw new Error("the guard didn't run");
      }
    } catch {
      await reject(s);
    }
  };

  /** Switch one page target: new documents (a start script while acting) and every context. */
  const switchPage = async (s: Session, on: boolean) => {
    if (on && !s.actingScript) {
      const r = await send("Page.addScriptToEvaluateOnNewDocument", {
        source: guardSwitch(token, true),
        runImmediately: true,
      }, s.id) as { identifier?: string };
      s.actingScript = r?.identifier;
    } else if (!on && s.actingScript) {
      const identifier = s.actingScript;
      s.actingScript = undefined;
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, s.id).catch(() => {});
    }
    await Promise.all(
      [...s.contexts].map((contextId) =>
        send("Runtime.evaluate", { expression: guardSwitch(token, on), contextId }, s.id)
          .catch(() => s.contexts.delete(contextId))
      ),
    );
  };

  /** A paused request: on through the gate, or held. */
  const paused = (params: Record<string, unknown>, sessionId: string) => {
    const request = params.request as PausedRequest;
    const requestId = str(params, "requestId");
    if (gate.decide(request) === "hold") {
      options.onHold({
        kind: "request",
        sessionId,
        requestId,
        method: request.method,
        url: request.url,
      });
    } else void send("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
  };

  /** A refused connection the guard script reported. */
  const attempted = (params: Record<string, unknown>, sessionId: string) => {
    if (params.name !== ATTEMPT_BINDING) return;
    let report: { kind?: unknown; url?: unknown } = {};
    try {
      report = JSON.parse(str(params, "payload"));
    } catch { /* malformed: still held, unnamed */ }
    options.onHold({
      kind: "connection",
      sessionId,
      method: typeof report.kind === "string" ? report.kind.slice(0, 40) : "connection",
      url: typeof report.url === "string" ? report.url.slice(0, 500) : "",
    });
  };

  /** A document's main world appeared or went away. */
  const context = (event: CdpEvent) => {
    const s = event.sessionId ? sessions.get(event.sessionId) : undefined;
    if (!s) return;
    if (event.method === "Runtime.executionContextsCleared") return s.contexts.clear();
    if (event.method === "Runtime.executionContextDestroyed") {
      const id = event.params.executionContextId;
      if (typeof id === "number") s.contexts.delete(id);
      return;
    }
    const id = defaultContextId(event.params);
    if (id !== null) s.contexts.add(id);
  };

  cdp.onEvent((event) => {
    const sid = event.sessionId ?? "";
    switch (event.method) {
      case "Target.attachedToTarget":
        void attachChild(event.params, event.sessionId);
        return;
      case "Target.detachedFromTarget":
        sessions.delete(str(event.params, "sessionId"));
        return;
      case "Fetch.requestPaused":
        return paused(event.params, sid);
      case "Runtime.bindingCalled":
        return attempted(event.params, sid);
      case "Runtime.executionContextCreated":
      case "Runtime.executionContextDestroyed":
      case "Runtime.executionContextsCleared":
        return context(event);
    }
  });

  return {
    async attachPage(sessionId, targetId) {
      const s: Session = {
        id: sessionId,
        targetId,
        kind: "page",
        intercepted: true,
        contexts: new Set(),
      };
      sessions.set(sessionId, s);
      await guardPage(s);
    },
    async setActing(on) {
      acting = on;
      await Promise.all(
        [...sessions.values()].map((s) =>
          s.kind === "page"
            ? switchPage(s, on)
            : send("Runtime.evaluate", { expression: guardSwitch(token, on) }, s.id).catch(() => {})
        ),
      );
    },
    async release(item, allow) {
      if (item.kind !== "request" || !item.requestId) return;
      const params = allow
        ? { requestId: item.requestId }
        : { requestId: item.requestId, errorReason: "BlockedByClient" };
      await send(allow ? "Fetch.continueRequest" : "Fetch.failRequest", params, item.sessionId)
        .catch(() => {});
    },
    sessions: () =>
      [...sessions.values()].map((s) => ({ id: s.id, kind: s.kind, intercepted: s.intercepted })),
  };
}
