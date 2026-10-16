// denext/mobile now playing: setNowPlaying / clearNowPlaying / onMediaControl / useMediaControl /
// setAudioSession through a faked `DenextNowPlaying` plugin (the shell) and a faked
// `navigator.mediaSession` (the web, Deno Desktop).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  clearNowPlaying,
  type MediaControlEvent,
  onMediaControl,
  resetNowPlayingForTesting,
  setAudioSession,
  setNowPlaying,
  useMediaControl,
} from "../src/mobile/now-playing.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

const PLUGIN_METHODS = ["configureSession", "setNowPlaying", "clearNowPlaying"];

/** The `setNowPlaying` payloads a fake plugin received. */
function sent(calls: Array<[string, unknown]>): Any[] {
  return calls.filter(([m]) => m === "setNowPlaying").map(([, arg]) => arg);
}

Deno.test("setNowPlaying (shell): merged info, defaults, controls in order; restatements skipped", async () => {
  resetNowPlayingForTesting();
  const native = fakePlugin(PLUGIN_METHODS);
  await inShell("ios", { DenextNowPlaying: native.plugin }, async () => {
    await setNowPlaying({
      title: "Episode 42",
      artist: "The Show",
      album: "Season 3",
      artwork: "https://cdn.example.com/cover.jpg",
      duration: 1800,
      position: 0,
      playing: true,
      controls: ["seek", "next", "pause", "play", "bogus" as Any],
    });
    // A timeupdate a moment later: within a second of the clock, so not sent on.
    await setNowPlaying({ position: 0.25 });
    // A seek: sent.
    await setNowPlaying({ position: 600 });
    // A pause: sent, with the rest of the info kept.
    await setNowPlaying({ playing: false, position: 601 });
    await setNowPlaying({ playing: false, position: 601 });
    await clearNowPlaying();
    // After a clear nothing is merged from before; the defaults apply.
    await setNowPlaying({ title: "Live radio", duration: Infinity, playing: true });
  });
  const payloads = sent(native.calls);
  assertEquals(payloads[0], {
    title: "Episode 42",
    artist: "The Show",
    album: "Season 3",
    artwork: "https://cdn.example.com/cover.jpg",
    duration: 1800,
    position: 0,
    playbackRate: 1,
    playing: true,
    controls: ["play", "pause", "next", "seek"],
    seekOffset: 10,
  });
  assertEquals(payloads.map((p) => [p.position, p.playing]), [
    [0, true],
    [600, true],
    [601, false],
    [0, true],
  ]);
  assertEquals(payloads[2].title, "Episode 42");
  assertEquals(payloads[3], {
    title: "Live radio",
    position: 0,
    playbackRate: 1,
    playing: true,
    controls: ["play", "pause", "seek"],
    seekOffset: 10,
  });
  assertEquals(native.calls.filter(([m]) => m === "clearNowPlaying").length, 1);
});

Deno.test("setNowPlaying (shell): app artwork is read by the page into a data: URL, once", async () => {
  resetNowPlayingForTesting();
  const native = fakePlugin(PLUGIN_METHODS);
  const fetched: string[] = [];
  const fetch = (url: string) => {
    fetched.push(url);
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
    );
  };
  const location = { href: "capacitor://localhost/player/42" };
  await inShell("ios", { DenextNowPlaying: native.plugin }, async () => {
    await setNowPlaying({ title: "a", artwork: "/covers/a.png", playing: false });
    await setNowPlaying({ title: "b" });
    await setNowPlaying({ title: "c", artwork: "ftp://example.com/x.png" });
  }, { fetch, location });
  assertEquals(fetched, ["capacitor://localhost/covers/a.png"]);
  const payloads = sent(native.calls);
  assertEquals(payloads[0].artwork, "data:image/png;base64,AQID");
  assertEquals(payloads[1].artwork, "data:image/png;base64,AQID");
  assertEquals("artwork" in payloads[2], false, "an unreadable scheme is left out");
});

Deno.test("onMediaControl (shell): the plugin's events reach every handler; the listener goes with the last", async () => {
  resetNowPlayingForTesting();
  const native = fakePlugin(PLUGIN_METHODS);
  await inShell("android", { DenextNowPlaying: native.plugin }, async () => {
    const a: MediaControlEvent[] = [];
    const b: MediaControlEvent[] = [];
    const stopA = onMediaControl((e) => a.push(e));
    const stopB = onMediaControl((e) => {
      b.push(e);
      throw new Error("a broken handler does not stop the others");
    });
    await settle();
    assertEquals(native.listening(), 1, "one native listener for every handler");
    const error = console.error;
    console.error = () => {};
    try {
      native.fire("mediaControl", { action: "pause" });
      native.fire("mediaControl", { action: "seek", position: 42.5 });
      native.fire("mediaControl", { action: "seekForward", offset: 15 });
      native.fire("mediaControl", { action: "shuffle" });
    } finally {
      console.error = error;
    }
    assertEquals(a, [
      { action: "pause" },
      { action: "seek", position: 42.5 },
      { action: "seekForward", offset: 15 },
    ]);
    assertEquals(b.length, 3);
    stopA();
    stopA();
    assertEquals(native.listening(), 1);
    stopB();
    await settle();
    assertEquals(native.listening(), 0);
  });
});

