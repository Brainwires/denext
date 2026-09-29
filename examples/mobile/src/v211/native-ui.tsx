// Native look (R3-F): useContextMenu (iOS: the system long-press menu with the lifted row;
// Android: PopupMenu), showContextMenu from a button (iOS 16+: UIMenu at the point), <SystemIcon>
// (real SF Symbols on iOS via `denext mobile add system-icons`), and the navigation platform
// theme (large title that collapses, glass tab bar, a selection haptic per tab switch).
import { useState } from "denext";
import { type ContextMenuItem, showContextMenu, SystemIcon, useContextMenu } from "denext/mobile";
import { StackView, type StackViewEntry, TabsView } from "denext/navigation";
import { Fill, Screen } from "./shell.tsx";

const ITEMS: ContextMenuItem[] = [
  { id: "reply", label: "Reply", systemIcon: "arrowshape.turn.up.left" },
  { id: "copy", label: "Copy", systemIcon: "doc.on.doc" },
  {
    id: "move",
    label: "Move to",
    systemIcon: "folder",
    children: [
      { id: "inbox", label: "Inbox", systemIcon: "tray" },
      {
        id: "archive",
        label: "Archive",
        subtitle: "Out of the inbox, kept",
        systemIcon: "archivebox",
      },
    ],
  },
  { id: "flag", label: "Flag", systemIcon: "flag", disabled: true },
  { id: "delete", label: "Delete", systemIcon: "trash", destructive: true },
];

function Row({ n, onPick }: { n: number; onPick: (s: string) => void }) {
  const menu = useContextMenu(ITEMS, (id) => onPick(`row ${n}: ${id}`), {
    title: `Message ${n}`,
  });
  return (
    <div
      ref={menu}
      data-native-row={n}
      style={{
        margin: "8px 12px",
        padding: "12px 14px",
        borderRadius: 14,
        background: "rgba(127,127,127,0.12)",
        display: "flex",
        gap: 10,
        alignItems: "center",
      }}
    >
      <SystemIcon name="bubble.left.fill" size={22} color="#0a84ff" />
      <span>Message {n} — long-press me</span>
    </div>
  );
}

const ICONS = [
  "house.fill",
  "magnifyingglass",
  "bell.badge",
  "heart.fill",
  "square.and.arrow.up",
  "trash",
  "gearshape.fill",
  "person.crop.circle",
];

function MenusAndIcons() {
  const [picked, setPicked] = useState("nothing yet");
  return (
    <div style={{ paddingBottom: 24 }}>
      <p style={{ padding: "0 12px" }}>
        Picked: <strong data-native-picked="">{picked}</strong>
      </p>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          padding: "4px 12px 12px",
        }}
      >
        {ICONS.map((name) => <SystemIcon key={name} name={name} size={28} weight="medium" />)}
        <SystemIcon name="cloud.sun.fill" size={28} mode="multicolor" />
        <SystemIcon
          name="battery.75percent"
          size={28}
          mode="hierarchical"
          color="#34c759"
        />
      </div>
      <div class="row btn-row" style={{ padding: "0 12px" }}>
        <button
          type="button"
          onClick={async (e: { clientX: number; clientY: number }) => {
            const id = await showContextMenu(ITEMS, {
              x: e.clientX,
              y: e.clientY,
              title: "From code",
            });
            setPicked(`button: ${id ?? "dismissed"}`);
          }}
        >
          showContextMenu here
        </button>
      </div>
      {Array.from(
        { length: 12 },
        (_, i) => <Row key={i} n={i + 1} onPick={setPicked} />,
      )}
    </div>
  );
}

function ThemedStack() {
  const entries: StackViewEntry[] = [{
    id: "mail",
    element: <MenusAndIcons />,
    options: { title: "Mail", headerShown: true, headerLargeTitle: true },
  }];
  return <StackView entries={entries} onPop={() => {}} theme="platform" />;
}

export function NativeUiScreen() {
  const [active, setActive] = useState("mail");
  const tabs = [
    {
      name: "mail",
      href: "",
      title: "Mail",
      icon: ({ focused }: { focused: boolean }) => (
        <SystemIcon name={focused ? "envelope.fill" : "envelope"} size={24} />
      ),
    },
    {
      name: "settings",
      href: "",
      title: "Settings",
      icon: ({ focused }: { focused: boolean }) => (
        <SystemIcon name={focused ? "gearshape.fill" : "gearshape"} size={24} />
      ),
    },
  ];
  const panels = new Map([
    ["mail", <ThemedStack key="mail" />],
    [
      "settings",
      <p key="settings" style={{ padding: 16 }}>Tab switches play a selection haptic.</p>,
    ],
  ]);
  return (
    <Screen
      fill
      insetBottom={false}
      title="16. Native look"
      todo="Long-press a row: iOS lifts it and shows the system menu (SF Symbols, a submenu, a disabled and a red item). Tap the button for a menu from code. Icons are real SF Symbols. Scroll: the large title collapses into a translucent bar. Switch tabs: a haptic tick; the tab bar is a floating glass capsule."
    >
      <Fill>
        <TabsView
          tabs={tabs}
          active={active}
          panels={panels}
          onTabPress={(name) => setActive(name)}
          theme="platform"
          style={{ height: "100%" }}
        />
      </Fill>
    </Screen>
  );
}
