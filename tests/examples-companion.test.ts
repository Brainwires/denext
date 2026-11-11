// examples/companion (Loopy): the state machine, message validation, the character and the speech
// bubble (rendered with denext/testing), the corner placement, the inbox handler — token, browser
// and host rejections, limits, waits — the inbox file, the reply endpoint and the CLI, end to end
// against a real loopback server. The export of the whole app is
// tests/integration/example-companion.test.ts.

import { assert, assertEquals, assertExists, assertMatch, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render, waitFor } from "../src/testing/render.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { osDataDir } from "../src/desktop/app-dirs.ts";
import {
  INITIAL_MODEL,
  isVisible,
  type LoopyEvent,
  type LoopyModel,
  MOODS,
  moodState,
  nextTimer,
  stateDurationMs,
  transition,
} from "../examples/companion/lib/loopy-machine.ts";
import {
  type LoopyMessage,
  MAX_TEXT,
  parseSayRequest,
  readingTimeMs,
  SayError,
} from "../examples/companion/lib/messages.ts";
import {
  anchoredBounds,
  cornerOnScreen,
  cornerPosition,
  primaryScreen,
  scaledWindowSize,
  WAYLAND_PANEL_INSET,
  WINDOW_SIZE,
} from "../examples/companion/lib/placement.ts";
import {
  clickThroughPlan,
  HIT_ATTRIBUTE,
  HIT_SELECTOR,
  hitRects,
  insideAny,
} from "../examples/companion/lib/click-through.ts";
import {
  readAloudOn,
  saveReadAloud,
  SPEECH_KEY,
  spokenText,
} from "../examples/companion/lib/speech.ts";
import {
  type CompanionModel,
  companionReducer,
  INITIAL_COMPANION,
  MAX_QUEUE,
} from "../examples/companion/lib/companion-state.ts";
import { Loopy } from "../examples/companion/components/Loopy.tsx";
import { SpeechBubble } from "../examples/companion/components/SpeechBubble.tsx";
import {
  createInboxHandler,
  createReplies,
  MAX_BODY_BYTES,
  sameToken,
  SAY_PATH,
} from "../examples/companion/inbox/handler.ts";
import { newToken, readInbox, saveInbox } from "../examples/companion/inbox/store.ts";
import { APP_ID, dataDir, inboxFilePath } from "../examples/companion/inbox/paths.ts";
import { replyResponse, startInbox } from "../examples/companion/inbox/server.ts";
import {
  hookMessage,
  parseArgs,
  send,
  UsageError,
} from "../examples/companion/scripts/loopy-say.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";
import {
  CLIENT_SECRETS_URL,
  LOOPY_INSTRUCTIONS,
  mintClientSecret,
  REALTIME_MODEL,
  REALTIME_VOICE,
  SECRET_TTL_SECONDS,
  TRANSCRIBE_MODEL,
  VoiceError,
} from "../examples/companion/voice/realtime.ts";
import {
  createToolRegistry,
  MAX_ARGUMENTS,
  setMoodTool,
} from "../examples/companion/voice/tools.ts";
import {
  envKeyStore,
  KEY_ENV,
  KEY_ITEM,
  keychainKeyStore,
} from "../examples/companion/voice/keys.ts";
import {
  createRateLimiter,
  createVoiceService,
  VOICE_LIMITS,
} from "../examples/companion/voice/service.ts";
import { VOICE_CAPABILITY, voiceCapabilities } from "../examples/companion/voice/extension.ts";
import { createVoiceRoute } from "../examples/companion/voice/dev-route.ts";
import {
  routeBackend,
  VOICE_ROUTE,
  VoiceBackendError,
} from "../examples/companion/lib/voice-backend.ts";
import { MAX_TOOL_ROUNDS, relayToolCalls } from "../examples/companion/lib/tool-relay.ts";
import {
  functionCalls,
  INITIAL_VOICE,
  MAX_TRANSCRIPT,
  type ServerEvent,
  voiceBusy,
  type VoiceEvent,
  voiceLook,
  voiceNudge,
  voiceOnScreen,
  voiceReducer,
  voiceStage,
} from "../examples/companion/lib/voice-machine.ts";
import {
  FULL,
  LEVEL_STEPS,
  levelStep,
  mouthShape,
  rmsLevel,
  SILENCE,
  smoothLevel,
} from "../examples/companion/lib/lip-sync.ts";
import {
  clampScale,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  SCALE,
  scaleFromQuery,
  SETTINGS_KEY,
} from "../examples/companion/lib/voice-settings.ts";
import {
  CALLS_URL,
  connectRealtime,
  EVENTS_CHANNEL,
  micErrorMessage,
  type MicUnavailableError,
  openMicrophone,
} from "../examples/companion/lib/realtime-client.ts";
import { VoiceBubble, voiceBubbleShown } from "../examples/companion/components/VoiceBubble.tsx";
import { VoiceSettings } from "../examples/companion/components/VoiceSettings.tsx";
import companionConfig from "../examples/companion/denext.config.ts";

/** Run the machine over `events` from `from`. */
function run(events: LoopyEvent[], from: LoopyModel = INITIAL_MODEL): LoopyModel {
  return events.reduce(transition, from);
}

// ---------------------------------------------------------------- state machine

Deno.test("loopy machine: show springs up, then settles to idle; blinks only while idle", () => {
  const appeared = run([{ type: "show" }]);
  assertEquals(appeared.state, "appear");
  const idle = transition(appeared, { type: "settle" });
  assertEquals(idle, { state: "idle", pendingMood: null });
  assertEquals(transition(idle, { type: "blink" }).state, "blink");
  assertEquals(run([{ type: "blink" }, { type: "settle" }], idle).state, "idle");
  // A blink while hidden, landing or thinking changes nothing.
  assertEquals(transition(INITIAL_MODEL, { type: "blink" }), INITIAL_MODEL);
  assertEquals(transition(appeared, { type: "blink" }), appeared);
  const thinking = transition(idle, { type: "say", mood: "thinking" });
  assertEquals(transition(thinking, { type: "blink" }), thinking);
  // `show` while already up is a no-op.
  assertEquals(transition(idle, { type: "show" }), idle);
});

Deno.test("loopy machine: each mood maps to its move, and the held moves settle to idle", () => {
  const idle = run([{ type: "show" }, { type: "settle" }]);
  assertEquals(transition(idle, { type: "say", mood: "thinking" }).state, "think");
  assertEquals(transition(idle, { type: "say", mood: "attention" }).state, "point");
  assertEquals(transition(idle, { type: "say", mood: "success" }).state, "celebrate");
  assertEquals(transition(idle, { type: "say", mood: "neutral" }).state, "idle");
  for (const mood of ["thinking", "attention", "success"] as const) {
    const moved = transition(idle, { type: "say", mood });
    assertEquals(transition(moved, { type: "settle" }).state, "idle", mood);
  }
  // A new mood replaces the one on screen.
  const pointing = transition(idle, { type: "say", mood: "attention" });
  assertEquals(transition(pointing, { type: "say", mood: "thinking" }).state, "think");
  assertEquals(moodState("neutral"), "idle");
});

Deno.test("loopy machine: a message while hidden or landing springs up first, then takes its mood", () => {
  const landing = transition(INITIAL_MODEL, { type: "say", mood: "attention" });
  assertEquals(landing, { state: "appear", pendingMood: "attention" });
  assertEquals(transition(landing, { type: "settle" }).state, "point");
  // A mood that arrives mid-landing replaces the pending one.
  const relanding = transition(run([{ type: "show" }]), { type: "say", mood: "success" });
  assertEquals(relanding, { state: "appear", pendingMood: "success" });
  assertEquals(transition(relanding, { type: "settle" }).state, "celebrate");
});

Deno.test("loopy machine: dismiss folds away to hidden; a message brings it back", () => {
  const idle = run([{ type: "show" }, { type: "settle" }]);
  const folding = transition(idle, { type: "dismiss" });
  assertEquals(folding.state, "dismiss");
  assertEquals(isVisible(folding.state), false);
  assertEquals(transition(folding, { type: "dismiss" }), folding);
  const hidden = transition(folding, { type: "settle" });
  assertEquals(hidden.state, "hidden");
  assertEquals(transition(hidden, { type: "dismiss" }), hidden);
  assertEquals(transition(hidden, { type: "settle" }), hidden);
  // Mid-fold, a message or a show springs back up.
  assertEquals(transition(folding, { type: "say", mood: "thinking" }), {
    state: "appear",
    pendingMood: "thinking",
  });
  assertEquals(transition(folding, { type: "show" }).state, "appear");
});

Deno.test("loopy machine: timed moves have durations, held moves don't", () => {
  for (const s of ["appear", "blink", "celebrate", "dismiss"] as const) {
    assert((stateDurationMs(s) ?? 0) > 0, s);
  }
  for (const s of ["hidden", "idle", "think", "point"] as const) {
    assertEquals(stateDurationMs(s), null, s);
  }
  // What the page sends by itself: a settle when a timed move ends, a blink while idle.
  assertEquals(nextTimer("appear"), { event: { type: "settle" }, ms: 650 });
  assertEquals(nextTimer("idle", () => 0), { event: { type: "blink" }, ms: 2_500 });
  assert((nextTimer("idle", () => 0.999)?.ms ?? Infinity) < 6_000);
  assertEquals(nextTimer("think"), null);
  assertEquals(nextTimer("hidden"), null);
});

// ---------------------------------------------------------------- companion queue

/** A queued message with `id` and `mood`. */
function queued(id: string, mood: LoopyMessage["mood"] = "neutral"): LoopyMessage {
  return { id, text: id, mood, actions: [], timeoutMs: 0 };
}

Deno.test("companion: a message while folded away springs Loopy up in its mood", () => {
  const m = companionReducer(INITIAL_COMPANION, {
    type: "enqueue",
    message: queued("a", "attention"),
  });
  assertEquals(m.queue.map((q) => q.id), ["a"]);
  assertEquals(m.loopy, { state: "appear", pendingMood: "attention" });
  assertEquals(companionReducer(m, { type: "settle" }).loopy.state, "point");
});

