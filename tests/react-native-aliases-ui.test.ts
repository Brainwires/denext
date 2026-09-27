// The UI stand-ins React Native mode aliases community packages to, on the in-memory DOM:
// react-native-webview's WebView as an <iframe> (srcdoc + bridge for inline HTML, the message
// bridge both ways, load events, injection), react-native-pager-view's scroll-snap PagerView
// (scroll → onPageScroll / onPageSelected / the scroll state, the ref methods) and
// @react-navigation/drawer's navigator and Drawer view (status, overlay, items, toggle,
// Escape, swipe to open, progress), driven through a small fake React Navigation core.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  WebView,
  webViewDocument,
  type WebViewHandle,
} from "../src/react-native-compat/webview.ts";
import { PagerView, type PagerViewHandle } from "../src/react-native-compat/pager-view.ts";
import {
  Drawer,
  type DrawerNavigationCore,
  drawerNavigatorExports,
  getDrawerStatusFromState,
  useDrawerProgress,
} from "../src/react-native-compat/drawer.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** Let effects and 0 ms timers run. */
async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, ms));
    flushSync();
  }
}

/** Every element under `root` with attribute `name` (optionally equal to `value`). */
function findAll(root: FakeElement, name: string, value?: string): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n.nodeType === 1) {
      const v = n.getAttribute(name);
      if (v !== null && (value === undefined || v === value)) out.push(n);
    }
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

/** Every element under `root` with tag `tag`. */
function byTag(root: FakeElement, tag: string): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n.nodeType === 1 && n.tagName === tag.toUpperCase()) out.push(n);
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

/** A fresh document, installed for the reconciler and as `globalThis.document`. */
function mount() {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const saved = Object.getOwnPropertyDescriptor(g, "document");
  Object.defineProperty(g, "document", { configurable: true, writable: true, value: doc });
  const root = createRoot(container as Any);
  return {
    doc,
    container,
    root,
    done() {
      root.unmount();
      if (saved) Object.defineProperty(g, "document", saved);
      else delete g.document;
    },
  };
}

/** An attribute or, failing that, the element's property of the same name. */
function attr(el: FakeElement, name: string): unknown {
  return el.getAttribute(name) ?? (el as Any)[name];
}

// ---- WebView ------------------------------------------------------------------------------

Deno.test("webViewDocument: base, bridge, before-content and after-content scripts", () => {
  const doc = webViewDocument("<p>hi</p>", {
    baseUrl: "https://example.test/",
    before: "window.x = 1;",
    after: "done('</script>');",
    scripts: true,
  });
  assert(doc.startsWith('<base href="https://example.test/">'));
  assertStringIncludes(doc, "window.ReactNativeWebView=");
  assert(doc.indexOf("window.x = 1;") < doc.indexOf("<p>hi</p>"), "before runs first");
  assert(doc.indexOf("done(") > doc.indexOf("<p>hi</p>"), "after comes last");
  assertStringIncludes(doc, "done('<\\/script>')", "a </script inside cannot end the tag");
  assertEquals(webViewDocument("<p/>", { scripts: false, after: "x" }), "<p/>");
});

Deno.test("WebView: inline HTML loads through srcdoc in an opaque-origin sandbox", async () => {
  const m = mount();
  try {
    m.root.render(h(WebView, { source: { html: "<b>x</b>" }, testID: "wv" }));
    await settle();
    const [frame] = byTag(m.container, "iframe");
    assertStringIncludes(String(attr(frame, "srcdoc")), "<b>x</b>");
    const sandbox = String(attr(frame, "sandbox"));
    assertStringIncludes(sandbox, "allow-scripts");
    assert(!sandbox.includes("allow-same-origin"), "inline HTML never shares the app's origin");
    m.root.render(h(WebView, { source: { html: "<b>x</b>" }, javaScriptEnabled: false }));
    await settle();
    assertEquals(attr(byTag(m.container, "iframe")[0], "sandbox"), "");
  } finally {
    m.done();
  }
});

