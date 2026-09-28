// The Lab tab (added to Expo's template): the automatic self-test at the top, then the React
// Native APIs to try by hand. Everything here is plain React Native / Expo code, built for the
// WebView by denext's React Native mode.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LAUNCHES_KEY, SelfTest } from "@/components/self-test";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { MaxContentWidth, Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

const NOTE_KEY = "lab:note";

/** One demo row of the list: an image and a label. */
const ROWS = Array.from(
  { length: 200 },
  (_, i) => ({ id: String(i), title: `Row ${i + 1}` }),
);

export default function LabScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [note, setNote] = useState("");
  const [log, setLog] = useState("Tap a button: its result shows here.");
  const [launches, setLaunches] = useState<number | null>(null);

  // The note and the launch count survive a relaunch: AsyncStorage is denext's durable
  // key-value store.
  useEffect(() => {
    AsyncStorage.getItem(NOTE_KEY).then((v) => v !== null && setNote(v));
    AsyncStorage.getItem(LAUNCHES_KEY).then(async (v) => {
      const n = Number(v ?? "0") + 1;
      await AsyncStorage.setItem(LAUNCHES_KEY, String(n));
      setLaunches(n);
    });
  }, []);

  const saveNote = (text: string) => {
    setNote(text);
    AsyncStorage.setItem(NOTE_KEY, text);
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.fill, { backgroundColor: theme.background }]}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 88,
            paddingBottom: insets.bottom + Spacing.five,
          },
        ]}
      >
        <ThemedText type="subtitle">Lab</ThemedText>
        <ThemedText type="smallBold" testID="lab-launches">
          Launches: {launches ?? "…"} (kill and reopen the app: it goes up)
        </ThemedText>

        <SelfTest />

        <ThemedText type="smallBold" style={styles.heading}>
          Try it
        </ThemedText>
        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="small" themeColor="textSecondary" testID="lab-log">
            {log}
          </ThemedText>
          <View style={styles.buttons}>
            <LabButton
              label="Haptic"
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                setLog("Haptics.impactAsync(Heavy) resolved");
              }}
            />
            <LabButton
              label="Alert"
              onPress={() =>
                Alert.alert(
                  "Alert.alert",
                  "Two buttons: a system dialog in the shell.",
                  [
                    {
                      text: "Cancel",
                      style: "cancel",
                      onPress: () => setLog("Alert: Cancel"),
                    },
                    { text: "OK", onPress: () => setLog("Alert: OK") },
                  ],
                )}
            />
            <LabButton
              label="Share"
              onPress={async () => {
                const r = await Share.share({
                  message: "Shared from denext",
                  url: "https://expo.dev",
                });
                setLog(`Share: ${r.action}`);
              }}
            />
            <LabButton
              label="Open expo.dev"
              onPress={async () => {
                await Linking.openURL("https://expo.dev");
                setLog("Linking.openURL resolved");
              }}
            />
          </View>
          <ThemedText type="small">A note (kept across launches):</ThemedText>
          <TextInput
            testID="lab-note"
            value={note}
            onChangeText={saveNote}
            placeholder="Type here: the keyboard must not cover it"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, {
              color: theme.text,
              borderColor: theme.backgroundSelected,
            }]}
          />
        </ThemedView>

        <ThemedText type="smallBold" style={styles.heading}>
          FlatList ({ROWS.length} rows)
        </ThemedText>
        <ThemedView
          type="backgroundElement"
          style={[styles.card, styles.listCard]}
        >
          <FlatList
            data={ROWS}
            keyExtractor={(r) => r.id}
            nestedScrollEnabled
            renderItem={({ item, index }) => (
              <Pressable
                onPress={() => {
                  Haptics.selectionAsync();
                  setLog(`Pressed ${item.title}`);
                }}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Image
                  source={require("@/assets/images/react-logo.png")}
                  style={[styles.rowImage, {
                    transform: [{ rotate: `${index * 9}deg` }],
                  }]}
                />
                <ThemedText type="small">{item.title}</ThemedText>
              </Pressable>
            )}
          />
        </ThemedView>
        <ThemedText type="small" themeColor="textSecondary">
          Platform.OS: {Platform.OS} · shell: {String(Platform.constants?.denextShell ?? "none")}
        </ThemedText>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function LabButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <ThemedView type="backgroundSelected" style={styles.button}>
        <ThemedText type="small">{label}</ThemedText>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
    width: "100%",
    maxWidth: MaxContentWidth,
    alignSelf: "center",
  },
  heading: { marginTop: Spacing.two },
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  listCard: { height: 320, padding: 0, overflow: "hidden" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.two },
  button: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
  },
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    height: 48,
  },
  rowImage: { width: 28, height: 28 },
  pressed: { opacity: 0.6 },
});
