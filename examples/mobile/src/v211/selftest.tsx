// The automatic self-test: every check that needs no human and shows no OS prompt, one after
// another, each logged as `SELFTEST|<name>|PASS|<detail>` (or FAIL / SKIP), then
// `SELFTEST|DONE|<passed>/<total>` (SKIPs are not counted). Reached at /selftest: the deep link
// denextmobile://selftest, `?selftest` at boot, or the button on the home screen.
//
// Never call anything here that can show a system prompt: permissions are only CHECKED,
// geolocation runs only when location is already granted, no biometric auth, no review sheet.
import { useEffect, useRef, useState, type VirtualListHandle, type VNode } from "denext";
import {
  cancelNotification,
  checkPermission,
  deviceInfo,
  getCurrentPosition,
  getOrientation,
  getTrackingStatus,
  isBiometricAvailable,
  isNativeShell,
  lockOrientation,
  networkStatus,
  otaInstallId,
  otaStatus,
  pendingNotifications,
  type PermissionName,
  runtimePlatform,
  type SafeAreaInsets,
  scheduleNotification,
  setPrivacyScreen,
  setSystemBars,
  unlockOrientation,
  useKeyboard,
  useSafeAreaInsets,
} from "denext/mobile";
import { threeButton } from "./dialogs.tsx";
import { ChatList, KeyboardScreen, makeMessages } from "./keyboard.tsx";
import { BigList, JUMP_TO, ListsScreen, ROW_PX, StickyList } from "./lists.tsx";
import { type NavControl, NavigationScreen, NavStack, NavTabs, SheetDemo } from "./navigation.tsx";
import { SafeAreaScreen } from "./system.tsx";
import { RefreshList } from "./refresh.tsx";
import { frames, Screen, sleep } from "./shell.tsx";

type Verdict = "PASS" | "FAIL" | "SKIP";
class Skip extends Error {}

/** A check returns its PASS detail, throws for FAIL, or throws `Skip` for SKIP. */
type Check = { name: string; run: (t: Tools) => Promise<string> };

interface Tools {
  /**
   * Render `node` into the stage (a 100% × 70vh box, or the whole viewport with `full`, for
   * screens whose layout against the screen edges is under test) and wait for it to draw.
   */
  mount(node: VNode | null, full?: boolean): Promise<HTMLElement>;
}

function assert(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(detail);
}

async function until<T>(
  get: () => T | null | undefined | false,
  ms = 4000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(50);
  }
}

/** Wait until `get()` returns the same value for `quiet` ms (a scroll settled). */
async function settle(
  get: () => number,
  quiet = 300,
  ms = 5000,
): Promise<number> {
  const end = Date.now() + ms;
  let last = get();
  let since = Date.now();
  while (Date.now() < end) {
    await sleep(50);
    const v = get();
    if (Math.abs(v - last) > 0.5) {
      last = v;
      since = Date.now();
    } else if (Date.now() - since >= quiet) return v;
  }
  return last;
}

/** The element under `root` that scrolls vertically (a list's scroller). */
function scrollerIn(root: Element): HTMLElement {
  const all = [root, ...root.querySelectorAll("*")] as HTMLElement[];
  const el = all.find((e) =>
    e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)
  );
  if (!el) throw new Error("no scrolling element");
  return el;
}

/** Whether the row under viewport point (x, y) is missing (blank list area). */
function blankAt(scroller: Element, x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  return !el || el === scroller || !scroller.contains(el);
}

/** Whether the list's viewport is covered by rows at `n` sample points (no blank area). */
function covered(scroller: Element, n = 5): string | null {
  const r = scroller.getBoundingClientRect();
  const ys = Array.from({ length: n }, (_, i) => r.top + 4 + ((r.height - 8) * i) / (n - 1));
  const y = ys.find((y) => blankAt(scroller, r.left + r.width / 2, y));
  return y === undefined ? null : `blank at y=${Math.round(y - r.top)}`;
}