Deno.test("companion: messages queue; finishing one says the next, the last settles", () => {
  let m: CompanionModel = companionReducer(INITIAL_COMPANION, { type: "show" });
  m = companionReducer(m, { type: "settle" });
  m = companionReducer(m, { type: "enqueue", message: queued("a", "thinking") });
  assertEquals(m.loopy.state, "think");
  m = companionReducer(m, { type: "enqueue", message: queued("b", "success") });
  assertEquals(m.loopy.state, "think", "a waiting message doesn't change the move");
  // Finishing a message that isn't on screen changes nothing.
  assertEquals(companionReducer(m, { type: "finish", id: "b" }), m);
  m = companionReducer(m, { type: "finish", id: "a" });
  assertEquals(m.queue.map((q) => q.id), ["b"]);
  assertEquals(m.loopy.state, "celebrate");
  m = companionReducer(m, { type: "settle" });
  m = companionReducer(m, { type: "enqueue", message: queued("c", "attention") });
  m = companionReducer(m, { type: "finish", id: "b" });
  assertEquals(m.loopy.state, "point");
  m = companionReducer(m, { type: "finish", id: "c" });
  assertEquals(m, { queue: [], loopy: { state: "idle", pendingMood: null } });
});

Deno.test("companion: fold up drops every message; the queue is capped", () => {
  let m: CompanionModel = companionReducer(INITIAL_COMPANION, { type: "show" });
  m = companionReducer(m, { type: "settle" });
  for (let i = 0; i < MAX_QUEUE + 5; i++) {
    m = companionReducer(m, { type: "enqueue", message: queued(`m${i}`) });
  }
  assertEquals(m.queue.length, MAX_QUEUE + 1, "one on screen and MAX_QUEUE waiting");
  m = companionReducer(m, { type: "foldUp" });
  assertEquals(m.queue, []);
  assertEquals(m.loopy.state, "dismiss");
  assertEquals(companionReducer(m, { type: "settle" }).loopy.state, "hidden");
});

// ---------------------------------------------------------------- messages

Deno.test("loopy messages: defaults, trimming, and the bubble time by length or actions", () => {
  const { message, wait } = parseSayRequest({ text: "  hello  " }, "m1");
  assertEquals(message, {
    id: "m1",
    text: "hello",
    mood: "neutral",
    actions: [],
    timeoutMs: readingTimeMs("hello"),
  });
  assertEquals(wait, false);
  assertEquals(readingTimeMs("x".repeat(500)), 15_000);
  const asked = parseSayRequest({
    text: "Deploy?",
    mood: "attention",
    actions: [{ id: "yes", label: " Deploy " }, { id: "no", label: "Later" }],
    wait: true,
  }).message;
  assertEquals(asked.timeoutMs, 0, "a message with buttons stays until answered");
  assertEquals(asked.actions[0], { id: "yes", label: "Deploy" });
  assertMatch(asked.id, /^[0-9a-f-]{36}$/);
  assertEquals(parseSayRequest({ text: "x", timeoutMs: 0 }).message.timeoutMs, 0);
  assertEquals(parseSayRequest({ text: "x", timeoutMs: 5000 }).message.timeoutMs, 5000);
});

