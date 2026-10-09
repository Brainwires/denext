import { SwipeableRow, useState, VirtualList } from "denext";
// Relative: the fixture builds against the root import map, which has no denext/navigation.
import {
  browserHistory,
  type HistoryScreen,
  HistoryStack,
  useScreenMatch,
  useStackNavigation,
} from "../../../../../src/navigation/mod.ts";

const history = browserHistory();

interface Thread {
  readonly id: number;
  readonly muted: boolean;
}

/** The root screen: 300 threads in a VirtualList, each a SwipeableRow. */
function Threads() {
  const [items, setItems] = useState<Thread[]>(() =>
    Array.from({ length: 300 }, (_, i) => ({ id: i + 1, muted: false }))
  );
  const nav = useStackNavigation();
  return (
    <VirtualList
      data={items}
      style={{ height: "100%" }}
      renderItem={(t: Thread) => (
        <SwipeableRow
          leading={[{ label: "Unread", tone: "accent", onPress: () => {} }]}
          trailing={[
            {
              label: "Archive",
              tone: "warning",
              onPress: () => setItems((xs) => xs.filter((x) => x.id !== t.id)),
            },
            {
              label: "Mute",
              accessibilityLabel: `Mute thread ${t.id}`,
              onPress: () =>
                setItems((xs) => xs.map((x) => (x.id === t.id ? { ...x, muted: true } : x))),
            },
          ]}
        >
          <a
            data-row={t.id}
            href={`/t/${t.id}`}
            style={{ display: "block", height: "56px", lineHeight: "56px", padding: "0 16px" }}
            onClick={(e: MouseEvent) => {
              e.preventDefault();
              nav.push(`/t/${t.id}`);
            }}
          >
            Thread {t.id}
            {t.muted ? " (muted)" : ""}
          </a>
        </SwipeableRow>
      )}
    />
  );
}

/** A thread screen: renders its own pinned id. */
function ThreadScreen() {
  const id = useScreenMatch()?.params.id;
  return (
    <div data-testid="thread" style={{ padding: "16px", height: "1200px" }}>
      Thread screen {id}
    </div>
  );
}

const screens: HistoryScreen[] = [
  { path: "/", render: () => <Threads />, options: { title: "Threads" } },
  {
    path: "/t/$id",
    render: () => <ThreadScreen />,
    options: (m) => ({ title: `Thread ${m.params.id}`, headerShown: true }),
  },
];

export function App() {
  return <HistoryStack history={history} screens={screens} platform="ios" />;
}