function Probe<T>({ use, report }: { use: () => T; report: (v: T) => void }) {
  const v = use();
  useEffect(() => report(v));
  return <pre class="out">{JSON.stringify(v)}</pre>;
}

/** Mount a probe of hook `use` and resolve its value once it has been stable for 500 ms. */
async function readHook<T>(t: Tools, use: () => T): Promise<T> {
  let latest: { v: T } | undefined;
  let changed = 0;
  await t.mount(
    <Probe
      use={use}
      report={(v) => {
        if (!latest || JSON.stringify(latest.v) !== JSON.stringify(v)) {
          changed = Date.now();
        }
        latest = { v };
      }}
    />,
  );
  await until(() => latest && Date.now() - changed >= 500);
  return latest!.v;
}

const handleOf = (ref: { current: VirtualListHandle | null }) =>
  until(() => ref.current && ref.current.getScrollableNode() ? ref.current : null);

const PERMISSIONS: PermissionName[] = [
  "camera",
  "photos",
  "location",
  "notifications",
  "microphone",
  "biometrics",
  "contacts",
  "calendar",
  "location-background",
];

const CHECKS: Check[] = [
  {
    name: "platform",
    run: () => {
      const p = runtimePlatform();
      assert(
        isNativeShell() && p === "ios",
        `runtimePlatform() = ${p}, native ${isNativeShell()}`,
      );
      return Promise.resolve(p);
    },
  },
  {
    name: "deviceInfo",
    run: async () => {
      const d = await deviceInfo();
      assert(d.platform === "ios", `platform ${d.platform}`);
      return JSON.stringify(d).slice(0, 160);
    },
  },
  {
    name: "networkStatus",
    run: async () => {
      const n = await networkStatus();
      assert(typeof n.connected === "boolean", JSON.stringify(n));
      return JSON.stringify(n);
    },
  },
  {
    name: "safeArea.insets",
    run: async (t) => {
      const i = await readHook<SafeAreaInsets>(t, useSafeAreaInsets);
      assert(i.top >= 40, `top ${i.top} < 40: ${JSON.stringify(i)}`);
      return JSON.stringify(i);
    },
  },
  {
    name: "systemBars.set",
    run: async () => {
      await setSystemBars({ style: "dark" });
      await setSystemBars({ style: "light" });
      await setSystemBars({ hidden: true, animation: "none" });
      await setSystemBars({ hidden: false, animation: "none" });
      await setSystemBars({ style: "auto" });
      return "dark, light, hidden, shown, auto all resolved";
    },
  },
  {
    name: "keyboard.initial",
    run: async (t) => {
      const k = await readHook(t, useKeyboard);
      assert(k.visible === false && k.height === 0, JSON.stringify(k));
      return JSON.stringify(k);
    },
  },
  {
    name: "virtualList.100k.scrollToIndex",
    run: async (t) => {
      const ref = { current: null as VirtualListHandle | null };
      const stage = await t.mount(<BigList listRef={ref} />);
      const h = await handleOf(ref);
      h.scrollToIndex(JUMP_TO, { align: "start" });
      const scroller = h.getScrollableNode() as HTMLElement;
      await settle(() => scroller.scrollTop, 400);
      await frames(3);
      const row = await until(() => stage.querySelector(`[data-row="${JUMP_TO}"]`));
      const err = row.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      const off = h.getScrollOffset();
      assert(
        Math.abs(err) <= 1,
        `row ${JUMP_TO} is ${err.toFixed(2)} px from the top edge`,
      );
      assert(
        Math.abs(off - JUMP_TO * ROW_PX) <= 1,
        `offset ${off} ≠ ${JUMP_TO * ROW_PX}`,
      );
      return `edge error ${err.toFixed(2)} px, offset ${off}`;
    },
  },
  {
    name: "virtualList.100k.fling",
    run: async (t) => {
      const ref = { current: null as VirtualListHandle | null };
      await t.mount(<BigList listRef={ref} />);
      const h = await handleOf(ref);
      const scroller = h.getScrollableNode() as HTMLElement;
      // A fling-like programmatic scroll: 60 frames decelerating from 400 px/frame.
      let v = 400;
      let blanks = 0;
      let firstBlank = "";
      for (let i = 0; i < 60; i++) {
        scroller.scrollTop += v;
        v *= 0.95;
        await frames(1);
        const b = covered(scroller);
        if (b) {
          blanks++;
          firstBlank ||= `frame ${i}: ${b}`;
        }
      }
      const top = await settle(() => scroller.scrollTop, 300);
      await frames(2);
      const after = covered(scroller);
      assert(!after, `after settle: ${after}`);
      // During the fling a frame may paint before rows mount; report it, fail only if often.
      assert(blanks <= 3, `${blanks}/60 frames had blank area (${firstBlank})`);
      return `scrolled to ${Math.round(top)} px, ${blanks}/60 frames with blank area`;
    },
  },
  {
    name: "virtualList.chat.anchorEnd",
    run: async (t) => {
      const ref = { current: null as VirtualListHandle | null };
      const msgs = makeMessages(2000);
      await t.mount(<ChatList messages={msgs} listRef={ref} />);
      const h = await handleOf(ref);
      const scroller = h.getScrollableNode() as HTMLElement;
      await settle(() => scroller.scrollTop, 300);
      assert(
        h.isAtEnd(),
        `not at end on mount (offset ${h.getScrollOffset()})`,
      );
      h.scrollToOffset(0);
      await settle(() => scroller.scrollTop, 300);
      assert(
        scroller.scrollTop < 2,
        `scrollToOffset(0) left scrollTop ${scroller.scrollTop}`,
      );
      const blank = covered(scroller);
      assert(!blank, `at top: ${blank}`);
      h.scrollToEnd();
      await settle(() => scroller.scrollTop, 400);
      await frames(2);
      assert(
        h.isAtEnd(),
        `scrollToEnd did not reach the end (offset ${h.getScrollOffset()})`,
      );
      return `at end on mount; top covered; scrollToEnd reached ${
        Math.round(scroller.scrollTop)
      } px`;
    },
  },
  {
    name: "virtualList.sticky",
    run: async (t) => {
      const ref = { current: null as VirtualListHandle | null };
      const stage = await t.mount(<StickyList listRef={ref} />);
      const h = await handleOf(ref);
      const scroller = h.getScrollableNode() as HTMLElement;
      // Section C starts at index 62 (A: 0–30, B: 31–61); land 5 rows into it.
      h.scrollToIndex(67, { align: "start" });
      await settle(() => scroller.scrollTop, 400);
      await frames(3);
      const head = await until(() =>
        stage.querySelector<HTMLElement>('[data-sticky-head="Section C"]')
      );
      const err = head.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      assert(
        Math.abs(err) <= 1,
        `Section C header is ${err.toFixed(1)} px from the top`,
      );
      return `Section C stuck at the top (error ${err.toFixed(2)} px)`;
    },
  },
  {
    name: "stackView.pushPopKeepsState",
    run: async (t) => {
      const ctl: NavControl = {};
      const stage = await t.mount(<NavStack ctl={ctl} />);
      const body = () =>
        stage.querySelector<HTMLElement>(
          '[data-dnx-screen="level-1"] [data-dnx-screen-body]',
        );
      const b1 = await until(body);
      (stage.querySelector('[data-level="1"] button') as HTMLButtonElement)
        .click();
      (stage.querySelector('[data-level="1"] button') as HTMLButtonElement)
        .click();
      b1.scrollTop = 400;
      await frames(3);
      assert(
        b1.scrollTop > 390,
        `could not scroll level 1 (scrollTop ${b1.scrollTop})`,
      );
      ctl.push!();
      await sleep(700);
      const top2 = stage.querySelector('[data-dnx-screen="level-2"]');
      assert(
        top2?.getAttribute("data-dnx-screen-state") === "top",
        "level 2 is not on top",
      );
      ctl.pop!();
      await sleep(700);
      await frames(2);
      const count = stage.querySelector('[data-level-count="1"]')?.textContent;
      const st = body()?.scrollTop ?? -1;
      assert(count === "2", `level 1 counter ${count}, expected 2`);
      assert(Math.abs(st - 400) <= 1, `level 1 scrollTop ${st}, expected 400`);
      return `counter 2 and scrollTop ${st} kept across push/pop`;
    },
  },
  {
    name: "tabsView.keepsScroll",
    run: async (t) => {
      let set: (n: string) => void = () => {};
      function Harness() {
        const [active, setActive] = useState("inbox");
        set = setActive;
        return <NavTabs active={active} />;
      }
      const stage = await t.mount(<Harness />);
      const panel = () => stage.querySelector<HTMLElement>('[data-dnx-tabpanel="inbox"]');
      const p = await until(panel);
      p.scrollTop = 600;
      await sleep(150);
      set("feed");
      await sleep(200);
      assert(
        stage.querySelector('[data-dnx-tabpanel="feed"]'),
        "feed panel missing",
      );
      set("inbox");
      await sleep(200);
      await frames(2);
      const st = panel()?.scrollTop ?? -1;
      assert(
        Math.abs(st - 600) <= 1,
        `inbox scrollTop ${st} after switching back, expected 600`,
      );
      return `inbox scrollTop ${st} kept across a tab switch`;
    },
  },
  {
    name: "sheet.detents",
    run: async (t) => {
      let open: (o: boolean) => void = () => {};
      function Harness() {
        const [o, setO] = useState(false);
        open = setO;
        return <SheetDemo open={o} setOpen={setO} />;
      }
      await t.mount(<Harness />);
      open(true);
      const panel = await until(() =>
        document.querySelector<HTMLElement>("[data-dnx-sheet-panel]")
      );
      await sleep(600);
      // The panel is always the large height, slid down by translateY to the detent: what
      // shows is the part above the viewport's bottom edge.
      const ratio = () => (innerHeight - panel.getBoundingClientRect().top) / innerHeight;
      const medium = ratio();
      assert(
        medium > 0.35 && medium < 0.65,
        `medium height ratio ${medium.toFixed(2)}`,
      );
      (document.querySelector("[data-dnx-sheet-grabber]") as HTMLElement)
        .click();
      await sleep(600);
      const large = ratio();
      assert(large > 0.8, `large height ratio ${large.toFixed(2)}`);
      open(false);
      await sleep(600);
      return `medium ${medium.toFixed(2)}, large ${large.toFixed(2)} of the viewport`;
    },
  },
  {
    name: "layout.lists.headerAboveList",
    run: async (t) => {
      const stage = await t.mount(<ListsScreen />, true);
      const header = await until(() => stage.querySelector('[data-selftest="lists-header"]'));
      const body = await until(() => stage.querySelector('[data-selftest="lists-body"]'));
      const hb = header.getBoundingClientRect().bottom;
      const bt = body.getBoundingClientRect().top;
      assert(bt >= hb - 0.5, `list top ${bt.toFixed(1)} < header bottom ${hb.toFixed(1)}`);
      const jump = [...header.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Jump")
      );
      assert(jump, "no Jump button");
      assert(
        jump.getBoundingClientRect().top < hb && header.scrollHeight <= header.clientHeight + 1,
        "the header row wraps",
      );
      jump.click();
      const row = await until(() => stage.querySelector<HTMLElement>(`[data-row="${JUMP_TO}"]`));
      const scroller = scrollerIn(body);
      await settle(() => scroller.scrollTop, 400);
      await frames(2);
      const rt = row.getBoundingClientRect().top;
      assert(
        Math.abs(rt - bt) <= 1,
        `row ${JUMP_TO} top ${rt.toFixed(1)} ≠ list top ${bt.toFixed(1)}`,
      );
      return `header bottom ${hb.toFixed(1)} ≤ list top ${
        bt.toFixed(1)
      }; row ${JUMP_TO} at the list top`;
    },
  },
  {
    name: "layout.lists.lastRowAboveHomeIndicator",
    run: async (t) => {
      const inset = await readHook<SafeAreaInsets>(t, useSafeAreaInsets);
      const stage = await t.mount(<ListsScreen />, true);
      const body = await until(() => stage.querySelector('[data-selftest="lists-body"]'));
      const scroller = scrollerIn(body);
      scroller.scrollTop = scroller.scrollHeight;
      await settle(() => scroller.scrollTop, 400);
      scroller.scrollTop = scroller.scrollHeight;
      await settle(() => scroller.scrollTop, 400);
      const last = await until(() => stage.querySelector<HTMLElement>('[data-row="99999"]'));
      const bottom = last.getBoundingClientRect().bottom;
      const limit = innerHeight - inset.bottom;
      assert(
        bottom <= limit + 1,
        `last row bottom ${bottom.toFixed(1)} > ${limit} (viewport − inset)`,
      );
      return `last row bottom ${
        bottom.toFixed(1)
      } ≤ ${limit} (viewport ${innerHeight} − inset ${inset.bottom})`;
    },
  },
  {
    name: "layout.safeArea.bottomBar",
    run: async (t) => {
      const inset = await readHook<SafeAreaInsets>(t, useSafeAreaInsets);
      assert(inset.bottom > 0, `bottom inset ${inset.bottom} (expected > 0 on a Face ID iPhone)`);
      const stage = await t.mount(<SafeAreaScreen />, true);
      const bar = await until(() => stage.querySelector('[data-selftest="bottom-bar"]'));
      const content = await until(() =>
        stage.querySelector('[data-selftest="bottom-bar-content"]')
      );
      const barBottom = bar.getBoundingClientRect().bottom;
      const bottom = content.getBoundingClientRect().bottom;
      const limit = innerHeight - inset.bottom;
      assert(
        Math.abs(barBottom - innerHeight) <= 1,
        `bar bottom ${barBottom} ≠ viewport ${innerHeight}`,
      );
      assert(bottom <= limit + 1, `bar content bottom ${bottom.toFixed(1)} > ${limit}`);
      return `inset ${inset.bottom}; bar content bottom ${bottom.toFixed(1)} ≤ ${limit}`;
    },
  },
  {
    name: "layout.chat.composerAboveHomeIndicator",
    run: async (t) => {
      const inset = await readHook<SafeAreaInsets>(t, useSafeAreaInsets);
      const stage = await t.mount(<KeyboardScreen />, true);
      const readout = await until(() => stage.querySelector('[data-selftest="kb-readout"]'));
      const body = await until(() => stage.querySelector('[data-selftest="chat-body"]'));
      const input = await until(() => stage.querySelector('[data-selftest="composer"] input'));
      const rb = readout.getBoundingClientRect().bottom;
      const bt = body.getBoundingClientRect().top;
      const ib = input.getBoundingClientRect().bottom;
      const limit = innerHeight - inset.bottom;
      assert(bt >= rb - 0.5, `chat list top ${bt.toFixed(1)} < readout bottom ${rb.toFixed(1)}`);
      assert(ib <= limit + 1, `composer input bottom ${ib.toFixed(1)} > ${limit}`);
      return `list starts below the readout; composer input bottom ${ib.toFixed(1)} ≤ ${limit}`;
    },
  },
  {
    name: "layout.stack.lastLineAboveHomeIndicator",
    run: async (t) => {
      const inset = await readHook<SafeAreaInsets>(t, useSafeAreaInsets);
      const stage = await t.mount(<NavigationScreen />, true);
      const header = await until(() => stage.querySelector('[data-selftest="nav-header"]'));
      const body = await until(() =>
        stage.querySelector<HTMLElement>('[data-dnx-screen="level-1"] [data-dnx-screen-body]')
      );
      body.scrollTop = body.scrollHeight;
      await settle(() => body.scrollTop, 300);
      const rows = body.querySelectorAll(".list-row");
      const bottom = rows[rows.length - 1].getBoundingClientRect().bottom;
      const limit = innerHeight - inset.bottom;
      const top = stage.querySelector('[data-selftest="nav-body"]')!.getBoundingClientRect().top;
      assert(top >= header.getBoundingClientRect().bottom - 0.5, "the stack overlaps the header");
      assert(bottom <= limit + 1, `last line bottom ${bottom.toFixed(1)} > ${limit}`);
      return `stack below its header; last line bottom ${bottom.toFixed(1)} ≤ ${limit}`;
    },
  },
  {
    name: "pullToRefresh.gesture",
    run: async (t) => {
      let resolve: (n: number) => void = () => {};
      const refreshed = new Promise<number>((r) => (resolve = r));
      const stage = await t.mount(
        <RefreshList onRefreshed={(n) => resolve(n)} />,
      );
      const el = await until(() => stage.querySelector<HTMLElement>('[data-selftest="refresh"]'));
      const touch = (type: string, y: number) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, "touches", {
          value: type === "touchend" ? [] : [{ clientX: 150, clientY: y }],
        });
        el.dispatchEvent(e);
      };
      touch("touchstart", 100);
      for (let y = 110; y <= 400; y += 20) {
        touch("touchmove", y);
        await frames(1);
      }
      touch("touchend", 400);
      const n = await Promise.race([refreshed, sleep(4000).then(() => -1)]);
      assert(n === 1, "onRefresh did not fire within 4 s");
      return "a synthetic pull fired onRefresh; count 1";
    },
  },
  {
    name: "dialog.inPage3Button",
    run: async () => {
      const result = threeButton();
      const card = await until(() => document.querySelector<HTMLElement>('[role="alertdialog"]'));
      const buttons = [...card.querySelectorAll("button")];
      assert(buttons.length === 3, `${buttons.length} buttons`);
      buttons[2].click();
      const r = await result;
      await sleep(100);
      assert(r.index === 2, `index ${r.index}`);
      assert(
        !document.querySelector('[role="alertdialog"]'),
        "dialog still in the DOM",
      );
      return `3 buttons (${
        buttons.map((b) => b.textContent).join(" / ")
      }), pressed index 2, closed`;
    },
  },
  ...PERMISSIONS.map((name): Check => ({
    name: `permission.check.${name}`,
    run: async () => {
      try {
        return await checkPermission(name);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "unsupported") {
          throw new Skip(`unsupported (no plugin for ${name})`);
        }
        throw err;
      }
    },
  })),
  {
    name: "tracking.status",
    run: async () => {
      const s = await getTrackingStatus();
      assert(typeof s === "string", String(s));
      return s;
    },
  },
  {
    name: "localNotification.scheduleCancel",
    run: async () => {
      const id = await scheduleNotification({
        title: "self-test",
        body: "cancelled before it fires",
        trigger: { type: "date", date: Date.now() + 60_000 },
      });
      const pending = await pendingNotifications();
      const found = pending.some((n) => n.id === id);
      await cancelNotification(id);
      const after = await pendingNotifications();
      assert(found, `id ${id} not in pending (${pending.length} pending)`);
      assert(
        !after.some((n) => n.id === id),
        `id ${id} still pending after cancel`,
      );
      return `id ${id} scheduled, pending, cancelled`;
    },
  },
  {
    name: "geolocation.current",
    run: async () => {
      const p = await checkPermission("location");
      if (p !== "granted" && p !== "limited") {
        throw new Skip(`location is ${p}; not prompting`);
      }
      const pos = await getCurrentPosition({ timeoutMs: 15000 });
      return `${pos.latitude.toFixed(3)}, ${pos.longitude.toFixed(3)} ±${
        Math.round(pos.accuracy)
      } m`;
    },
  },
  {
    name: "orientation.lockPortrait",
    run: async () => {
      await lockOrientation("portrait");
      await sleep(300);
      const o = await getOrientation();
      await unlockOrientation();
      assert(o.startsWith("portrait"), `orientation ${o}`);
      return `locked → ${o}, unlocked`;
    },
  },
  {
    name: "privacyScreen.toggle",
    run: async () => {
      await setPrivacyScreen(true);
      await setPrivacyScreen(false);
      return "on, off resolved";
    },
  },
  {
    name: "biometrics.available",
    run: async () => {
      const b = await isBiometricAvailable();
      assert(b.type !== undefined || b.reason !== undefined, JSON.stringify(b));
      return JSON.stringify(b);
    },
  },
  {
    name: "ota.status",
    run: async () => {
      const s = await otaStatus();
      assert(
        s !== null,
        "otaStatus() is null: the DenextOta plugin is missing",
      );
      const id = otaInstallId();
      return `${JSON.stringify(s).slice(0, 140)} installId ${id.slice(0, 8)}…`;
    },
  },
];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`timed out after ${ms} ms`);
    }),
  ]);
}

