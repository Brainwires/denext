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
  cornerOnScreen,
  cornerPosition,
  primaryScreen,
  WAYLAND_PANEL_INSET,
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
  assert(html.includes('class="loopy-arm"'), "the arm that unbends");
  assertEquals(html.match(/<circle/g)?.length, 2 + 3, "two eyes and three thought dots");
  assert(!/<image|href=/.test(html), "no external assets");
  const named = await renderToString(h(Loopy, { state: "celebrate", label: "Loopy the clip" }));
  assertMatch(named, /data-state="celebrate"[^>]*aria-label="Loopy the clip"/);
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