Deno.test("WebView: a URL loads in the frame; load, navigation and end events fire", async () => {
  const m = mount();
  const events: string[] = [];
  try {
    m.root.render(h(WebView, {
      source: { uri: "https://example.test/page" },
      onLoadStart: (e: Any) => events.push(`start ${e.nativeEvent.loading}`),
      onLoad: (e: Any) => events.push(`load ${e.nativeEvent.url}`),
      onNavigationStateChange: (e: Any) => events.push(`nav ${e.navigationType}`),
      onLoadEnd: () => events.push("end"),
    }));
    await settle();
    const [frame] = byTag(m.container, "iframe");
    assertEquals(attr(frame, "src"), "https://example.test/page");
    assertEquals(frame.getAttribute("sandbox"), null, "a URL is a plain frame");
    frame.dispatch("load");
    assertEquals(events, [
      "start true",
      "load https://example.test/page",
      "nav other",
      "end",
    ]);
  } finally {
    m.done();
  }
});

Deno.test("WebView: messages both ways and injection through the bridge", async () => {
  const m = mount();
  const received: string[] = [];
  const posted: unknown[] = [];
  const ref = { current: null as WebViewHandle | null };
  try {
    m.root.render(h(WebView, {
      ref,
      source: { html: "<p/>" },
      onMessage: (e: Any) => received.push(e.nativeEvent.data),
    }));
    await settle();
    const [frame] = byTag(m.container, "iframe");
    const contentWindow = { postMessage: (d: unknown) => posted.push(d) };
    (frame as Any).contentWindow = contentWindow;
    const send = (data: unknown, source: unknown) => {
      const event = new Event("message");
      Object.defineProperty(event, "data", { value: data });
      Object.defineProperty(event, "source", { value: source });
      g.dispatchEvent(event);
    };
    send({ __denextWebView: true, data: "hello" }, contentWindow);
    send("plain", contentWindow);
    send("from elsewhere", {});
    send({ __denextWebView: "inject", code: "x" }, contentWindow);
    assertEquals(received, ["hello", "plain"]);
    ref.current!.postMessage("to page");
    ref.current!.injectJavaScript("run()");
    assertEquals(posted, ["to page", { __denextWebView: "inject", code: "run()" }]);
  } finally {
    m.done();
  }
});

// ---- PagerView ----------------------------------------------------------------------------

Deno.test("PagerView: pages snap; scrolling reports progress, then the settled page", async () => {
  const m = mount();
  const events: string[] = [];
  const ref = { current: null as PagerViewHandle | null };
  try {
    m.root.render(h(
      PagerView,
      {
        ref,
        style: { flex: 1 },
        onPageScroll: (e: Any) =>
          events.push(`scroll ${e.nativeEvent.position}+${e.nativeEvent.offset}`),
        onPageSelected: (e: Any) => events.push(`selected ${e.nativeEvent.position}`),
        onPageScrollStateChanged: (e: Any) => events.push(`state ${e.nativeEvent.pageScrollState}`),
      },
      h("p", null, "one"),
      h("p", null, "two"),
      h("p", null, "three"),
    ));
    await settle();
    assertEquals(findAll(m.container, "data-denext-page").length, 3);
    const [scroller] = findAll(m.container, "data-denext-pager");
    assertEquals(scroller.style.getPropertyValue("scroll-snap-type"), "x mandatory");
    Object.assign(scroller, { clientWidth: 100, clientHeight: 50, scrollLeft: 150 });
    scroller.dispatch("pointerdown");
    scroller.dispatch("scroll");
    assertEquals(events, ["state dragging", "scroll 1+0.5"]);
    scroller.dispatch("pointerup");
    Object.assign(scroller, { scrollLeft: 200 });
    scroller.dispatch("scroll");
    await settle(150);
    assertEquals(events.slice(2), ["state settling", "scroll 2+0", "selected 2", "state idle"]);
    const calls: unknown[] = [];
    (scroller as Any).scrollTo = (o: unknown) => calls.push(o);
    ref.current!.setPageWithoutAnimation(0);
    assertEquals(calls, [{ left: 0, behavior: "auto" }]);
    assertEquals(events.at(-1), "selected 0", "a jump selects at once");
    ref.current!.setScrollEnabled(false);
    await settle();
    assertEquals(scroller.style.getPropertyValue("overflow-x"), "hidden");
  } finally {
    m.done();
  }
});