Deno.test("loopy messages: every invalid field is a SayError naming it", () => {
  const bad: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    [[], /JSON object/],
    [{}, /text/],
    [{ text: "   " }, /text/],
    [{ text: "x".repeat(MAX_TEXT + 1) }, /text/],
    [{ text: "x", mood: "angry" }, /mood/],
    [{ text: "x", wait: "yes" }, /wait/],
    [{ text: "x", actions: "yes" }, /actions/],
    [{ text: "x", actions: [1, 2, 3, 4] }, /actions/],
    [{ text: "x", actions: [null] }, /actions\[0\]/],
    [{ text: "x", actions: [{ id: "a b", label: "A" }] }, /actions\[0\]\.id/],
    [{ text: "x", actions: [{ id: "a", label: "" }] }, /actions\[0\]\.label/],
    [{ text: "x", actions: [{ id: "a", label: "y".repeat(41) }] }, /label/],
    [{ text: "x", actions: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }, /unique/],
    [{ text: "x", timeoutMs: 10 }, /timeoutMs/],
    [{ text: "x", timeoutMs: 120_001 }, /timeoutMs/],
    [{ text: "x", timeoutMs: 1500.5 }, /timeoutMs/],
  ];
  for (const [body, reason] of bad) {
    const e = assertThrows(() => parseSayRequest(body), SayError);
    assertMatch(e.message, reason, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------- placement

Deno.test("loopy placement: the bottom-right corner of the primary display's work area", () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 };
  assertEquals(cornerPosition(work, { width: 260, height: 300 }), { x: 1164, y: 584 });
  assertEquals(cornerPosition(work, { width: 260, height: 300 }, 0), { x: 1180, y: 600 });
  // A secondary display to the left (negative coordinates).
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  assertEquals(cornerPosition(left, { width: 260, height: 300 }), { x: -276, y: 724 });
  // A work area smaller than the window keeps the window's top-left on screen.
  assertEquals(
    cornerPosition({ x: 10, y: 20, width: 100, height: 100 }, { width: 260, height: 300 }),
    {
      x: 10,
      y: 20,
    },
  );
  const a = { bounds: work, workArea: work, isPrimary: false };
  const b = { bounds: left, workArea: left, isPrimary: true };
  assertEquals(primaryScreen([a, b]), b);
  assertEquals(primaryScreen([a]), a);
  assertEquals(primaryScreen([]), undefined);
});

Deno.test("loopy placement: on Wayland a layer surface's margins, clear of the panels", () => {
  const size = { width: 260, height: 300 };
  // KDE Plasma (the live test): GDK reports the whole 1280x800 display as the work area while a
  // 54 px taskbar sits at the bottom. Kept WAYLAND_PANEL_INSET in, the window ends above it.
  const kde = {
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    workArea: { x: 0, y: 0, width: 1280, height: 800 },
    isPrimary: true,
  };
  const wayland = { wayland: true, edgeAnchored: false };
  const at = cornerOnScreen(kde, size, wayland);
  assertEquals(at, {
    x: 1280 - WAYLAND_PANEL_INSET - 260 - 16,
    y: 800 - WAYLAND_PANEL_INSET - 316,
  });
  assertEquals(at.y + size.height <= 800 - 54, true);
  // Elsewhere, and on a runtime that anchors to the nearest edges: the reported work area.
  assertEquals(cornerOnScreen(kde, size, { wayland: false, edgeAnchored: false }), {
    x: 1004,
    y: 484,
  });
  assertEquals(cornerOnScreen(kde, size, { wayland: true, edgeAnchored: true }), {
    x: 1004,
    y: 484,
  });
  // A display right of another: margins count from its own top-left; a work area the session
  // does report is used as it is.
  const right = {
    bounds: { x: 1280, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1280, y: 0, width: 1920, height: 1036 },
    isPrimary: true,
  };
  assertEquals(cornerOnScreen(right, size, wayland), { x: 1920 - 276, y: 1036 - 316 });
  // A display smaller than twice the inset keeps the window's top-left on it.
  const tiny = {
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    workArea: { x: 0, y: 0, width: 100, height: 100 },
    isPrimary: true,
  };
  assertEquals(cornerOnScreen(tiny, size, wayland), { x: 64, y: 64 });
});

// ---------------------------------------------------------------- the overlay's click-through

Deno.test("loopy overlay: a hit region first, else forwarded click-through, else none", () => {
  assertEquals(clickThroughPlan({ hitRegion: true, clickThrough: true }), "region");
  assertEquals(
    clickThroughPlan({ hitRegion: false, clickThrough: true, clickThroughForward: true }),
    "forward",
  );
  assertEquals(clickThroughPlan({ clickThrough: true, clickThroughForward: false }), "none");
  assertEquals(clickThroughPlan({}), "none");
});

Deno.test("loopy overlay: the click-catching rectangles, rounded outwards; empty boxes dropped", () => {
  const rects = hitRects([
    { left: 10.4, top: 20.6, right: 50.2, bottom: 80.1 },
    { left: 5, top: 5, right: 5, bottom: 30 }, // a closed bubble: no width
  ]);
  assertEquals(rects, [{ x: 10, y: 20, width: 41, height: 61 }]);
  assertEquals(insideAny(rects, 10, 20), true);
  assertEquals(insideAny(rects, 51, 20), false, "the right edge is outside");
  assertEquals(insideAny([], 0, 0), false);
});

// Found live on KDE Plasma: the hit region was the bubble's whole row and Loopy's whole row, so
// the empty space above and beside Loopy caught clicks. Only Loopy, a shown bubble and the buttons
// carry the mark (the page's markup is checked in tests/integration/example-companion.test.ts).
Deno.test("loopy overlay: a shown bubble is marked as catching clicks", async () => {
  assertEquals(HIT_SELECTOR, `[${HIT_ATTRIBUTE}]`);
  const bubble = await renderToString(h(SpeechBubble, {
    message: message(),
    onAction: () => {},
    onClose: () => {},
  }));
  assertMatch(bubble, new RegExp(`<div class="bubble"[^>]*${HIT_ATTRIBUTE}=`));
});

// ---------------------------------------------------------------- components

// The character is pure SVG; denext/testing's DOM has no SVG namespace (`createElementNS`), so
// it is checked through the server renderer, the path its first paint takes.
Deno.test("Loopy renders its move as data-state, with an accessible name and its face", async () => {
  const html = await renderToString(h(Loopy, { state: "point" }));
  assertMatch(html, /<svg class="loopy" data-state="point"[^>]* role="img" aria-label="Loopy"/);
  assertEquals(html.match(/class="loopy-wire"/g)?.length, 1, "the wire is one continuous piece");
  assertEquals(
    html.match(/<circle/g)?.length,
    1 + 2 + 3,
    "the bead head, two pupils, three thought dots",
  );
  assertEquals(html.match(/class="loopy-eye-white"/g)?.length, 2, "two eyes");
  assert(html.includes('class="loopy-brows"'), "expressive brows");
  assert(!/<image|href=/.test(html), "no external assets");
  const named = await renderToString(h(Loopy, { state: "celebrate", label: "Loopy the clip" }));
  assertMatch(named, /data-state="celebrate"[^>]*aria-label="Loopy the clip"/);
});

Deno.test("Loopy: every mood has its own wire tint and face, and a say request accepts it", async () => {
  const faces = new Set<string>();
  for (const mood of MOODS) {
    const html = await renderToString(h(Loopy, { state: "idle", mood }));
    assertMatch(html, new RegExp(`data-mood="${mood}"`), mood);
    faces.add(html.replace(/data-mood="[^"]*"/, ""));
    assertEquals(parseSayRequest({ text: "hi", mood }).message.mood, mood);
  }
  assertEquals(faces.size, MOODS.length, "no two moods draw the same face");
  const plain = await renderToString(h(Loopy, { state: "idle" }));
  assertMatch(plain, /data-mood="neutral"/, "no mood is neutral");
});

/** A message as the page holds it. */
function message(over: Partial<LoopyMessage> = {}): LoopyMessage {
  return { id: "m1", text: "Hello there", mood: "neutral", actions: [], timeoutMs: 0, ...over };
}

Deno.test("SpeechBubble shows the text and buttons; a button and the close report back", async () => {
  const pressed: string[] = [];
  let closed = 0;
  const screen = await render(h(SpeechBubble, {
    message: message({
      mood: "attention",
      actions: [{ id: "yes", label: "Deploy" }, { id: "no", label: "Later" }],
    }),
    onAction: (id: string) => pressed.push(id),
    onClose: () => closed++,
  }));
  try {
    const bubble = screen.getByRole("status");
    assertEquals(bubble.getAttribute("data-mood"), "attention");
    assertExists(screen.getByText("Hello there"));
    await screen.fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await screen.fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    assertEquals(pressed, ["no", "yes"]);
    await screen.fireEvent.click(screen.getByRole("button", { name: "Close" }));
    assertEquals(closed, 1);
  } finally {
    await screen.unmount();
  }
});

Deno.test("SpeechBubble closes itself after timeoutMs, and not when it is 0", async () => {
  let closed = 0;
  const timed = await render(h(SpeechBubble, {
    message: message({ timeoutMs: 20 }),
    onAction: () => {},
    onClose: () => closed++,
  }));
  try {
    assertEquals(screenButtons(timed.html()), 1, "only the close button without actions");
    await waitFor(() => assertEquals(closed, 1));
  } finally {
    await timed.unmount();
  }
  closed = 0;
  const held = await render(h(SpeechBubble, {
    message: message(),
    onAction: () => {},
    onClose: () => closed++,
  }));
  try {
    await new Promise((r) => setTimeout(r, 40));
    assertEquals(closed, 0);
  } finally {
    await held.unmount();
  }
});

function screenButtons(html: string): number {
  return html.match(/<button/g)?.length ?? 0;
}

// ---------------------------------------------------------------- inbox handler

const TOKEN = "t".repeat(43);

/** A say request to the inbox. */
function sayRequest(
  body: unknown,
  {
    token = TOKEN,
    host = "127.0.0.1:47833",
    headers = {} as Record<string, string>,
    method = "POST",
  } = {},
): Request {
  return new Request(`http://${host}${SAY_PATH}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      ...headers,
    },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

/** A handler that records what it delivers. */
function inbox(extra: { maxWaitMs?: number } = {}) {
  const delivered: LoopyMessage[] = [];
  const replies = createReplies();
  const handle = createInboxHandler({
    token: TOKEN,
    deliver: (m) => delivered.push(m),
    replies,
    ...extra,
  });
  return { delivered, replies, handle };
}

Deno.test("loopy inbox: a valid message is delivered and answered 202 with its id", async () => {
  const { delivered, handle } = inbox();
  const res = await handle(sayRequest({ text: "Build passed", mood: "success" }));
  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals(delivered.length, 1);
  assertEquals(body, { id: delivered[0].id });
  assertEquals(delivered[0].text, "Build passed");
  assertEquals(delivered[0].mood, "success");
  assertEquals(res.headers.get("cache-control"), "no-store");
  // localhost and [::1] are loopback too.
  for (const host of ["localhost:47833", "[::1]:47833"]) {
    const ok = await handle(sayRequest({ text: "hi" }, { host }));
    await ok.body?.cancel();
    assertEquals(ok.status, 202, host);
  }
});

Deno.test("loopy inbox: no token, a wrong token or another scheme is 401, and nothing is delivered", async () => {
  const { delivered, handle } = inbox();
  const cases: Request[] = [
    sayRequest({ text: "hi" }, { token: "" }),
    sayRequest({ text: "hi" }, { token: "wrong" }),
    sayRequest({ text: "hi" }, { token: TOKEN.slice(0, -1) }),
    sayRequest({ text: "hi" }, { token: TOKEN + "x" }),
    sayRequest({ text: "hi" }, { token: "", headers: { authorization: `Basic ${TOKEN}` } }),
  ];
  for (const req of cases) {
    const res = await handle(req);
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("www-authenticate"), "Bearer");
    await res.body?.cancel();
  }
  assertEquals(delivered, []);
});

Deno.test("loopy inbox: a browser (Origin) or a non-loopback Host is 403, even with the token", async () => {
  const { delivered, handle } = inbox();
  const browser = await handle(
    sayRequest({ text: "hi" }, { headers: { origin: "https://evil.example" } }),
  );
  assertEquals(browser.status, 403);
  await browser.body?.cancel();
  const nullOrigin = await handle(sayRequest({ text: "hi" }, { headers: { origin: "null" } }));
  assertEquals(nullOrigin.status, 403);
  await nullOrigin.body?.cancel();
  const rebound = await handle(sayRequest({ text: "hi" }, { host: "evil.example:47833" }));
  assertEquals(rebound.status, 403);
  await rebound.body?.cancel();
  assertEquals(delivered, []);
});

Deno.test("loopy inbox: wrong path, method, type, size or body are refused with their status", async () => {
  const { delivered, handle } = inbox();
  const notFound = await handle(
    new Request("http://127.0.0.1:47833/api/other", { method: "POST" }),
  );
  assertEquals(notFound.status, 404);
  await notFound.body?.cancel();
  const get = await handle(sayRequest(null, { method: "GET" }));
  assertEquals(get.status, 405);
  assertEquals(get.headers.get("allow"), "POST");
  await get.body?.cancel();
  const text = await handle(sayRequest("hi", { headers: { "content-type": "text/plain" } }));
  assertEquals(text.status, 415);
  await text.body?.cancel();
  const big = await handle(sayRequest({ text: "x".repeat(MAX_BODY_BYTES) }));
  assertEquals(big.status, 413);
  await big.body?.cancel();
  // A body over the cap with no Content-Length (a stream) is cut off too.
  const chunk = new TextEncoder().encode("x".repeat(4096));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ < 8) c.enqueue(chunk);
      else c.close();
    },
  });
  const streamed = await handle(
    new Request(`http://127.0.0.1:47833${SAY_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: stream,
    }),
  );
  assertEquals(streamed.status, 413);
  await streamed.body?.cancel();
  const notJson = await handle(sayRequest("{not json"));
  assertEquals(notJson.status, 400);
  assertEquals((await notJson.json()).error, "the body is not valid JSON");
  const invalid = await handle(sayRequest({ text: "x", mood: "angry" }));
  assertEquals(invalid.status, 400);
  assertMatch((await invalid.json()).error, /mood/);
  assertEquals(delivered, []);
});

Deno.test("loopy inbox: wait holds the response until a button, the close, or the timeout", async () => {
  const { delivered, replies, handle } = inbox();
  const pending = handle(sayRequest({
    text: "Deploy?",
    actions: [{ id: "yes", label: "Deploy" }],
    wait: true,
  }));
  await waitFor(() => assertEquals(delivered.length, 1));
  assert(replies.answer(delivered[0].id, "yes"));
  const res = await pending;
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { id: delivered[0].id, action: "yes" });
  // Nothing waits for it any more.
  assertEquals(replies.answer(delivered[0].id, "yes"), false);

  const closed = handle(
    sayRequest({ text: "Deploy?", actions: [{ id: "yes", label: "Y" }], wait: true }),
  );
  await waitFor(() => assertEquals(delivered.length, 2));
  replies.answer(delivered[1].id, null);
  assertEquals((await (await closed).json()).action, null);

  // No answer within maxWaitMs: `null`.
  const timedOut = await inbox({ maxWaitMs: 30 }).handle(
    sayRequest({ text: "anyone?", wait: true, timeoutMs: 0 }),
  );
  assertEquals((await timedOut.json()).action, null);
});

Deno.test("loopy inbox: the token comparison is exact", async () => {
  assert(await sameToken("abc", "abc"));
  assert(!(await sameToken("abc", "abd")));
  assert(!(await sameToken("abc", "ab")));
  assert(!(await sameToken("", "a")));
});

// ---------------------------------------------------------------- reply endpoint

