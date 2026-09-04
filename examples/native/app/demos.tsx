// The hook showcase: a grid of small cards, each exercising real denext hooks
// (labeled on the card). Everything here is client-interactive and SSR-safe — the
// page server-renders, then hydrates, so it runs identically on web, desktop
// (`deno desktop`), and mobile (Capacitor).
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "denext";
import type { Ref } from "denext";
import type { CatHandle } from "./cat.tsx";

// ── Accent theme: context + reducer + runtime CSS injection ──────────────────
interface AccentState {
  accent: string;
  history: string[];
}
type AccentAction = { type: "set"; color: string };
interface AccentApi extends AccentState {
  setAccent: (color: string) => void;
}
const AccentContext = createContext<AccentApi>({
  accent: "#38bdf8",
  history: [],
  setAccent: () => {},
});

function accentReducer(state: AccentState, action: AccentAction): AccentState {
  switch (action.type) {
    case "set":
      return {
        accent: action.color,
        history: [
          action.color,
          ...state.history.filter((c) => c !== action.color),
        ].slice(0, 6),
      };
  }
}

/** Provides the accent color and, via useInsertionEffect, injects it as the
 *  `--accent` CSS variable at runtime — recoloring the whole UI live. */
export function AccentProvider({ children }: { children: unknown }) {
  const [state, dispatch] = useReducer(accentReducer, {
    accent: "#38bdf8",
    history: ["#38bdf8"],
  });
  // useInsertionEffect runs before layout — the same hook CSS-in-JS libraries use
  // to inject styles. On the server it's a no-op (styles.css supplies the default).
  useInsertionEffect(() => {
    let el = document.getElementById("accent-vars") as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "accent-vars";
      document.head.appendChild(el);
    }
    el.textContent = `:root{--accent:${state.accent}}`;
  }, [state.accent]);
  const api = useMemo<AccentApi>(
    () => ({
      ...state,
      setAccent: (color) => dispatch({ type: "set", color }),
    }),
    [state],
  );
  return <AccentContext.Provider value={api}>{children}</AccentContext.Provider>;
}

// ── Custom hooks (composition + useDebugValue) ───────────────────────────────
function useOnlineStatus(): boolean {
  const online = useSyncExternalStore(
    (cb) => {
      globalThis.addEventListener("online", cb);
      globalThis.addEventListener("offline", cb);
      return () => {
        globalThis.removeEventListener("online", cb);
        globalThis.removeEventListener("offline", cb);
      };
    },
    () => globalThis.navigator?.onLine ?? true,
    () => true, // server snapshot
  );
  useDebugValue(online ? "online" : "offline");
  return online;
}

function useViewport(): string {
  return useSyncExternalStore(
    (cb) => {
      globalThis.addEventListener("resize", cb);
      return () => globalThis.removeEventListener("resize", cb);
    },
    () => `${globalThis.innerWidth ?? 0} × ${globalThis.innerHeight ?? 0}`,
    () => "— × —",
  );
}

function Hooks({ names }: { names: string[] }) {
  return (
    <div class="hooks">
      {names.map((n) => <span key={n}>{n}</span>)}
    </div>
  );
}

// ── Card 1: useReducer + useCallback ─────────────────────────────────────────
type CountAction = { type: "inc" } | { type: "dec" } | { type: "reset" };
function counterReducer(n: number, a: CountAction): number {
  if (a.type === "inc") return n + 1;
  if (a.type === "dec") return n - 1;
  return 0;
}
function ReducerCounter() {
  const [n, dispatch] = useReducer(counterReducer, 0);
  const inc = useCallback(() => dispatch({ type: "inc" }), []);
  const dec = useCallback(() => dispatch({ type: "dec" }), []);
  return (
    <div class="card" style="--i:0">
      <h2>Reducer counter</h2>
      <p class="sub">Dispatch actions to a pure reducer.</p>
      <Hooks names={["useReducer", "useCallback"]} />
      <div class="readout">{n}</div>
      <div class="row-controls" style="margin-top:.6rem">
        <button type="button" onClick={dec}>−</button>
        <button type="button" onClick={inc}>+</button>
        <button
          type="button"
          class="ghost"
          onClick={() => dispatch({ type: "reset" })}
        >
          reset
        </button>
      </div>
    </div>
  );
}