Deno.test("PagerView: vertical orientation and a page margin", async () => {
  const m = mount();
  try {
    m.root.render(h(
      PagerView,
      { orientation: "vertical", pageMargin: 8 },
      h("p", null, "a"),
      h("p", null, "b"),
    ));
    await settle();
    const [scroller] = findAll(m.container, "data-denext-pager");
    assertEquals(scroller.style.getPropertyValue("scroll-snap-type"), "y mandatory");
    assertEquals(scroller.style.getPropertyValue("flex-direction"), "column");
    assertEquals(scroller.style.getPropertyValue("gap"), "8px");
  } finally {
    m.done();
  }
});

// ---- Drawer -------------------------------------------------------------------------------

Deno.test("getDrawerStatusFromState: the last drawer history entry, else the default", () => {
  assertEquals(
    getDrawerStatusFromState({
      key: "d",
      index: 0,
      routes: [],
      history: [{ type: "route" }, { type: "drawer", status: "open" }],
    }),
    "open",
  );
  assertEquals(getDrawerStatusFromState({ key: "d", index: 0, routes: [], history: [] }), "closed");
  assertEquals(
    getDrawerStatusFromState({ key: "d", index: 0, routes: [], history: [], default: "open" }),
    "open",
  );
});

/** A React Navigation core faked just enough for the drawer navigator. */
function fakeCore(state: Any, options: Record<string, Record<string, unknown>>) {
  const dispatched: Any[] = [];
  const emitted: Any[] = [];
  const core: DrawerNavigationCore = {
    createNavigatorFactory: (Navigator) => () => ({ Navigator }),
    useNavigationBuilder: () => ({
      state,
      descriptors: Object.fromEntries(state.routes.map((r: Any) => [r.key, {
        options: options[r.key] ?? {},
        render: () => h("p", null, `screen ${r.name}`),
      }])),
      navigation: {
        dispatch: (a: object) => void dispatched.push(a),
        emit: (e: unknown) => (emitted.push(e), { defaultPrevented: false }),
      },
      render: (children) => children,
    }),
    DrawerRouter: {},
  };
  return { core, dispatched, emitted };
}

Deno.test("createDrawerNavigator: open drawer, items, overlay, toggle and Escape", async () => {
  const state = {
    key: "drawer-1",
    index: 0,
    routes: [{ key: "r0", name: "home" }, { key: "r1", name: "settings" }],
    history: [{ type: "route" }, { type: "drawer", status: "open" }],
  };
  const { core, dispatched, emitted } = fakeCore(state, {
    r0: { title: "Home" },
    r1: { drawerLabel: "Settings" },
  });
  const m = mount();
  try {
    const { createDrawerNavigator } = drawerNavigatorExports(core);
    const { Navigator } = (createDrawerNavigator as Any)();
    m.root.render(h(Navigator, {}));
    await settle();
    const [panel] = findAll(m.container, "data-denext-drawer");
    assertEquals(panel.getAttribute("data-denext-drawer"), "open");
    assertEquals(panel.getAttribute("inert"), null);
    assertStringIncludes(m.container.textContent, "screen home");
    assert(
      !m.container.textContent.includes("screen settings"),
      "unvisited screens are not mounted",
    );
    assertStringIncludes(findAll(m.container, "data-denext-drawer-header")[0].textContent, "Home");

    const items = findAll(m.container, "data-denext-drawer-item");
    assertEquals(items.map((i) => i.textContent), ["Home", "Settings"]);
    items[1].dispatch("click");
    assertEquals(emitted.at(-1).type, "drawerItemPress");
    assertEquals(dispatched.at(-1), {
      type: "NAVIGATE",
      payload: { name: "settings", params: undefined },
      target: "drawer-1",
    });
    items[0].dispatch("click");
    assertEquals(dispatched.at(-1), { type: "CLOSE_DRAWER", target: "drawer-1" });

    findAll(m.container, "data-denext-drawer-overlay")[0].dispatch("click");
    assertEquals(dispatched.at(-1), { type: "CLOSE_DRAWER", target: "drawer-1" });
    findAll(m.container, "data-denext-drawer-toggle")[0].dispatch("click");
    assertEquals(dispatched.at(-1), { type: "TOGGLE_DRAWER", target: "drawer-1" });
    m.doc.dispatch("keydown", { key: "Escape" });
    assertEquals(dispatched.at(-1), { type: "CLOSE_DRAWER", target: "drawer-1" });
    assertEquals(dispatched.length, 5);
  } finally {
    m.done();
  }
});