Deno.test("loopy reply: the page's answer reaches a waiting sender; other sites are refused", async () => {
  const replies = createReplies();
  const waiting = replies.wait("m1", 1000);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("loopy://app/_loopy/reply", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const foreign = await replyResponse(
    post({ id: "m1", action: "yes" }, { "sec-fetch-site": "cross-site" }),
    replies,
  );
  assertEquals(foreign.status, 403);
  await foreign.body?.cancel();
  const get = await replyResponse(new Request("loopy://app/_loopy/reply"), replies);
  assertEquals(get.status, 403);
  await get.body?.cancel();
  const garbage = await replyResponse(
    new Request("loopy://app/_loopy/reply", { method: "POST", body: "{" }),
    replies,
  );
  assertEquals(garbage.status, 400);
  await garbage.body?.cancel();
  const unknown = await replyResponse(post({ id: "nope", action: "yes" }), replies);
  assertEquals(await unknown.json(), { answered: false });
  const noInbox = await replyResponse(post({ id: "m1", action: "yes" }), undefined);
  assertEquals(await noInbox.json(), { answered: false });
  const ok = await replyResponse(
    post({ id: "m1", action: "yes" }, { "sec-fetch-site": "same-origin" }),
    replies,
  );
  assertEquals(await ok.json(), { answered: true });
  assertEquals(await waiting, "yes");
});

// ---------------------------------------------------------------- inbox file + paths

Deno.test("loopy inbox file: created once with a random token (owner-only), reused with a new URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loopy_inbox_" });
  try {
    const file = join(dir, "nested", "loopy-inbox.json");
    assertEquals(await readInbox(file), null);
    const first = await saveInbox(file, "http://127.0.0.1:47833");
    assertMatch(first.token, /^[A-Za-z0-9_-]{43}$/);
    assertEquals(await readInbox(file), first);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    }
    const second = await saveInbox(file, "http://127.0.0.1:50000");
    assertEquals(second, { url: "http://127.0.0.1:50000", token: first.token });
    // A damaged file (or a weak token) gets a fresh token.
    await Deno.writeTextFile(file, JSON.stringify({ url: "x", token: "short" }));
    assertEquals(await readInbox(file), null);
    assert((await saveInbox(file, "http://127.0.0.1:1")).token !== first.token);
    await Deno.writeTextFile(file, "not json");
    assertEquals(await readInbox(file), null);
    // No temp files left behind.
    const names = [];
    for await (const e of Deno.readDir(join(dir, "nested"))) names.push(e.name);
    assertEquals(names, ["loopy-inbox.json"]);
    assert(newToken() !== newToken());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loopy paths: the CLI finds the data folder the desktop runtime gives the app", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(
    dataDir("darwin", env({ HOME: "/Users/a" })),
    "/Users/a/Library/Application Support/dev.denext.loopy",
  );
  assertEquals(
    dataDir("windows", env({ USERPROFILE: "C:\\Users\\a", APPDATA: "D:\\Roaming" })),
    "D:\\Roaming\\dev.denext.loopy",
  );
  assertEquals(
    dataDir("windows", env({ USERPROFILE: "C:\\Users\\a" })),
    "C:\\Users\\a\\AppData\\Roaming\\dev.denext.loopy",
  );
  assertEquals(dataDir("linux", env({ HOME: "/home/a" })), "/home/a/.local/share/dev.denext.loopy");
  assertEquals(
    dataDir("linux", env({ HOME: "/home/a", XDG_DATA_HOME: "/data" })),
    "/data/dev.denext.loopy",
  );
  assertEquals(
    inboxFilePath("linux", env({ HOME: "/home/a" })),
    "/home/a/.local/share/dev.denext.loopy/loopy-inbox.json",
  );
  assertEquals(inboxFilePath("linux", env({ LOOPY_INBOX: "/tmp/x.json" })), "/tmp/x.json");
  // The same folder denext's desktop runtime hands the app (src/desktop/app-dirs.ts), here.
  const os = Deno.build.os as "darwin" | "windows" | "linux";
  assertEquals(dataDir(os).replaceAll("\\", "/"), osDataDir(APP_ID).replaceAll("\\", "/"));
});

// ---------------------------------------------------------------- CLI

Deno.test("loopy-say: arguments become a message; usage errors are reported", () => {
  assertEquals(parseArgs(["Tests", "passed", "--mood", "success"]), {
    request: { text: "Tests passed", mood: "success" },
    fromHook: false,
    inbox: null,
  });
  assertEquals(
    parseArgs([
      "Deploy?",
      "--action",
      "yes:Deploy now",
      "--action",
      "no:Later",
      "--wait",
      "--timeout",
      "0",
    ])
      .request,
    {
      text: "Deploy?",
      actions: [{ id: "yes", label: "Deploy now" }, { id: "no", label: "Later" }],
      timeoutMs: 0,
      wait: true,
    },
  );
  assertEquals(parseArgs(["--from-hook", "--inbox", "/tmp/i.json"]), {
    request: null,
    fromHook: true,
    inbox: "/tmp/i.json",
  });
  for (
    const [args, reason] of [
      [[], /say what/],
      [["hi", "--mood"], /--mood needs a value/],
      [["hi", "--action", "nolabel"], /<id>:<label>/],
      [["hi", "--loud"], /unknown flag/],
    ] as Array<[string[], RegExp]>
  ) {
    assertMatch(assertThrows(() => parseArgs(args), UsageError).message, reason);
  }
});

Deno.test("loopy-say: Claude Code hook input becomes Loopy's message", () => {
  assertEquals(
    hookMessage({
      hook_event_name: "Notification",
      message: "Claude needs your permission to use Bash",
      cwd: "/Users/a/src/shop/",
    }),
    { text: "shop: Claude needs your permission to use Bash", mood: "attention" },
  );
  assertEquals(hookMessage({ hook_event_name: "Notification" }), {
    text: "Claude Code needs you.",
    mood: "attention",
  });
  assertEquals(hookMessage({ hook_event_name: "Stop", cwd: "C:\\src\\shop" }), {
    text: "Claude Code finished in shop.",
    mood: "success",
  });
  assertEquals(hookMessage({ hook_event_name: "Stop" })?.text, "Claude Code finished.");
  assertEquals(hookMessage({ hook_event_name: "PreToolUse" }), null);
  assertEquals(hookMessage(null), null);
  const long = hookMessage({ hook_event_name: "Notification", message: "y".repeat(600) });
  assertEquals(long?.text.length, 500);
});

Deno.test("loopy-say: posts through a real loopback inbox, waits for a button, and reports refusals", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loopy_cli_" });
  const delivered: LoopyMessage[] = [];
  const replies = createReplies();
  let handle: (r: Request) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 503 }));
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (r) => handle(r),
  );
  try {
    const file = join(dir, "loopy-inbox.json");
    await assertRejectsMessage(send(file, { text: "hi" }), /no inbox file/);
    const { token } = await saveInbox(file, `http://127.0.0.1:${server.addr.port}`);
    handle = createInboxHandler({
      token,
      replies,
      deliver: (m) => {
        delivered.push(m);
        if (m.actions.length) queueMicrotask(() => replies.answer(m.id, m.actions[0].id));
      },
    });
    const out = await send(file, { text: "Build passed", mood: "success" });
    assertEquals(out.id, delivered[0].id);
    const answered = await send(file, {
      text: "Deploy?",
      actions: [{ id: "go", label: "Go" }],
      wait: true,
    });
    assertEquals(answered.action, "go");
    await assertRejectsMessage(send(file, { text: "" }), /refused \(400\): text/);
    // A stale token (the app made a new one) is a 401.
    await Deno.writeTextFile(
      file,
      JSON.stringify({ url: `http://127.0.0.1:${server.addr.port}`, token: "z".repeat(43) }),
    );
    await assertRejectsMessage(send(file, { text: "hi" }), /refused \(401\)/);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
  // Nothing listening: a clear reason.
  const gone = await Deno.makeTempDir({ prefix: "loopy_cli_gone_" });
  try {
    const file = join(gone, "loopy-inbox.json");
    await saveInbox(file, `http://127.0.0.1:${server.addr.port}`);
    await assertRejectsMessage(send(file, { text: "hi" }), /isn't answering/);
  } finally {
    await Deno.remove(gone, { recursive: true });
  }
});

async function assertRejectsMessage(p: Promise<unknown>, reason: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    assertMatch((e as Error).message, reason);
    return;
  }
  throw new Error(`expected a rejection matching ${reason}`);
}

Deno.test("loopy inbox server: listens on loopback, records itself, and moves off a taken port", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loopy_server_" });
  const delivered: LoopyMessage[] = [];
  const file = join(dir, "loopy-inbox.json");
  const first = await startInbox({ file, port: 0, deliver: (m) => delivered.push(m) });
  try {
    assertMatch(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assertEquals((await readInbox(file))?.url, first.url);
    await send(file, { text: "over the wire" });
    assertEquals(delivered.map((m) => m.text), ["over the wire"]);
    // A second app on the same port moves to a free one, keeping the token.
    const port = Number(new URL(first.url).port);
    const token = (await readInbox(file))?.token;
    const second = await startInbox({ file, port, deliver: () => {} });
    try {
      assert(second.url !== first.url);
      assertEquals(await readInbox(file), { url: second.url, token: token! });
    } finally {
      await second.shutdown();
    }
  } finally {
    await first.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------- reading bubbles aloud

Deno.test("loopy speech: off until turned on, kept in storage; a refused storage is off", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  assertEquals(readAloudOn(storage), false);
  saveReadAloud(storage, true);
  assertEquals(map.get(SPEECH_KEY), "on");
  assertEquals(readAloudOn(storage), true);
  saveReadAloud(storage, false);
  assertEquals(readAloudOn(storage), false);
  assertEquals(readAloudOn(undefined), false);
  const refusing = {
    getItem: (): string | null => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assertEquals(readAloudOn(refusing), false);
  saveReadAloud(refusing, true); // does not throw
  saveReadAloud(undefined, true);
});

Deno.test("loopy speech: a bubble is read as its text, then its buttons as the choices", () => {
  assertEquals(spokenText({ text: "Tests passed", actions: [] }), "Tests passed");
  assertEquals(
    spokenText({ text: "Deploy?", actions: [{ id: "y", label: "Deploy" }] }),
    "Deploy? Deploy.",
  );
  assertEquals(
    spokenText({
      text: "Shall I?",
      actions: [{ id: "a", label: "Yes" }, { id: "b", label: "Later" }, { id: "c", label: "No" }],
    }),
    "Shall I? Yes, Later, or No.",
  );
});

// ---------------------------------------------------------------- voice (OpenAI Realtime)

/** The API key the voice tests use (a fake). */
const FAKE_KEY = "sk-test-abcdefghijklmnopqrstuvwxyz0123456789";

/** A fetch that records each call and answers with `answer`. */
function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return Promise.resolve(answer(url, init));
  }) as typeof fetch;
  return { fn, calls };
}