Deno.test("useMediaControl: handles commands while mounted, with the latest handler", async () => {
  resetNowPlayingForTesting();
  const native = fakePlugin(PLUGIN_METHODS);
  await inShell("ios", { DenextNowPlaying: native.plugin }, async () => {
    const seen: string[] = [];
    let tag = "one";
    function Player() {
      useMediaControl((e) => seen.push(`${tag}:${e.action}`));
      return null;
    }
    const view = mount(() => h(Player as Any, null));
    await settle();
    native.fire("mediaControl", { action: "play" });
    tag = "two";
    view.rerender();
    native.fire("mediaControl", { action: "next" });
    view.root.unmount();
    await settle();
    native.fire("mediaControl", { action: "previous" });
    assertEquals(seen, ["one:play", "two:next"]);
    assertEquals(native.listening(), 0);
  });
});

Deno.test("setAudioSession: the plugin's configureSession; checked; nothing off the shell", async () => {
  const native = fakePlugin(PLUGIN_METHODS);
  await inShell("ios", { DenextNowPlaying: native.plugin }, async () => {
    await setAudioSession();
    await setAudioSession({ background: false, interruption: "mix" });
    await assertRejects(
      () => setAudioSession({ interruption: "loud" as Any }),
      TypeError,
      "unknown interruption",
    );
  });
  assertEquals(native.calls, [
    ["configureSession", { background: true, interruption: "exclusive" }],
    ["configureSession", { background: false, interruption: "mix" }],
  ]);
  await withGlobals({ Capacitor: undefined }, () => setAudioSession({ background: true }));
});

/** A fake `navigator.mediaSession` and `MediaMetadata`. */
function fakeMediaSession() {
  const handlers = new Map<string, ((details: Any) => void) | null>();
  const positions: unknown[] = [];
  const session: Any = {
    metadata: null,
    playbackState: "none",
    setActionHandler(action: string, handler: ((details: Any) => void) | null) {
      if (action === "stop") throw new TypeError("not supported");
      handlers.set(action, handler);
    },
    setPositionState(state?: unknown) {
      positions.push(state);
    },
  };
  class MediaMetadata {
    constructor(readonly init: Any) {}
  }
  return { session, handlers, positions, MediaMetadata };
}

Deno.test("setNowPlaying (web): the Media Session API; handlers only while onMediaControl listens", async () => {
  resetNowPlayingForTesting();
  const { session, handlers, positions, MediaMetadata } = fakeMediaSession();
  await withGlobals(
    { navigator: { mediaSession: session }, MediaMetadata, Capacitor: undefined },
    async () => {
      await setNowPlaying({
        title: "Song",
        artist: "Band",
        album: "LP",
        artwork: "/art.jpg",
        duration: 200,
        position: 250,
        playing: true,
        controls: ["play", "pause", "seek", "seekBackward", "stop"],
        seekOffset: 5,
      });
      assertEquals(session.metadata.init, {
        title: "Song",
        artist: "Band",
        album: "LP",
        artwork: [{ src: "/art.jpg" }],
      });
      assertEquals(session.playbackState, "playing");
      assertEquals(positions, [{ duration: 200, playbackRate: 1, position: 200 }]);
      assert(
        [...handlers.values()].every((h) => h === null),
        "no handler: the browser's own media keys",
      );
      const events: MediaControlEvent[] = [];
      const stop = onMediaControl((e) => events.push(e));
      assertEquals(
        [...handlers].filter(([, h]) => h !== null).map(([a]) => a),
        ["play", "pause", "seekto", "seekbackward"],
      );
      handlers.get("play")!({ action: "play" });
      handlers.get("seekto")!({ action: "seekto", seekTime: 12 });
      handlers.get("seekto")!({ action: "seekto" });
      handlers.get("seekbackward")!({ action: "seekbackward" });
      handlers.get("seekbackward")!({ action: "seekbackward", seekOffset: 30 });
      assertEquals(events, [
        { action: "play" },
        { action: "seek", position: 12 },
        { action: "seekBackward", offset: 5 },
        { action: "seekBackward", offset: 30 },
      ]);
      await setNowPlaying({ playing: false, position: 100 });
      assertEquals(session.playbackState, "paused");
      stop();
      assert([...handlers.values()].every((h) => h === null), "the last handler gone: cleared");
      await clearNowPlaying();
      assertEquals(session.metadata, null);
      assertEquals(session.playbackState, "none");
      assertEquals(positions.at(-1), undefined);
    },
  );
  // Neither a plugin nor the API (SSR, an old engine): nothing happens, nothing throws.
  await withGlobals({ navigator: {}, Capacitor: undefined }, async () => {
    await setNowPlaying({ title: "x", playing: true });
    await clearNowPlaying();
    onMediaControl(() => {})();
  });
  resetNowPlayingForTesting();
});
