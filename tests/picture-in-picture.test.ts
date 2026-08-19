// usePictureInPicture: a React-style hook over the Picture-in-Picture API. The
// API is browser-only (absent in Deno), so a persistent global `document` +
// per-video `requestPictureInPicture` mock (firing enter/leave events on the
// rendered fake <video>) drive the client path. PiP is a browser singleton, so
// isActive is per-video while isPiPOpen is the shared global read.

import { assertEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  type PictureInPictureControls,
  usePictureInPicture,
} from "../src/runtime/picture-in-picture.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const g = globalThis as Any;

/** A stand-in PictureInPictureWindow with a fireable resize event. */
function mockWindow() {
  let onResize: (() => void) | null = null;
  return {
    width: 640,
    height: 360,
    addEventListener(type: string, cb: () => void) {
      if (type === "resize") onResize = cb;
    },
    removeEventListener() {},
    fireResize() {
      onResize?.();
    },
  };
}

/** Install a persistent global `document` exposing the PiP surface. */
function installDoc(enabled = true) {
  const doc: Any = {
    pictureInPictureEnabled: enabled,
    pictureInPictureElement: null,
    exitPictureInPicture() {
      const el = doc.pictureInPictureElement;
      doc.pictureInPictureElement = null;
      el?.dispatch("leavepictureinpicture");
      return Promise.resolve();
    },
  };
  g.document = doc;
  return doc;
}

/** Give a rendered fake <video> a requestPictureInPicture that fires the enter event. */
function equipVideo(video: Any, doc: Any, win: ReturnType<typeof mockWindow>) {
  video.requestPictureInPicture = () => {
    doc.pictureInPictureElement = video;
    video.dispatch("enterpictureinpicture", { pictureInPictureWindow: win });
    return Promise.resolve(win);
  };
}

/** Mount a component using the hook; returns the root, the <video>, and the controls ref. */
function mount(ref: { c?: PictureInPictureControls }) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function View() {
    ref.c = usePictureInPicture({});
    return h("video", { ref: ref.c.ref as Any });
  }
  const root = createRoot(container as Any);
  root.render(h(View, null));
  flushSync();
  return { root, video: container.childNodes[0] as Any };
}

Deno.test("usePictureInPicture: enter → isActive/isPiPOpen/pipWindow; exit clears them", async () => {
  const doc = installDoc();
  const win = mockWindow();
  const pip: { c?: PictureInPictureControls } = {};
  let entered = 0, exited = 0, resized = 0;
  const { doc: rdoc, container } = makeDom();
  setDocument(rdoc as Any);
  function View() {
    pip.c = usePictureInPicture({
      onEnter: () => entered++,
      onExit: () => exited++,
      onResize: () => resized++,
    });
    return h("video", { ref: pip.c.ref as Any });
  }
  const root = createRoot(container as Any);
  root.render(h(View, null));
  flushSync();
  const video = container.childNodes[0] as Any;
  equipVideo(video, doc, win);

  try {
    assertEquals(pip.c!.isSupported, true);
    assertEquals(pip.c!.isActive, false);
    assertEquals(pip.c!.isPiPOpen, false);

    await pip.c!.enter();
    flushSync();
    assertEquals(pip.c!.isActive, true, "this video is in PiP");
    assertEquals(pip.c!.isPiPOpen, true);
    assertEquals(pip.c!.pipWindow, win as Any);
    assertEquals(entered, 1);

    win.fireResize();
    assertEquals(resized, 1, "onResize fires on window resize");

    await pip.c!.exit();
    flushSync();
    assertEquals(pip.c!.isActive, false);
    assertEquals(pip.c!.isPiPOpen, false);
    assertEquals(pip.c!.pipWindow, null);
    assertEquals(exited, 1);
  } finally {
    root.unmount();
    delete g.document;
  }
});

Deno.test("usePictureInPicture: toggle enters then exits", async () => {
  const doc = installDoc();
  const win = mockWindow();
  const pip: { c?: PictureInPictureControls } = {};
  const { video, root } = mount(pip);
  equipVideo(video, doc, win);
  try {
    await pip.c!.toggle();
    flushSync();
    assertEquals(pip.c!.isActive, true);
    await pip.c!.toggle();
    flushSync();
    assertEquals(pip.c!.isActive, false);
  } finally {
    root.unmount();
    delete g.document;
  }
});

Deno.test("usePictureInPicture: two instances — isActive is per-video, isPiPOpen is global", async () => {
  const doc = installDoc();
  const win = mockWindow();
  const A: { c?: PictureInPictureControls } = {};
  const B: { c?: PictureInPictureControls } = {};
  const ma = mount(A);
  const mb = mount(B);
  equipVideo(ma.video, doc, win);
  try {
    await A.c!.enter();
    flushSync();
    assertEquals(A.c!.isActive, true, "A holds PiP");
    assertEquals(B.c!.isActive, false, "B does not");
    assertEquals(A.c!.isPiPOpen, true);
    assertEquals(B.c!.isPiPOpen, true, "B still sees the global PiP state");
  } finally {
    ma.root.unmount();
    mb.root.unmount();
    delete g.document;
  }
});

Deno.test("usePictureInPicture: unsupported — isSupported false, enter is a no-op", () => {
  const doc = installDoc(false); // pictureInPictureEnabled: false
  const pip: { c?: PictureInPictureControls } = {};
  const { root, video } = mount(pip);
  video.requestPictureInPicture = () => {
    throw new Error("should not be called");
  };
  try {
    assertEquals(pip.c!.isSupported, false);
    return pip.c!.enter().then(() => {
      flushSync();
      assertEquals(pip.c!.isActive, false, "enter() was a no-op");
      assertEquals(doc.pictureInPictureElement, null);
      root.unmount();
    });
  } finally {
    delete g.document;
  }
});