/** OpenAI's answer to a client-secret request (with the session echoed, as the API does). */
const secretAnswer = () =>
  Response.json({ value: "ek_ephemeral", expires_at: 1_900_000_000, session: { id: "sess_1" } });

/** A secure store capability over a map (the real one's method shapes). */
function fakeSecureStore() {
  const items = new Map<string, string>();
  return {
    items,
    capability: {
      name: "secureStore",
      methods: {
        get: { handler: (a: unknown) => items.get((a as { key: string }).key) ?? null },
        set: {
          handler: (a: unknown) => {
            const { key, value } = a as { key: string; value: string };
            items.set(key, value);
            return { ok: true };
          },
        },
        delete: {
          handler: (a: unknown) => {
            items.delete((a as { key: string }).key);
            return { ok: true };
          },
        },
      },
    },
  };
}

Deno.test("loopy voice: a client secret is minted with Loopy's session; only the secret comes back", async () => {
  const net = fakeFetch(secretAnswer);
  const secret = await mintClientSecret({
    apiKey: FAKE_KEY,
    tools: createToolRegistry().definitions(),
    fetch: net.fn,
  });
  assertEquals(secret, { value: "ek_ephemeral", expiresAt: 1_900_000_000 });
  assertEquals(net.calls.length, 1);
  const { url, init } = net.calls[0];
  assertEquals(url, CLIENT_SECRETS_URL);
  assertEquals(url, "https://api.openai.com/v1/realtime/client_secrets");
  assertEquals(init.method, "POST");
  const headers = new Headers(init.headers);
  assertEquals(headers.get("authorization"), `Bearer ${FAKE_KEY}`);
  assertEquals(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(init.body));
  assertEquals(body.expires_after, { anchor: "created_at", seconds: SECRET_TTL_SECONDS });
  assert(SECRET_TTL_SECONDS >= 10 && SECRET_TTL_SECONDS <= 7200, "within the API's range");
  const session = body.session;
  assertEquals(session.type, "realtime");
  assertEquals(session.model, REALTIME_MODEL);
  assertEquals(session.model, "gpt-realtime-2.1");
  assertEquals(session.audio.output.voice, REALTIME_VOICE);
  assertEquals(session.audio.input.turn_detection, null, "push-to-talk: the page ends each turn");
  assertEquals(session.audio.input.transcription.model, TRANSCRIBE_MODEL);
  assertEquals(session.instructions, LOOPY_INSTRUCTIONS);
  assertMatch(session.instructions, /Loopy/);
  assertEquals(session.tools.map((t: { name: string }) => t.name), ["set_mood"]);
  assertEquals(session.tools[0].parameters.properties.mood.enum, [...MOODS]);
});

Deno.test("loopy voice: OpenAI's refusals become safe errors that never quote the key", async () => {
  const cases: [Response | Error, string][] = [
    [
      Response.json({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }, {
        status: 401,
      }),
      "bad_key",
    ],
    [new Response("slow down", { status: 429 }), "rate_limited"],
    [new Response(FAKE_KEY, { status: 500 }), "upstream"],
    [Response.json({ session: {} }), "upstream"],
    [new Error("offline"), "upstream"],
  ];
  for (const [answer, code] of cases) {
    const fn = (() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) as typeof fetch;
    const err = await mintClientSecret({ apiKey: FAKE_KEY, tools: [], fetch: fn }).then(
      () =>
        null,
      (e) => e,
    );
    assert(err instanceof VoiceError, code);
    assertEquals(err.code, code);
    assert(
      !err.message.includes(FAKE_KEY) && !err.message.includes("sk-"),
      "no key in the message",
    );
  }
});

Deno.test("loopy voice tools: set_mood takes Loopy's 13 moods; bad calls become outputs, not throws", async () => {
  const tools = createToolRegistry();
  assertEquals(tools.definitions().length, 1);
  assertEquals(MOODS.length, 13);
  for (const mood of MOODS) {
    const r = await tools.call("set_mood", JSON.stringify({ mood }));
    assertEquals(r, { output: JSON.stringify({ ok: true }), mood });
  }
  const bad = await tools.call("set_mood", JSON.stringify({ mood: "angry" }));
  assertEquals(bad.mood, undefined);
  assertEquals(JSON.parse(bad.output).ok, false);
  assertEquals(JSON.parse((await tools.call("nope", "{}")).output).error, "unknown tool: nope");
  assertEquals(
    JSON.parse((await tools.call("set_mood", "{oops")).output).error,
    "arguments are not JSON",
  );
  assertEquals(
    JSON.parse((await tools.call("set_mood", "x".repeat(MAX_ARGUMENTS + 1))).output).error,
    "arguments too long",
  );
  const throwing = createToolRegistry([{
    definition: { ...setMoodTool.definition, name: "boom" },
    run: () => {
      throw new Error("secret detail");
    },
  }]);
  assertEquals(JSON.parse((await throwing.call("boom", "{}")).output), {
    ok: false,
    error: "boom failed",
  });
});

Deno.test("loopy voice service: status never carries the key; no key refuses; limits hold", async () => {
  const store = fakeSecureStore();
  let now = 0;
  const net = fakeFetch(secretAnswer);
  const service = createVoiceService({
    keys: keychainKeyStore(store.capability),
    fetch: net.fn,
    now: () => now,
  });
  assertEquals(await service.status(), { hasKey: false, keySource: "keychain" });
  const refused = await service.session().catch((e) => e);
  assertEquals([refused.code, refused.status], ["no_key", 409]);
  assertEquals(net.calls.length, 0, "no request without a key");

  const err = await service.setKey({ key: "short" }).catch((e) => e);
  assertEquals(err.code, "validation");
  const err2 = await service.setKey({ key: "has spaces in it, twenty chars" }).catch((e) => e);
  assertEquals(err2.code, "validation");
  const status = await service.setKey({ key: `  ${FAKE_KEY}\n` });
  assertEquals(status, { hasKey: true, keySource: "keychain" });
  assertEquals(store.items.get(KEY_ITEM), FAKE_KEY, "trimmed, in the keychain under its item");
  assert(!JSON.stringify(status).includes(FAKE_KEY));

  // The refused call counted towards the limit too.
  for (let i = 1; i < VOICE_LIMITS.session.limit; i++) {
    assertEquals((await service.session()).value, "ek_ephemeral");
  }
  assertEquals((await service.session().catch((e) => e)).code, "rate_limited");
  now += VOICE_LIMITS.session.windowMs;
  assertEquals((await service.session()).value, "ek_ephemeral", "the window slides");
  assertEquals(new Headers(net.calls[0].init.headers).get("authorization"), `Bearer ${FAKE_KEY}`);

  assertEquals(await service.tool({ name: "set_mood", arguments: '{"mood":"love"}' }), {
    output: '{"ok":true}',
    mood: "love",
  });
  assertEquals((await service.tool({ name: 5 }).catch((e) => e)).code, "validation");
  assertEquals(await service.clearKey(), { hasKey: false, keySource: "keychain" });
  assertEquals(store.items.size, 0);
});

Deno.test("loopy voice service: the rate limiter is a sliding window", () => {
  let now = 1_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 100 }, () => now);
  assertEquals([limiter.take(), limiter.take(), limiter.take()], [true, true, false]);
  now += 99;
  assertEquals(limiter.take(), false);
  now += 1;
  assertEquals(limiter.take(), true);
});

Deno.test("loopy voice keys: the dev server's key is OPENAI_API_KEY, read-only", async () => {
  const env = new Map([[KEY_ENV, ` ${FAKE_KEY} `]]);
  const keys = envKeyStore((name) => env.get(name));
  assertEquals(keys.source, "env");
  assertEquals(await keys.get(), FAKE_KEY);
  assertEquals((await keys.set("x").catch((e) => e)).code, "read_only");
  assertEquals((await keys.clear().catch((e) => e)).code, "read_only");
  env.delete(KEY_ENV);
  assertEquals(await keys.get(), null);
  assertEquals(await envKeyStore(() => "  ").get(), null);
});

Deno.test("loopy voice desktop: the page's bridge loses secureStore; loopyVoice never returns the key", async () => {
  const store = fakeSecureStore();
  const other = { name: "globalShortcuts", methods: {} };
  const net = fakeFetch(secretAnswer);
  const caps = voiceCapabilities([store.capability, other], DesktopCapError, net.fn);
  assertEquals(caps.map((c) => c.name), ["globalShortcuts", VOICE_CAPABILITY]);
  const voice = caps[1];
  const call = (method: string, args: unknown = {}) =>
    Promise.resolve(voice.methods[method].handler(args, {} as never));

  const refused = await call("session").catch((e) => e);
  assert(refused instanceof DesktopCapError);
  assertEquals([refused.code, refused.status], ["no_key", 409]);

  const answers = [
    await call("setKey", { key: FAKE_KEY }),
    await call("status"),
    await call("session"),
    await call("tool", { name: "set_mood", arguments: '{"mood":"wow"}' }),
  ];
  assertEquals(store.items.get(KEY_ITEM), FAKE_KEY);
  for (const a of answers) assert(!JSON.stringify(a).includes(FAKE_KEY), JSON.stringify(a));
  assertEquals(answers[2], { value: "ek_ephemeral", expiresAt: 1_900_000_000 });
  assertEquals(Object.keys(voice.methods).sort(), [
    "clearKey",
    "configure",
    "confirm",
    "forget",
    "forgetAll",
    "memories",
    "pending",
    "remember",
    "session",
    "setKey",
    "status",
    "tool",
  ]);
  assertEquals(voice.methods.session.permissions?.net, ["api.openai.com"]);
  assertEquals(await call("clearKey"), { hasKey: false, keySource: "keychain" });

  // A failure that isn't the backend's own is a generic bridge error.
  const broken = voiceCapabilities([{
    name: "secureStore",
    methods: {
      get: {
        handler: () => {
          throw new Error(`leaked ${FAKE_KEY}`);
        },
      },
    },
  }], DesktopCapError)[0];
  const err = await Promise.resolve(broken.methods.status.handler({}, {} as never)).then(
    () => null,
    (e) => e as DesktopCapError,
  );
  assertEquals(err?.code, "failed");
  assert(!err?.message.includes(FAKE_KEY));
});