// ── Card 2: the big list — useTransition + useDeferredValue + memo ───────────
const ADJ = [
  "Swift",
  "Fuzzy",
  "Brave",
  "Sleepy",
  "Clever",
  "Tiny",
  "Grumpy",
  "Sunny",
  "Wild",
  "Cozy",
  "Nimble",
  "Jolly",
  "Silent",
  "Amber",
  "Lucky",
  "Bold",
];
const NOUN = [
  "Cat",
  "Comet",
  "Pixel",
  "Maple",
  "River",
  "Ember",
  "Willow",
  "Nimbus",
  "Pebble",
  "Cinder",
  "Marble",
  "Sprocket",
  "Biscuit",
  "Juniper",
  "Onyx",
  "Fable",
];
interface Item {
  id: number;
  name: string;
  hue: number;
}
// Deterministic (index-seeded) so SSR and the client build the SAME list — no
// hydration mismatch. `seed` changes only client-side (the Shuffle button).
function makeItems(n: number, seed: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const a = ADJ[(i * 7 + seed) % ADJ.length];
    const nn = NOUN[(i * 13 + seed * 3) % NOUN.length];
    out.push({
      id: i,
      name: `${a} ${nn} #${i}`,
      hue: (i * 57 + seed * 40) % 360,
    });
  }
  return out;
}

const Row = memo(function Row({ item }: { item: Item }) {
  return (
    <div class="item">
      <span class="swatch" style={`background:hsl(${item.hue} 70% 55%)`} />
      {item.name}
    </div>
  );
});

const LIST_SIZE = 2000;
const RENDER_CAP = 300;
function BigList() {
  const [seed, setSeed] = useState(0);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const items = useMemo(() => makeItems(LIST_SIZE, seed), [seed]);

  // Typing stays urgent; the (expensive) filter + re-render runs on the deferred
  // value, which denext time-slices — so the input never stutters over 2,000 rows.
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
  }, [items, deferredQuery]);
  const stale = query !== deferredQuery;

  return (
    <div class="card" style="--i:1">
      <h2>2,000-row filter</h2>
      <p class="sub">Deferred, time-sliced filtering — typing stays smooth.</p>
      <Hooks
        names={[
          "useTransition",
          "useDeferredValue",
          "useMemo",
          "memo",
          "useState",
        ]}
      />
      <input
        type="search"
        placeholder="Filter 2,000 items…"
        value={query}
        onInput={(e: Event) => setQuery((e.currentTarget as HTMLInputElement).value)}
      />
      <FilterStatus
        count={filtered.length}
        stale={stale}
        shuffling={isPending}
        onShuffle={() => startTransition(() => setSeed((s) => s + 1))}
      />
      <div class={`list pending ${stale ? "is-pending" : ""}`}>
        {filtered.slice(0, RENDER_CAP).map((it) => (
          <Row
            key={it.id}
            item={it}
          />
        ))}
        {filtered.length > RENDER_CAP && (
          <div class="item muted">
            +{(filtered.length - RENDER_CAP).toLocaleString()} more…
          </div>
        )}
      </div>
    </div>
  );
}

/** The match count (with a stale-filter spinner) and the shuffle button. */
function FilterStatus(
  props: {
    count: number;
    stale: boolean;
    shuffling: boolean;
    onShuffle: () => void;
  },
) {
  return (
    <div
      class="row-controls small"
      style="margin-top:.5rem;justify-content:space-between"
    >
      <span class="muted">
        {props.stale ? <span class="spin">◐</span> : "●"} {props.count.toLocaleString()}{" "}
        match{props.count === 1 ? "" : "es"}
      </span>
      <button type="button" class="ghost" onClick={props.onShuffle}>
        {props.shuffling ? "shuffling…" : "shuffle"}
      </button>
    </div>
  );
}

// ── Card 3: live vitals — useSyncExternalStore (+ custom hook, useDebugValue) ─
function Vitals() {
  const online = useOnlineStatus();
  const viewport = useViewport();
  return (
    <div class="card" style="--i:2">
      <h2>Live vitals</h2>
      <p class="sub">External browser state, subscribed the React 18 way.</p>
      <Hooks names={["useSyncExternalStore", "useDebugValue"]} />
      <div class="vitals">
        <div class="vital">
          <div class="k">network</div>
          <div class="v">
            <span class={`dot ${online ? "on" : "off"}`} />
            {online ? "online" : "offline"}
          </div>
        </div>
        <div class="vital">
          <div class="k">viewport</div>
          <div class="v">{viewport}</div>
        </div>
      </div>
    </div>
  );
}