/** An error as the detail of a FAIL / SKIP line (with its `code`, when it has one). */
function errorDetail(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  const message = (err as Error)?.message ?? String(err);
  return code ? `[${code}] ${message}` : message;
}

/** Run one check: its verdict and detail. */
async function runCheck(check: Check, tools: Tools): Promise<[Verdict, string]> {
  try {
    return ["PASS", await withTimeout(check.run(tools), 20_000)];
  } catch (err) {
    return [err instanceof Skip ? "SKIP" : "FAIL", errorDetail(err)];
  }
}

const BOX_STAGE = {
  position: "relative",
  height: "70vh",
  overflow: "hidden",
  border: "1px dashed color-mix(in srgb, CanvasText 30%, transparent)",
};
const FULL_STAGE = {
  position: "fixed",
  inset: "0px",
  zIndex: 1000,
  overflow: "hidden",
  background: "Canvas",
};

export function SelfTestScreen() {
  const [stage, setStage] = useState<{ node: VNode | null; full: boolean }>({
    node: null,
    full: false,
  });
  const [lines, setLines] = useState<string[]>([]);
  const stageEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const log = (line: string) => {
      console.log(line);
      setLines((prev) => [...prev, line]);
    };
    const tools: Tools = {
      async mount(node, full = false) {
        setStage({ node: null, full: false });
        await frames(2);
        setStage({ node, full });
        await frames(3);
        await sleep(100);
        return stageEl.current!;
      },
    };
    (async () => {
      await sleep(500);
      log(`SELFTEST|START|${CHECKS.length} checks|${new Date().toISOString()}`);
      const verdicts: Verdict[] = [];
      for (const check of CHECKS) {
        if (cancelled) return;
        const [verdict, detail] = await runCheck(check, tools);
        verdicts.push(verdict);
        log(`SELFTEST|${check.name}|${verdict}|${detail.replace(/\s+/g, " ")}`);
        await tools.mount(null);
      }
      const passed = verdicts.filter((v) => v === "PASS").length;
      const total = verdicts.filter((v) => v !== "SKIP").length;
      log(`SELFTEST|DONE|${passed}/${total}`);
    })();
    return () => void (cancelled = true);
  }, []);
  return (
    <Screen
      title="Self-test"
      todo="Runs by itself: no OS prompts. Each line is also logged to the console as SELFTEST|name|PASS/FAIL/SKIP|detail."
    >
      <div
        ref={stageEl}
        style={stage.full ? FULL_STAGE : BOX_STAGE}
      >
        {stage.node}
      </div>
      <pre class="out" data-selftest-log="">{lines.join("\n")}</pre>
    </Screen>
  );
}