Deno.test("createDrawerNavigator: a closed drawer is inert; the core's own actions are used", async () => {
  const state = {
    key: "drawer-2",
    index: 0,
    routes: [{ key: "r0", name: "home" }],
    history: [{ type: "route" }],
  };
  const { core, dispatched } = fakeCore(state, { r0: { headerShown: false } });
  (core as Any).DrawerActions = {
    openDrawer: () => ({ type: "CORE_OPEN" }),
    closeDrawer: () => ({ type: "CORE_CLOSE" }),
    toggleDrawer: () => ({ type: "CORE_TOGGLE" }),
  };
  const m = mount();
  try {
    const { Navigator } = (drawerNavigatorExports(core).createDrawerNavigator as Any)();
    m.root.render(h(Navigator, {}));
    await settle();
    const [panel] = findAll(m.container, "data-denext-drawer");
    assertEquals(panel.getAttribute("data-denext-drawer"), "closed");
    assertEquals(panel.getAttribute("aria-hidden"), "true");
    assert(panel.getAttribute("inert") !== null, "a closed panel is inert");
    assertEquals(findAll(m.container, "data-denext-drawer-header").length, 0, "headerShown: false");
    m.doc.dispatch("keydown", { key: "Escape" });
    assertEquals(dispatched.length, 0, "Escape does nothing while closed");
    findAll(m.container, "data-denext-drawer-item")[0].dispatch("click");
    assertEquals(dispatched.at(-1), { type: "CORE_CLOSE", target: "drawer-2" });
  } finally {
    m.done();
  }
});

Deno.test("Drawer: an edge swipe opens it; progress follows the finger", async () => {
  const m = mount();
  const calls: string[] = [];
  const seen: number[] = [];
  function Probe() {
    seen.push(useDrawerProgress().value);
    return h("span", null, "probe");
  }
  try {
    m.root.render(h(Drawer, {
      open: false,
      onOpen: () => calls.push("open"),
      onClose: () => calls.push("close"),
      onGestureStart: () => calls.push("gesture-start"),
      onGestureEnd: () => calls.push("gesture-end"),
      renderDrawerContent: () => "menu",
    }, h(Probe, null)));
    await settle();
    const [layout] = findAll(m.container, "data-denext-drawer-layout");
    const at = (clientX: number) => ({ clientX, clientY: 10, pointerId: 1, currentTarget: layout });
    layout.dispatch("pointerdown", at(200));
    layout.dispatch("pointermove", at(260));
    await settle();
    assertEquals(calls, [], "a touch away from the edge is not a swipe");
    layout.dispatch("pointerdown", at(4));
    layout.dispatch("pointermove", at(144));
    await settle();
    assertEquals(seen.at(-1), 0.5, "halfway across a 280 px panel");
    layout.dispatch("pointermove", at(200));
    layout.dispatch("pointerup", at(200));
    await settle();
    assertEquals(calls, ["gesture-start", "gesture-end", "open"]);
    assertEquals(seen.at(-1), 0, "back to the open prop's value once released");
  } finally {
    m.done();
  }
});
