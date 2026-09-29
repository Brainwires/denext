// One React Native component tree for iOS, Android, the web and the desktop. The platform APIs
// come from `denext/mobile`: in a Deno Desktop window they go through the desktop runtime (the
// OS keychain, the native context menu, the system browser); elsewhere they take their mobile
// or web path. `Platform.OS` stays "web" (react-native-web and libraries branch their DOM code
// on it); `runtimePlatform()` tells desktop apart.
import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import {
  openExternal,
  readClipboard,
  runtimePlatform,
  secureStore,
  showContextMenu,
} from "denext/mobile";

/** The context menu's items. */
const MENU = [
  { id: "reset", label: "Reset counter" },
  { id: "paste", label: "Paste as note" },
  { id: "docs", label: "Open denext docs" },
];

export function App() {
  const [count, setCount] = useState(0);
  const [note, setNote] = useState("");
  const runtime = runtimePlatform();

  // The count persists in the OS keychain on desktop (browser storage is wiped per launch there).
  useEffect(() => {
    secureStore.get("count").then((v) => setCount(Number(v ?? 0))).catch(
      () => {},
    );
  }, []);

  const bump = async () => {
    const next = count + 1;
    setCount(next);
    await secureStore.set("count", String(next)).catch(() => {});
  };

  // What each context-menu item does (the menu resolves an item's id, or null when dismissed).
  const actions: Record<string, () => Promise<void>> = {
    reset: async () => {
      setCount(0);
      await secureStore.delete("count").catch(() => {});
    },
    paste: async () => setNote(await readClipboard().catch(() => "")),
    docs: () => openExternal("https://denext.dev/docs/desktop"),
  };

  const openMenu = async (x: number, y: number) => {
    const choice = await showContextMenu(MENU, { x, y });
    await actions[choice ?? ""]?.();
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>React Native on {runtime}</Text>
      <Text style={styles.meta}>Platform.OS = {Platform.OS}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={bump}
        onLongPress={(e) => openMenu(e.nativeEvent.pageX ?? 0, e.nativeEvent.pageY ?? 0)}
        {
          // Right-click opens the same menu (native on desktop, a popover elsewhere).
          // react-native-web forwards this DOM prop; RN's types do not list it.
          ...{
            onContextMenu: (
              e: { preventDefault(): void; nativeEvent: MouseEvent },
            ) => {
              e.preventDefault();
              openMenu(e.nativeEvent.clientX, e.nativeEvent.clientY);
            },
          } as Record<string, unknown>
        }
        style={styles.button}
      >
        <Text style={styles.buttonText}>Clicked {count} times</Text>
      </Pressable>
      {note ? <Text style={styles.meta}>Note: {note}</Text> : null}
      <Text style={styles.hint}>
        Right-click (or long-press) the button for the menu.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  title: { fontSize: 24, fontWeight: "600" },
  meta: { fontSize: 14, opacity: 0.7 },
  button: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: "#2563eb",
  },
  buttonText: { color: "white", fontSize: 16 },
  hint: { fontSize: 12, opacity: 0.6 },
});