/** A request to the dev route. */
function voiceRequest(
  body: unknown,
  { host = "localhost:3000", headers = {} as Record<string, string>, method = "POST" } = {},
): Request {
  return new Request(`http://${host}/api/voice`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

Deno.test("loopy voice dev route: only the page itself may call it", async () => {
  const net = fakeFetch(secretAnswer);
  const route = createVoiceRoute(
    createVoiceService({ keys: envKeyStore(() => FAKE_KEY), fetch: net.fn }),
  );
  const refusals: [Request, number, string][] = [
    [voiceRequest({ op: "session" }, { host: "evil.example" }), 403, "loopback_only"],
    [
      voiceRequest({ op: "session" }, { headers: { origin: "https://evil.example" } }),
      403,
      "cross_origin",
    ],
    [
      voiceRequest({ op: "session" }, { headers: { "sec-fetch-site": "cross-site" } }),
      403,
      "cross_origin",
    ],
    [
      voiceRequest({ op: "session" }, { headers: { "content-type": "text/plain" } }),
      415,
      "json_only",
    ],
    [voiceRequest(null, { method: "GET" }), 405, "method"],
  ];
  for (const [req, status, code] of refusals) {
    const res = await route(req);
    assertEquals([res.status, (await res.json()).error.code], [status, code]);
  }
  assertEquals(net.calls.length, 0);
  const big = await route(voiceRequest({ op: "tool", arguments: "x".repeat(MAX_BODY_BYTES) }));
  assertEquals(big.status, 413);

  const ok = await route(voiceRequest({ op: "session" }, {
    headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
  }));
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("cache-control"), "no-store");
  const text = await ok.text();
  assertEquals(JSON.parse(text), { value: "ek_ephemeral", expiresAt: 1_900_000_000 });
  assert(!text.includes(FAKE_KEY));

  const status = await route(voiceRequest({ op: "status" }));
  assertEquals(await status.json(), { hasKey: true, keySource: "env" });
  const set = await route(voiceRequest({ op: "setKey", key: FAKE_KEY }));
  assertEquals([set.status, (await set.json()).error.code], [409, "read_only"]);
  const tool = await route(
    voiceRequest({ op: "tool", name: "set_mood", arguments: '{"mood":"sad"}' }),
  );
  assertEquals((await tool.json()).mood, "sad");
  const unknown = await route(voiceRequest({ op: "launch" }));
  assertEquals(unknown.status, 404);
  const notJson = await route(
    new Request("http://127.0.0.1:3000/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  assertEquals(notJson.status, 400);
});

Deno.test("loopy voice page backend: the dev route's answers and refusals", async () => {
  const net = fakeFetch((_url, init) => {
    const body = JSON.parse(String(init.body));
    return body.op === "session"
      ? Response.json({ error: { code: "no_key", message: "Add a key" } }, { status: 409 })
      : Response.json({ hasKey: true, keySource: "env" });
  });
  const backend = routeBackend(net.fn);
  assertEquals(await backend.status(), { hasKey: true, keySource: "env" });
  const err = await backend.session({ webSearch: true, browser: false, memory: false }).catch((
    e,
  ) => e);
  assert(err instanceof VoiceBackendError);
  assertEquals([err.code, err.message], ["no_key", "Add a key"]);
  assertEquals(net.calls[0].url, VOICE_ROUTE);
  assertEquals(new Headers(net.calls[0].init.headers).get("content-type"), "application/json");
  await backend.tool({ name: "set_mood", arguments: "{}" });
  assertEquals(JSON.parse(String(net.calls[2].init.body)), {
    op: "tool",
    name: "set_mood",
    arguments: "{}",
  });
});

/** A `response.done` whose output is `items`. */
const responseDone = (...items: unknown[]): ServerEvent => ({
  type: "response.done",
  response: { status: "completed", output: items },
});

Deno.test("loopy tool relay: each call goes to the backend, its output back to the model", async () => {
  const sent: Record<string, unknown>[] = [];
  const moods: string[] = [];
  const asked: unknown[] = [];
  const opts = {
    call: (c: { name: string; arguments: string }) => {
      asked.push(c);
      return Promise.resolve({ output: '{"ok":true}', mood: "excited" });
    },
    send: (e: Record<string, unknown>) => void sent.push(e),
    onMood: (m: string) => void moods.push(m),
    round: 1,
  };
  const event = responseDone({
    type: "function_call",
    name: "set_mood",
    call_id: "call_1",
    arguments: '{"mood":"excited"}',
  });
  assertEquals(await relayToolCalls(event, opts), true);
  assertEquals(asked, [{ name: "set_mood", arguments: '{"mood":"excited"}' }]);
  assertEquals(moods, ["excited"]);
  assertEquals(sent, [
    {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    },
    { type: "response.create" },
  ]);

  // A response that already spoke needs no follow-up; nor does the last allowed round.
  sent.length = 0;
  const spoke = responseDone(
    { type: "function_call", name: "set_mood", call_id: "c2", arguments: "{}" },
    { type: "message", role: "assistant" },
  );
  assertEquals(await relayToolCalls(spoke, opts), false);
  assertEquals(sent.length, 1);
  assertEquals(await relayToolCalls(event, { ...opts, round: MAX_TOOL_ROUNDS }), false);
  assertEquals(await relayToolCalls(responseDone({ type: "message" }), opts), false);

  // A failing backend still answers the call, and a mood outside the 13 is ignored.
  sent.length = 0;
  moods.length = 0;
  await relayToolCalls(event, {
    ...opts,
    call: () => Promise.reject(new Error("rate limited")),
  });
  assertEquals((sent[0].item as { output: string }).output, '{"ok":false,"error":"rate limited"}');
  await relayToolCalls(event, {
    ...opts,
    call: () => Promise.resolve({ output: "{}", mood: "furious" }),
  });
  assertEquals(moods, []);
});

Deno.test("loopy voice machine: a push-to-talk turn, with live transcripts and Loopy's voice", () => {
  const run = (events: VoiceEvent[], from = INITIAL_VOICE) => events.reduce(voiceReducer, from);
  const srv = (event: ServerEvent): VoiceEvent => ({ type: "server", event });
  let v = run([{ type: "connect" }]);
  assertEquals(v.phase, "connecting");
  assertEquals(voiceLook(v.phase), { voice: "thinking", think: true });
  v = run([{ type: "connected" }, { type: "listen" }], v);
  assertEquals(v.phase, "listening");
  assertEquals(voiceLook(v.phase), { voice: "listening", think: false });
  v = run([
    { type: "send" },
    srv({ type: "conversation.item.input_audio_transcription.delta", delta: "What's " }),
    srv({ type: "conversation.item.input_audio_transcription.delta", delta: "up" }),
  ], v);
  assertEquals([v.phase, v.user], ["thinking", "What's up"]);
  v = run([
    srv({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "What's up?",
    }),
    srv({
      type: "response.done",
      response: { output: [{ type: "function_call", name: "set_mood", call_id: "c" }] },
    }),
  ], v);
  assertEquals([v.phase, v.user], ["thinking", "What's up?"], "a tool call keeps it thinking");
  v = run([
    { type: "mood", mood: "excited" },
    srv({ type: "output_audio_buffer.started" }),
    srv({ type: "response.output_audio_transcript.delta", delta: "Not much, " }),
    srv({ type: "response.output_audio_transcript.delta", delta: "just bending!" }),
  ], v);
  assertEquals([v.phase, v.assistant, v.mood], ["speaking", "Not much, just bending!", "excited"]);
  assertEquals(voiceLook(v.phase), { voice: "speaking", think: false });
  v = run([srv({ type: "response.done", response: { status: "completed", output: [] } })], v);
  assertEquals(v.phase, "speaking", "still playing after the response is done");
  v = run([srv({ type: "output_audio_buffer.stopped" })], v);
  assertEquals(v.phase, "ready");
  assertEquals(voiceBusy(v.phase), false);
  v = run([{ type: "listen" }], v);
  assertEquals([v.user, v.assistant], ["", ""], "a new turn clears the transcript");
  v = run([{ type: "cancel" }], v);
  assertEquals(v.phase, "ready");
});

Deno.test("loopy voice machine: errors, failures and the bubble's limits", () => {
  const empty = voiceReducer({ ...INITIAL_VOICE, phase: "thinking" }, {
    type: "server",
    event: { type: "error", error: { code: "input_audio_buffer_commit_empty", message: "x" } },
  });
  assertEquals([empty.phase, empty.error], ["ready", "I didn't catch that. Try again?"]);
  const other = voiceReducer(INITIAL_VOICE, {
    type: "server",
    event: { type: "error", error: { message: "bad thing" } },
  });
  assertEquals(other.error, "Voice error: bad thing");
  const failed = voiceReducer({ ...INITIAL_VOICE, phase: "connecting" }, {
    type: "failed",
    message: "no mic",
    closed: true,
  });
  assertEquals([failed.phase, failed.error], ["off", "no mic"]);
  assertEquals(
    voiceReducer(failed, { type: "connected" }).phase,
    "off",
    "a stale connect is ignored",
  );
  assertEquals(voiceReducer(failed, { type: "clear" }).error, null);
  const long = voiceReducer(INITIAL_VOICE, {
    type: "server",
    event: { type: "response.output_audio_transcript.delta", delta: "a".repeat(5_000) },
  });
  assertEquals(long.assistant.length, MAX_TRANSCRIPT);
  assertEquals(
    functionCalls(responseDone(
      { type: "function_call", name: "set_mood", call_id: "c1", arguments: "{}" },
      { type: "function_call", name: 3 },
      { type: "message" },
    )),
    [{ name: "set_mood", callId: "c1", arguments: "{}" }],
  );
  assertEquals(functionCalls({ type: "response.created" }), []);
});

Deno.test("loopy voice machine: how Loopy is drawn during a turn, and what its machine hears", () => {
  const thinking = { ...INITIAL_VOICE, phase: "thinking" as const, mood: "confused" as const };
  assertEquals(voiceStage(thinking, "idle", { mood: "success" }), {
    voiceUp: true,
    state: "think",
    mood: "confused",
    voice: "thinking",
  });
  assertEquals(voiceStage(thinking, "hidden").state, "hidden", "no thinking while folded away");
  const listening = { ...INITIAL_VOICE, phase: "listening" as const };
  assertEquals(
    voiceStage(listening, "idle", { mood: "sad" }).mood,
    "sad",
    "no mood set yet: the message's",
  );
  assertEquals(voiceStage(INITIAL_VOICE, "point", { mood: "attention" }), {
    voiceUp: false,
    state: "point",
    mood: "attention",
    voice: undefined,
  });
  const done = {
    ...INITIAL_VOICE,
    phase: "ready" as const,
    assistant: "Done!",
    mood: "wow" as const,
  };
  assertEquals(voiceOnScreen(done), true, "the transcript stays up after the turn");
  assertEquals(voiceStage(done, "idle").mood, "wow");
  assertEquals(voiceNudge("connecting", "hidden", false), { type: "show" });
  assertEquals(voiceNudge("listening", "idle", false), null);
  assertEquals(voiceNudge("ready", "think", false), { type: "settle" });
  assertEquals(voiceNudge("ready", "point", true), null, "a message's held move stays");
  assertEquals(voiceNudge("off", "idle", false), null);
});

Deno.test("loopy lip-sync: the voice's level opens the mouth in steps; silence closes it", () => {
  assertEquals(rmsLevel(new Uint8Array(512).fill(128)), 0);
  assertEquals(rmsLevel([]), 0);
  const loud = Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 0));
  assert(rmsLevel(loud) > 0.99);
  assertEquals(levelStep(0), 0);
  assertEquals(levelStep(SILENCE), 0, "breath and line noise stay closed");
  assertEquals(levelStep(SILENCE + 0.001), 1, "any voice opens it a little");
  assertEquals(levelStep(FULL), LEVEL_STEPS);
  assertEquals(levelStep(1), LEVEL_STEPS);
  let steps = -1;
  for (let l = 0; l <= 0.3; l += 0.01) {
    const s = levelStep(l);
    assert(s >= steps, "the mouth opens monotonically with the level");
    steps = s;
  }
  assertEquals(smoothLevel(0, 1), 0.6, "a quick attack");
  assertEquals(smoothLevel(1, 0), 0.75, "a slower release");
  assertEquals(mouthShape(0).open, false);
  const heights = [1, 2, 3, 4].map((s) => {
    const m = mouthShape(s);
    assert(m.open);
    return Number(m.d.match(/a[\d.]+ ([\d.]+)/)?.[1]);
  });
  assertEquals([...heights].sort((a, b) => a - b), heights, "taller with each step");
  assertEquals(mouthShape(99).d, mouthShape(LEVEL_STEPS).d, "clamped");
});

Deno.test("Loopy lip-syncs while speaking and pulses with the mic while listening", async () => {
  const speaking = await renderToString(
    h(Loopy, { state: "idle", mood: "wow", voice: "speaking", level: 3 }),
  );
  assertMatch(speaking, /data-voice="speaking"/);
  const shape = mouthShape(3);
  assert(speaking.includes(`class="loopy-mouth is-open" d="${shape.d}"`), "the lip-sync mouth");
  const closed = await renderToString(h(Loopy, { state: "idle", voice: "speaking", level: 0 }));
  assert(closed.includes(`class="loopy-mouth" d="${mouthShape(0).d}"`));
  const listening = await renderToString(
    h(Loopy, { state: "idle", voice: "listening", level: 2 }),
  );
  assertMatch(listening, /data-voice="listening"/);
  assertMatch(listening, /--loopy-listen: ?0\.5/);
  const still = await renderToString(h(Loopy, { state: "idle", mood: "sad" }));
  assert(!still.includes("data-voice"), "no voice attribute outside a turn");
  assertMatch(still, /--loopy-listen: ?0[;"]/);
});

Deno.test("loopy settings: defaults, kept in storage, every field checked", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  assertEquals(loadSettings(storage), DEFAULT_SETTINGS);
  assertEquals(DEFAULT_SETTINGS, {
    pushToTalk: true,
    clickToTalk: true,
    globalShortcut: false,
    wakeWord: false,
    webSearch: true,
    browser: false,
    memory: false,
    scale: 125,
  });
  const mine = {
    ...DEFAULT_SETTINGS,
    clickToTalk: false,
    globalShortcut: true,
    browser: true,
    memory: true,
    scale: 200,
  };
  saveSettings(storage, mine);
  assertEquals(loadSettings(storage), mine);
  assert(!map.get(SETTINGS_KEY)!.includes("sk-"), "no key in the settings");
  map.set(
    SETTINGS_KEY,
    JSON.stringify({ pushToTalk: "yes", wakeWord: true, scale: 9_000, clickToTalk: false }),
  );
  assertEquals(loadSettings(storage), {
    ...DEFAULT_SETTINGS,
    clickToTalk: false,
    scale: SCALE.max,
  }, "bad fields take their defaults; the wake word stays off");
  map.set(SETTINGS_KEY, "{not json");
  assertEquals(loadSettings(storage), DEFAULT_SETTINGS);
  const refusing = {
    getItem: (): string | null => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assertEquals(loadSettings(refusing), DEFAULT_SETTINGS);
  saveSettings(refusing, mine); // does not throw
  assertEquals(loadSettings(undefined), DEFAULT_SETTINGS);
});

Deno.test("loopy size: clamped to whole steps; ?scale= takes a percentage or a factor", () => {
  assertEquals([clampScale(50), clampScale(300), clampScale(127), clampScale("150")], [
    75,
    250,
    125,
    150,
  ]);
  assertEquals(clampScale(Number.NaN), undefined);
  assertEquals(clampScale("big"), undefined);
  assertEquals(scaleFromQuery("?scale=150"), 150);
  assertEquals(scaleFromQuery("?scale=1.5"), 150);
  assertEquals(scaleFromQuery("?scale=200%25"), 200);
  assertEquals(scaleFromQuery("?scale=2.5"), 250);
  assertEquals(scaleFromQuery("?scale=999"), 250);
  assertEquals(scaleFromQuery("?scale=0.1"), 75);
  assertEquals(scaleFromQuery("?scale=abc"), undefined);
  assertEquals(scaleFromQuery("?scale=-2"), undefined);
  assertEquals(scaleFromQuery("?other=1"), undefined);
  assertEquals(scaleFromQuery(""), undefined);
});

Deno.test("loopy size: the window is the base size scaled, resized about its bottom-right corner", () => {
  assertEquals(WINDOW_SIZE, { width: 260, height: 300 });
  // The window opens at the default size, so the first frame needs no resize.
  const first = companionConfig.desktop?.window as { width?: number; height?: number };
  assertEquals({ width: first.width, height: first.height }, scaledWindowSize(SCALE.default));
  assertEquals(scaledWindowSize(100), WINDOW_SIZE);
  assertEquals(scaledWindowSize(SCALE.default), { width: 325, height: 375 });
  assertEquals(scaledWindowSize(SCALE.min), { width: 195, height: 225 });
  assertEquals(scaledWindowSize(SCALE.max), { width: 650, height: 750 });
  assertEquals(scaledWindowSize(115), { width: 299, height: 345 }, "rounded to whole pixels");

  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const screen = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea, isPrimary: true };
  const flat = { wayland: false, edgeAnchored: false };
  for (const scale of [SCALE.min, 100, SCALE.default, 180, SCALE.max]) {
    const size = scaledWindowSize(scale);
    const corner = cornerOnScreen(screen, size, flat);
    const placed = { ...corner, ...size };
    // Placed in the corner, its bottom-right is 16 px in from the work area's at every size …
    assertEquals(placed.x + placed.width, workArea.width - 16, `right at ${scale}%`);
    assertEquals(
      placed.y + placed.height,
      workArea.y + workArea.height - 16,
      `bottom at ${scale}%`,
    );
    // … and resizing to any other size keeps that corner where it is.
    for (const next of [SCALE.min, 140, SCALE.max]) {
      const resized = anchoredBounds(placed, scaledWindowSize(next));
      assertEquals(resized.x + resized.width, placed.x + placed.width);
      assertEquals(resized.y + resized.height, placed.y + placed.height);
      assertEquals(
        { width: resized.width, height: resized.height },
        scaledWindowSize(next),
      );
    }
  }
  // A window the user dragged elsewhere grows from its own bottom-right corner.
  assertEquals(
    anchoredBounds({ x: 100, y: 200, width: 260, height: 300 }, { width: 325, height: 375 }),
    {
      x: 35,
      y: 125,
      width: 325,
      height: 375,
    },
  );
  // On Wayland (a layer surface) the corner is margins from the display's top-left, at any size.
  const wl = cornerOnScreen(
    { bounds: screen.bounds, workArea: screen.bounds, isPrimary: true },
    scaledWindowSize(SCALE.max),
    { wayland: true, edgeAnchored: false },
  );
  assertEquals(wl, {
    x: 1440 - WAYLAND_PANEL_INSET - 16 - 650,
    y: 900 - WAYLAND_PANEL_INSET - 16 - 750,
  });
});

Deno.test("loopy size: the hit region follows Loopy scaled with the page, inside the window", () => {
  // The page is laid out at the base size and scaled from its top-left (styles.css), so a box at
  // (x, y, w, h) in layout pixels is at (x·s, y·s, w·s, h·s) in the window: what
  // getBoundingClientRect reports, and so what the hit region gets.
  const loopyBox = { left: 34, top: 140, right: 154, bottom: 290 }; // Loopy at 100 %
  for (const scale of [SCALE.min, 100, SCALE.default, SCALE.max]) {
    const s = scale / 100;
    const size = scaledWindowSize(scale);
    const [rect] = hitRects([{
      left: loopyBox.left * s,
      top: loopyBox.top * s,
      right: loopyBox.right * s,
      bottom: loopyBox.bottom * s,
    }]);
    assert(rect.x >= 0 && rect.y >= 0, `${scale}%`);
    assert(rect.x + rect.width <= size.width + 1 && rect.y + rect.height <= size.height + 1);
    assertEquals(rect.width, Math.ceil(loopyBox.right * s) - Math.floor(loopyBox.left * s));
    assert(
      insideAny([rect], ((loopyBox.left + loopyBox.right) / 2) * s, 200 * s),
      "Loopy catches clicks",
    );
    assert(!insideAny([rect], 5 * s, 5 * s), "the empty corner lets them through");
  }
});

/** A media track and stream the fakes hand out. */
function fakeMic() {
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

Deno.test("loopy microphone: getUserMedia's failures are named, and the desktop app says why", async () => {
  const fail = (name: string) => ({
    getUserMedia: () => Promise.reject(Object.assign(new Error(name), { name })),
  });
  const problem = (devices: Parameters<typeof openMicrophone>[0]) =>
    openMicrophone(devices).then(() => "opened", (e) => (e as MicUnavailableError).problem);
  assertEquals(await problem(undefined), "no_api");
  assertEquals(await problem({} as MediaDevices), "no_api");
  assertEquals(await problem(fail("NotAllowedError")), "denied");
  assertEquals(await problem(fail("NotFoundError")), "no_device");
  assertEquals(await problem(fail("AbortError")), "failed");
  const { stream } = fakeMic();
  assertEquals(await problem({ getUserMedia: () => Promise.resolve(stream) }), "opened");
  for (const p of ["no_api", "denied", "no_device", "failed"] as const) {
    assertMatch(micErrorMessage(p, true), /desktop app yet.*browser/);
    assert(!micErrorMessage(p, false).includes("desktop"));
  }
});

Deno.test("loopy realtime client: the SDP offer goes to OpenAI with the secret; events flow both ways", async () => {
  const { track, stream } = fakeMic();
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const sentOnChannel: string[] = [];
  const channel = {
    readyState: "connecting",
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...listeners.get(type) ?? [], fn]);
    },
    send: (data: string) => void sentOnChannel.push(data),
    close() {},
  };
  const emit = (type: string, e: unknown = {}) => {
    for (const fn of listeners.get(type) ?? []) fn(e);
  };
  let remote: unknown;
  let label = "";
  class FakePeer {
    ontrack: ((e: unknown) => void) | null = null;
    added: unknown[] = [];
    addTrack(t: unknown) {
      this.added.push(t);
    }
    createDataChannel(name: string) {
      label = name;
      return channel;
    }
    createOffer() {
      return Promise.resolve({ type: "offer", sdp: "v=0 offer" });
    }
    setLocalDescription() {
      return Promise.resolve();
    }
    setRemoteDescription(d: { type: string; sdp: string }) {
      assertEquals(d, { type: "answer", sdp: "v=0 answer" });
      queueMicrotask(() => {
        channel.readyState = "open";
        emit("open");
        this.ontrack?.({ streams: ["the voice"] });
      });
      return Promise.resolve();
    }
    close() {}
  }
  const net = fakeFetch(() => new Response("v=0 answer"));
  const events: unknown[] = [];
  const conn = await connectRealtime({
    secret: "ek_ephemeral",
    mic: stream,
    onEvent: (e) => events.push(e),
    onRemoteStream: (s) => (remote = s),
    onClose: () => {},
    deps: { RTCPeerConnection: FakePeer as unknown as typeof RTCPeerConnection, fetch: net.fn },
  });
  assertEquals(label, EVENTS_CHANNEL);
  assertEquals(track.enabled, false, "the microphone starts off");
  assertEquals(net.calls[0].url, CALLS_URL);
  assertEquals(net.calls[0].url, "https://api.openai.com/v1/realtime/calls");
  assertEquals(net.calls[0].init.body, "v=0 offer");
  const headers = new Headers(net.calls[0].init.headers);
  assertEquals(headers.get("authorization"), "Bearer ek_ephemeral");
  assertEquals(headers.get("content-type"), "application/sdp");
  await Promise.resolve();
  assertEquals(remote, "the voice");
  conn.setMicOn(true);
  assertEquals(track.enabled, true);
  conn.send({ type: "input_audio_buffer.commit" });
  assertEquals(sentOnChannel, ['{"type":"input_audio_buffer.commit"}']);
  emit("message", { data: '{"type":"output_audio_buffer.started"}' });
  emit("message", { data: "not json" });
  emit("message", { data: '{"no":"type"}' });
  assertEquals(events, [{ type: "output_audio_buffer.started" }]);
  conn.close();
  assert(track.stopped, "closing stops the microphone");
  conn.send({ type: "response.create" });
  assertEquals(sentOnChannel.length, 1, "nothing is sent once closed");

  // OpenAI refusing the offer closes everything and says so.
  const mic2 = fakeMic();
  const refused = await connectRealtime({
    secret: "ek_old",
    mic: mic2.stream,
    onEvent: () => {},
    onRemoteStream: () => {},
    onClose: () => {},
    deps: {
      RTCPeerConnection: FakePeer as unknown as typeof RTCPeerConnection,
      fetch: fakeFetch(() => new Response("expired", { status: 401 })).fn,
    },
  }).catch((e) => e);
  assertMatch(refused.message, /refused the voice connection \(401\)/);
  assert(mic2.track.stopped);
});