// ── Card 4: optimistic likes — useOptimistic ─────────────────────────────────
function OptimisticLikes() {
  const [likes, setLikes] = useState(0);
  const [optimistic, addOptimistic] = useOptimistic(
    likes,
    (n: number, delta: number) => n + delta,
  );
  const [pop, setPop] = useState(false);
  const pending = optimistic !== likes;

  const like = () => {
    addOptimistic(1); // instant, optimistic bump
    setPop(true);
    setTimeout(() => setPop(false), 350);
    setTimeout(() => setLikes((l) => l + 1), 700); // the "server" confirms
  };
  return (
    <div class="card" style="--i:3">
      <h2>Optimistic likes</h2>
      <p class="sub">Show the result instantly; reconcile when it lands.</p>
      <Hooks names={["useOptimistic", "useState"]} />
      <div class="row-controls">
        <button type="button" onClick={like}>
          <span class={`heart ${pop ? "pop" : ""}`}>♥</span>
        </button>
        <div>
          <div class="readout sm">{optimistic}</div>
          <div class={`tag ${pending ? "live" : ""}`}>
            {pending ? "confirming…" : `${likes} confirmed`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Card 5: imperative handle — forwardRef + useImperativeHandle ─────────────
interface BoxHandle {
  shake(): void;
  pulse(): void;
}
const flash = (node: HTMLElement | null, cls: string) => {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth; // restart the animation
  node.classList.add(cls);
};
function ImperativeBox({ ref }: { ref?: Ref<BoxHandle> }) {
  const el = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    shake: () => flash(el.current, "shake"),
    pulse: () => flash(el.current, "pulse"),
  }), []);
  return <div class="imp-box" ref={el}>imperative target</div>;
}
function ImperativeCard() {
  const boxRef = useRef<BoxHandle>(null);
  return (
    <div class="card" style="--i:4">
      <h2>Imperative handle</h2>
      <p class="sub">A parent drives a child through a ref API.</p>
      <Hooks names={["forwardRef", "useImperativeHandle", "useRef"]} />
      <ImperativeBox ref={boxRef} />
      <div class="row-controls" style="margin-top:.6rem">
        <button type="button" onClick={() => boxRef.current?.shake()}>
          shake()
        </button>
        <button
          type="button"
          class="ghost"
          onClick={() => boxRef.current?.pulse()}
        >
          pulse()
        </button>
      </div>
    </div>
  );
}

// ── Card 6: stopwatch — useEffect + useLayoutEffect ──────────────────────────
function Stopwatch() {
  const [ms, setMs] = useState(0);
  const [running, setRunning] = useState(false);
  const base = useRef(0);
  const readRef = useRef<HTMLDivElement>(null);
  const [minW, setMinW] = useState(0);

  useEffect(() => {
    if (!running) return;
    base.current = performance.now() - ms;
    const id = setInterval(() => setMs(performance.now() - base.current), 31);
    return () => clearInterval(id);
  }, [running]);

  // Read layout before paint and lock a growing min-width so the monospace
  // readout never reflows the card as digits are added — a real useLayoutEffect.
  useLayoutEffect(() => {
    const w = readRef.current?.offsetWidth ?? 0;
    if (w > minW) setMinW(w);
  });

  const secs = (ms / 1000).toFixed(2);
  return (
    <div class="card" style="--i:5">
      <h2>Stopwatch</h2>
      <p class="sub">Interval effect + layout-measured, jitter-free readout.</p>
      <Hooks names={["useEffect", "useLayoutEffect", "useRef", "useState"]} />
      <div
        class="readout"
        ref={readRef}
        style={minW ? `min-width:${minW}px` : ""}
      >
        {secs}s
      </div>
      <div class="row-controls" style="margin-top:.6rem">
        <button type="button" onClick={() => setRunning((r) => !r)}>
          {running ? "stop" : "start"}
        </button>
        <button
          type="button"
          class="ghost"
          onClick={() => {
            setRunning(false);
            setMs(0);
          }}
        >
          reset
        </button>
      </div>
    </div>
  );
}

