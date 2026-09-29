// Navigation: denext/navigation's router-independent views. A 3-level StackView (the iOS edge
// swipe follows the finger), a TabsView whose tabs keep their scroll, and a Sheet with
// medium / large detents.
import { useState } from "denext";
import { Sheet, StackView, type StackViewEntry, TabsView } from "denext/navigation";
import { Fill, Screen } from "./shell.tsx";

/** Handles the self-test drives the demos with. */
export interface NavControl {
  push?: () => void;
  pop?: () => void;
}

function Level({ depth, push }: { depth: number; push: () => void }) {
  const [taps, setTaps] = useState(0);
  return (
    <div style={{ padding: "12px" }} data-level={depth}>
      <p>
        Level <strong>{depth}</strong> · counter <strong data-level-count={depth}>{taps}</strong>
      </p>
      <div class="row btn-row">
        <button type="button" onClick={() => setTaps((t) => t + 1)}>+1</button>
        {depth < 3 && <button type="button" onClick={push}>Push level {depth + 1}</button>}
      </div>
      {Array.from(
        { length: 60 },
        (_, i) => <div key={i} class="list-row">Level {depth} · line {i + 1}</div>,
      )}
    </div>
  );
}

export function NavStack({ ctl }: { ctl?: NavControl }) {
  const entry = (depth: number): StackViewEntry => ({
    id: `level-${depth}`,
    element: <Level depth={depth} push={() => push()} />,
    options: { title: `Level ${depth}` },
  });
  const [entries, setEntries] = useState<StackViewEntry[]>(() => [entry(1)]);
  const push = () => setEntries((e) => (e.length >= 3 ? e : [...e, entry(e.length + 1)]));
  const pop = () => setEntries((e) => (e.length > 1 ? e.slice(0, -1) : e));
  if (ctl) {
    ctl.push = push;
    ctl.pop = pop;
  }
  return (
    <StackView
      entries={entries}
      onPop={(to) => setEntries((e) => e.slice(0, to + 1))}
      style={{ height: "100%" }}
    />
  );
}

const TABS = [
  { name: "inbox", title: "Inbox", href: "#inbox" },
  { name: "feed", title: "Feed", href: "#feed" },
  { name: "me", title: "Me", href: "#me" },
];

export function NavTabs(
  { active: controlled, onActive }: {
    active?: string;
    onActive?: (n: string) => void;
  },
) {
  const [own, setOwn] = useState("inbox");
  const active = controlled ?? own;
  const [visited, setVisited] = useState<string[]>(["inbox"]);
  const seen = visited.includes(active) ? visited : [...visited, active];
  const panels = new Map(
    seen.map((name) => [
      name,
      <div key={name} style={{ padding: "12px" }}>
        {Array.from(
          { length: 80 },
          (_, i) => <div key={i} class="list-row">{name} · row {i + 1}</div>,
        )}
      </div>,
    ]),
  );
  return (
    <TabsView
      tabs={TABS}
      active={active}
      panels={panels}
      style={{ height: "100%" }}
      onTabPress={(name, event) => {
        event.preventDefault();
        if (!visited.includes(name)) setVisited([...visited, name]);
        setOwn(name);
        onActive?.(name);
      }}
    />
  );
}

export function SheetDemo(
  { open, setOpen, onDetent }: {
    open: boolean;
    setOpen: (o: boolean) => void;
    onDetent?: (i: number) => void;
  },
) {
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      detents={["medium", "large"]}
      onDetentChange={onDetent}
      aria-label="Demo sheet"
    >
      <div style={{ padding: "16px 16px calc(16px + var(--denext-safe-bottom, 0px))" }}>
        <h2>A sheet</h2>
        <p>
          Drag the grabber up to large, down to medium, further down to dismiss.
        </p>
        <input placeholder="Focus me: the sheet stays above the keyboard" />
        {Array.from(
          { length: 30 },
          (_, i) => <div key={i} class="list-row">Sheet row {i + 1}</div>,
        )}
        <button type="button" onClick={() => setOpen(false)}>Close</button>
      </div>
    </Sheet>
  );
}

export function NavigationScreen() {
  const [mode, setMode] = useState<"stack" | "tabs">("stack");
  const [sheet, setSheet] = useState(false);
  const [detent, setDetent] = useState(0);
  return (
    <Screen
      fill
      insetBottom={false}
      title="Navigation"
      todo="Stack: push to level 3, then drag from the LEFT screen edge: the screen follows your finger and the level below peeks in; let go past halfway to pop, before halfway to stay. Counters and scroll positions survive a pop. Tabs: scroll Inbox down, switch to Feed and back: Inbox is where you left it. Sheet: opens at half height (medium); drag up for large, down to dismiss."
    >
      <div class="row btn-row pad-x" data-selftest="nav-header">
        <button
          type="button"
          aria-pressed={mode === "stack"}
          onClick={() => setMode("stack")}
        >
          Stack
        </button>
        <button
          type="button"
          aria-pressed={mode === "tabs"}
          onClick={() => setMode("tabs")}
        >
          Tabs
        </button>
        <button type="button" onClick={() => setSheet(true)}>Open sheet</button>
        <span class="note">detent {detent === 0 ? "medium" : "large"}</span>
      </div>
      {/* TabsView pads its own bar for the home indicator; the stack needs the inset here. */}
      <Fill
        data-selftest="nav-body"
        style={{ paddingBottom: mode === "stack" ? "var(--denext-safe-bottom, 0px)" : "0px" }}
      >
        {mode === "stack" ? <NavStack /> : <NavTabs />}
      </Fill>
      <SheetDemo open={sheet} setOpen={setSheet} onDetent={setDetent} />
    </Screen>
  );
}