Deno.test("VoiceBubble shows what the user said and what Loopy says, or what is going on", async () => {
  const html = await renderToString(h(VoiceBubble, {
    voice: {
      ...INITIAL_VOICE,
      phase: "speaking",
      user: "Hi Loopy",
      assistant: "Hello!",
      mood: "love",
    },
    onClose: () => {},
  }));
  assert(html.includes("Hi Loopy") && html.includes("Hello!"));
  assertMatch(html, /data-mood="love"/);
  assertMatch(html, /data-loopy-hit=""/);
  const listening = await renderToString(h(VoiceBubble, {
    voice: { ...INITIAL_VOICE, phase: "listening" },
    onClose: () => {},
  }));
  assert(listening.includes("Listening…"));
  assertEquals(voiceBubbleShown(INITIAL_VOICE), false);
  assertEquals(voiceBubbleShown({ ...INITIAL_VOICE, error: "no mic" }), true);
});

Deno.test("VoiceSettings: the key field is write-only; each way of talking toggles; wake word is coming soon", async () => {
  let settings = DEFAULT_SETTINGS;
  const keys: string[] = [];
  const screen = await render(h(VoiceSettings, {
    settings,
    onChange: (s: typeof settings) => (settings = s),
    status: { hasKey: true, keySource: "keychain" },
    onSetKey: (k: string) => (keys.push(k), Promise.resolve(null)),
    onClearKey: () => Promise.resolve(null),
    desktop: true,
    shortcutProblem: null,
    onClose: () => {},
  }));
  try {
    const field = screen.getByPlaceholderText("Paste a new key to replace it");
    assertEquals(field.getAttribute("aria-label"), "OpenAI API key");
    assertEquals(field.getAttribute("type"), "password");
    assertEquals(field.value, "", "a saved key is never shown");
    assertExists(screen.getByText("A key is saved in your keychain."));
    await screen.fireEvent.input(field, { target: { value: FAKE_KEY } });
    assertExists(screen.getByRole("button", { name: "Replace" }));
    await screen.fireEvent.submit(screen.getByRole("form", { name: "Set the API key" }));
    await waitFor(() => assertEquals(keys, [FAKE_KEY]));
    assertExists(screen.getByRole("button", { name: "Clear" }));
    const wake = screen.getByLabelText(/Hey Loopy/);
    assert(wake.hasAttribute("disabled"), "the wake word is not built yet");
    assertExists(screen.getByText("coming soon"));
    await screen.fireEvent.click(screen.getByLabelText(/Click Loopy to talk/));
    assertEquals(settings.clickToTalk, false);
    const slider = screen.getByRole("slider");
    assertEquals(slider.getAttribute("aria-label"), "Loopy's size");
    assertEquals([slider.getAttribute("min"), slider.getAttribute("max")], ["75", "250"]);
    await screen.fireEvent.input(slider, { target: { value: "180" } });
    assertEquals(settings.scale, 180);
  } finally {
    await screen.unmount();
  }
  const dev = await renderToString(h(VoiceSettings, {
    settings: DEFAULT_SETTINGS,
    onChange: () => {},
    status: { hasKey: false, keySource: "env" },
    onSetKey: () => Promise.resolve(null),
    onClearKey: () => Promise.resolve(null),
    desktop: false,
    shortcutProblem: null,
    onClose: () => {},
  }));
  assert(dev.includes("Set OPENAI_API_KEY in the dev server"), "the dev server's key is env-only");
  assert(!dev.includes('type="password"'), "no key field where it can't be set");
  assert(dev.includes("desktop app only"));
});