// ── Card 7: accent theme — useContext + useId ────────────────────────────────
const PRESETS = [
  "#38bdf8",
  "#f472b6",
  "#34d399",
  "#f59e0b",
  "#a78bfa",
  "#f43f5e",
];
function AccentControls() {
  const { accent, history, setAccent } = useContext(AccentContext);
  const inputId = useId();
  return (
    <div class="card" style="--i:6">
      <h2>Accent theme</h2>
      <p class="sub">Context + reducer; injected as a CSS var, live.</p>
      <Hooks
        names={["useContext", "useId", "useInsertionEffect", "useReducer"]}
      />
      <label class="field" for={inputId}>Pick an accent</label>
      <div class="row-controls">
        <input
          id={inputId}
          type="color"
          value={accent}
          onInput={(e: Event) => setAccent((e.currentTarget as HTMLInputElement).value)}
        />
        <div class="row-controls">
          {PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`accent ${c}`}
              onClick={() => setAccent(c)}
              style={`width:1.4rem;height:1.4rem;padding:0;border-radius:50%;background:${c};border:2px solid ${
                c === accent ? "#fff" : "transparent"
              }`}
            />
          ))}
        </div>
      </div>
      <div class="small muted" style="margin-top:.6rem">
        recent: {history.map((c) => (
          <span
            key={c}
            class="swatch"
            style={`display:inline-block;background:${c};margin-right:3px`}
          />
        ))}
      </div>
    </div>
  );
}

// ── Card 8: cat controls (props + imperative summon) ─────────────────────────
export interface CatControlsProps {
  enabled: boolean;
  napping: boolean;
  speed: number;
  ignoreMouse: boolean;
  onEnabled: (v: boolean) => void;
  onNap: (v: boolean) => void;
  onSpeed: (v: number) => void;
  onIgnoreMouse: (v: boolean) => void;
  catRef: { current: CatHandle | null };
}
/** A point that wanders the viewport with the clock, so each summon lands somewhere new. */
function summonPoint(): [number, number] {
  const t = performance.now();
  return [
    60 + Math.abs(Math.sin(t / 300)) * ((globalThis.innerWidth ?? 360) - 120),
    80 + Math.abs(Math.cos(t / 220)) * ((globalThis.innerHeight ?? 640) - 200),
  ];
}

function CatControls(props: CatControlsProps) {
  const speedId = useId();
  const ignoreId = useId();
  const summon = () => {
    props.onEnabled(true);
    props.catRef.current?.summon(...summonPoint());
  };
  return (
    <div class="card" style="--i:7">
      <h2>🐈 The cat</h2>
      <p class="sub">
        Hunts rabbits, corners them for points, chases your pointer.
      </p>
      <Hooks
        names={["useImperativeHandle", "useEffectEvent", "useRef", "useState"]}
      />
      <label
        style="display:flex;align-items:center;gap:.5rem;margin:0 0 .7rem;cursor:pointer"
        for={ignoreId}
      >
        <input
          id={ignoreId}
          type="checkbox"
          checked={props.ignoreMouse}
          onChange={(e: Event) =>
            props.onIgnoreMouse((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>Ignore my mouse — just chase the rabbits</span>
      </label>
      <label class="field" for={speedId}>Speed — {props.speed} px/frame</label>
      <input
        id={speedId}
        type="range"
        min={1}
        max={12}
        step={1}
        value={props.speed}
        onInput={(e: Event) => props.onSpeed(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <div class="row-controls" style="margin-top:.6rem">
        <button type="button" onClick={summon}>summon()</button>
        <button
          type="button"
          class="ghost"
          onClick={() => props.onNap(!props.napping)}
        >
          {props.napping ? "wake up" : "nap"}
        </button>
        <button
          type="button"
          class="ghost"
          onClick={() => props.onEnabled(!props.enabled)}
        >
          {props.enabled ? "hide" : "show"}
        </button>
      </div>
    </div>
  );
}

/** The full grid of demo cards. */
export function Showcase(props: CatControlsProps) {
  return (
    <div class="grid">
      <ReducerCounter />
      <BigList />
      <Vitals />
      <OptimisticLikes />
      <ImperativeCard />
      <Stopwatch />
      <AccentControls />
      <CatControls {...props} />
    </div>
  );
}
