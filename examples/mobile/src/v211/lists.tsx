// Lists: 100,000 fixed-height rows with a jump, 10,000 variable-height chat rows, and sticky
// section headers, all on VirtualList.
import {
  type Ref,
  useRef,
  useState,
  VirtualList,
  type VirtualListHandle,
  type VNode,
} from "denext";
import { Bubble, makeMessages } from "./keyboard.tsx";
import { Fill, Screen } from "./shell.tsx";

export const ROW_PX = 44;
export const JUMP_TO = 77_777;

export function BigList({ listRef }: { listRef?: Ref<VirtualListHandle> }) {
  return (
    <VirtualList
      ref={listRef}
      style={{ height: "100%" }}
      count={100_000}
      getItem={(i) => i}
      keyExtractor={(i) => i}
      getItemSize={() => ROW_PX}
      renderItem={(i) => (
        <div class="list-row" style={{ height: `${ROW_PX}px` }} data-row={i}>
          Row {i.toLocaleString("en-US")}
        </div>
      )}
    />
  );
}

let chatCache: ReturnType<typeof makeMessages> | undefined;
const chatRows = () => (chatCache ??= makeMessages(10_000));

function VariableChat(
  { listRef }: { listRef?: Ref<VirtualListHandle> },
) {
  return (
    <VirtualList
      ref={listRef}
      style={{ height: "100%" }}
      data={chatRows()}
      keyExtractor={(m) => m.id}
      estimatedItemSize={60}
      renderItem={(m) => <Bubble m={m} />}
    />
  );
}

type SectionItem = { header: true; label: string } | {
  header: false;
  label: string;
};

const SECTIONS: SectionItem[] = [];
const STICKY: number[] = [];
for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
  STICKY.push(SECTIONS.length);
  SECTIONS.push({ header: true, label: `Section ${letter}` });
  for (let i = 1; i <= 30; i++) {
    SECTIONS.push({ header: false, label: `${letter}${i}` });
  }
}

export function StickyList({ listRef }: { listRef?: Ref<VirtualListHandle> }) {
  return (
    <VirtualList
      ref={listRef}
      style={{ height: "100%" }}
      data={SECTIONS}
      keyExtractor={(s, i) => `${s.label}-${i}`}
      getItemSize={(s) => (s.header ? 32 : ROW_PX)}
      stickyIndices={STICKY}
      renderItem={(s) =>
        s.header
          ? <div class="sticky-head" data-sticky-head={s.label}>{s.label}</div>
          : (
            <div class="list-row" style={{ height: `${ROW_PX}px` }}>
              Item {s.label}
            </div>
          )}
    />
  );
}

type ListTab = "big" | "chat" | "sticky";

const LIST_TABS: [ListTab, string][] = [["big", "100k"], ["chat", "Chat 10k"], [
  "sticky",
  "Sticky",
]];

const LIST_VIEWS: Record<ListTab, (ref: Ref<VirtualListHandle>) => VNode> = {
  big: (ref) => <BigList key="big" listRef={ref} />,
  chat: (ref) => <VariableChat key="chat" listRef={ref} />,
  sticky: (ref) => <StickyList key="sticky" listRef={ref} />,
};

export function ListsScreen() {
  const [tab, setTab] = useState<ListTab>("big");
  const list = useRef<VirtualListHandle>(null);
  const jump = tab === "big" && (
    <button
      type="button"
      onClick={() => list.current?.scrollToIndex(JUMP_TO, { align: "start" })}
    >
      Jump to 77,777
    </button>
  );
  return (
    <Screen
      fill
      title="Lists"
      todo="100k: fling hard several times: momentum never stops or stutters mid-fling, no blank rows. 'Jump to 77,777' puts 'Row 77,777' at the top edge. Chat 10k: variable heights; fling both ways, no jumps or overlaps. Sticky: each 'Section X' header sticks at the top until the next one pushes it off."
    >
      <div class="row btn-row pad-x" data-selftest="lists-header">
        {LIST_TABS.map(([name, label]) => (
          <button
            key={name}
            type="button"
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {label}
          </button>
        ))}
        {jump}
      </div>
      <Fill data-selftest="lists-body">{LIST_VIEWS[tab](list)}</Fill>
    </Screen>
  );
}
