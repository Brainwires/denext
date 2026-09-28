// The automatic self-test of the Lab tab (added to Expo's template). It runs once the tab
// mounts: every check needs no human and shows no system prompt (no alert, share sheet,
// browser or permission). Each result shows on screen and is logged as
// `SELFTEST|<name>|PASS|<detail>` (or FAIL / SKIP), then `SELFTEST|DONE|<passed>/<run>`
// (SKIPs are not counted), for Safari's Web Inspector.
//
// The stage below the results holds what the checks drive: a FlatList, a TextInput, a
// Reanimated view and two images.
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { Image as ExpoImage } from "expo-image";
import * as ExpoLinking from "expo-linking";
import { usePathname } from "expo-router";
import { setStatusBarStyle } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Appearance,
  AppState,
  FlatList,
  Image,
  Keyboard,
  Linking,
  PixelRatio,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { type EdgeInsets, useSafeAreaInsets } from "react-native-safe-area-context";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Spacing } from "@/constants/theme";

type Verdict = "PASS" | "FAIL" | "SKIP";
interface Result {
  name: string;
  verdict: Verdict;
  detail: string;
}

/** Thrown by a check that does not apply here (a browser, not the iOS shell). */
class Skip extends Error {}

/** What the checks read from the mounted screen. */
interface Env {
  insets: EdgeInsets;
  window: { width: number; height: number };
  pathname: string;
  typed: () => string;
  list: () => FlatList<number> | null;
  opacity: { value: number };
  images: () => { rn: boolean; expo: boolean };
}

type Check = { name: string; run: (env: Env) => string | Promise<string> };

/** `'ios'`, `'android'`, `'desktop'` or `'web'`: which shell the page runs in. */
const shell = String(
  (Platform.constants as { denextShell?: string } | undefined)?.denextShell ??
    "web",
);
const inIosShell = shell === "ios";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** The stage element with `testID` (react-native-web renders it as `data-testid`). */
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The nearest ancestor of `el` that scrolls vertically (the list's scroller). */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  }
  throw new Error("no scrolling ancestor");
}

const CHECKS: Check[] = [
  {
    name: "Platform.OS",
    run: () => {
      assert(Platform.OS === "web", `OS is ${Platform.OS}`);
      return `web, shell ${shell}, Version ${Platform.Version}`;
    },
  },
  {
    name: "Platform.select",
    run: () => {
      const got = Platform.select({
        ios: "ios",
        android: "android",
        default: "default",
      });
      const want = shell === "ios" || shell === "android" ? shell : "default";
      assert(got === want, `picked ${got}, wanted ${want}`);
      return String(got);
    },
  },
  {
    name: "safe-area insets",
    run: ({ insets }) => {
      const text = `top ${insets.top}, bottom ${insets.bottom}`;
      if (!inIosShell) throw new Skip(text);
      assert(insets.top > 0, `no top inset (${text})`);
      return text;
    },
  },
  {
    name: "window + pixel ratio",
    run: ({ window }) => {
      assert(window.width > 0 && window.height > 0, "zero window");
      assert(PixelRatio.get() >= 1, `ratio ${PixelRatio.get()}`);
      return `${window.width}x${window.height} @${PixelRatio.get()}x, font ${PixelRatio.getFontScale()}`;
    },
  },
  {
    name: "Appearance + AppState",
    run: () => {
      const scheme = Appearance.getColorScheme();
      assert(scheme === "light" || scheme === "dark", `scheme ${scheme}`);
      assert(
        AppState.currentState === "active",
        `state ${AppState.currentState}`,
      );
      return `${scheme}, ${AppState.currentState}`;
    },
  },
  {
    name: "global.css variables",
    run: () => {
      const mono = getComputedStyle(document.documentElement).getPropertyValue(
        "--font-mono",
      );
      assert(
        mono.trim() !== "",
        "--font-mono is not set (src/global.css not loaded)",
      );
      return mono.trim().split(",")[0];
    },
  },
  {
    name: "AsyncStorage",
    run: async () => {
      await AsyncStorage.setItem("selftest:a", "one");
      assert(
        (await AsyncStorage.getItem("selftest:a")) === "one",
        "getItem after setItem",
      );
      await AsyncStorage.multiSet([
        ["selftest:b", "2"],
        ["selftest:c", "3"],
      ]);
      const got = await AsyncStorage.multiGet(["selftest:b", "selftest:c"]);
      assert(
        JSON.stringify(got) === '[["selftest:b","2"],["selftest:c","3"]]',
        JSON.stringify(got),
      );
      const keys = await AsyncStorage.getAllKeys();
      assert(keys.includes("selftest:c"), "getAllKeys misses a key");
      await AsyncStorage.multiRemove([
        "selftest:a",
        "selftest:b",
        "selftest:c",
      ]);
      assert(
        (await AsyncStorage.getItem("selftest:a")) === null,
        "removed key still there",
      );
      return `${keys.length} keys`;
    },
  },
  {
    name: "AsyncStorage across launches",
    run: async () => {
      // Counts the Lab tab's mounts: relaunch the app and the number must go up.
      const n = Number((await AsyncStorage.getItem("selftest:launches")) ?? "0") + 1;
      await AsyncStorage.setItem("selftest:launches", String(n));
      return `run #${n}`;
    },
  },
  {
    name: "expo-haptics",
    run: async () => {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await Haptics.selectionAsync();
      return "impactAsync + selectionAsync resolved";
    },
  },
  {
    name: "expo-constants",
    run: () => {
      const cfg = Constants.expoConfig;
      assert(cfg?.name === "HelloWorld", `name ${cfg?.name}`);
      assert(cfg?.scheme === "helloworld", `scheme ${String(cfg?.scheme)}`);
      return `${cfg.name} ${cfg.version}`;
    },
  },
  {
    name: "expo-device",
    run: () => {
      const text = `${Device.osName} ${Device.osVersion}, ${Device.modelName}`;
      if (inIosShell) assert(/^i(Pad)?OS$/.test(String(Device.osName)), text);
      return text;
    },
  },
  {
    name: "Linking",
    run: async () => {
      const url = ExpoLinking.createURL("lab");
      if (shell === "web") assert(url.startsWith(location.origin), url);
      else assert(url === "helloworld://lab", url);
      assert(
        await Linking.canOpenURL("https://expo.dev"),
        "canOpenURL(https) is false",
      );
      const initial = await Linking.getInitialURL();
      return `${url}; launched by ${initial ?? "no link"}`;
    },
  },
  {
    name: "expo-router pathname",
    run: ({ pathname }) => {
      assert(pathname === "/lab", `pathname ${pathname}`);
      return pathname;
    },
  },
  {
    name: "FlatList virtualizes + scrollToIndex",
    run: async ({ list }) => {
      const rows = () => document.querySelectorAll('[data-testid^="st-row-"]').length;
      await until(() => rows() > 0);
      const mounted = rows();
      assert(mounted < 1000, `all ${mounted} rows mounted`);
      list()!.scrollToIndex({ index: 500, animated: false });
      const row = await until(() => byTestId("st-row-500"));
      const box = row.getBoundingClientRect();
      const frame = scrollParent(row).getBoundingClientRect();
      assert(
        box.top >= frame.top - 1 && box.top < frame.bottom,
        "row 500 not in view",
      );
      return `${mounted} of 1000 rows mounted; row 500 in view`;
    },
  },
  {
    name: "TextInput onChangeText",
    run: async ({ typed }) => {
      const input = await until(() => byTestId("st-input") as HTMLInputElement | null);
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      set.call(input, "hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await until(() => typed() === "hello", 2000);
      return "hello";
    },
  },
  {
    name: "Keyboard API",
    run: () => {
      const sub = Keyboard.addListener("keyboardDidShow", () => {});
      sub.remove();
      Keyboard.dismiss();
      assert(Keyboard.isVisible() === false, "keyboard reported up");
      assert(typeof Alert.alert === "function", "no Alert.alert");
      return "addListener / dismiss / isVisible";
    },
  },
  {
    name: "Reanimated withTiming",
    run: async ({ opacity }) => {
      const box = await until(() => byTestId("st-anim"));
      opacity.value = withTiming(1, { duration: 300 });
      await until(() => Number(getComputedStyle(box).opacity) > 0.99, 3000);
      await until(() => opacity.value === 1, 2000);
      return "opacity 0 → 1";
    },
  },
  {
    name: "images load",
    run: async ({ images }) => {
      await until(() => images().rn && images().expo, 5000);
      return "react-native Image + expo-image";
    },
  },
  {
    name: "expo-status-bar",
    run: () => {
      setStatusBarStyle("auto");
      return "setStatusBarStyle";
    },
  },
];

async function runChecks(env: Env, report: (r: Result) => void): Promise<void> {
  let passed = 0;
  let run = 0;
  for (const check of CHECKS) {
    let r: Result;
    try {
      r = { name: check.name, verdict: "PASS", detail: await check.run(env) };
    } catch (e) {
      r = e instanceof Skip ? { name: check.name, verdict: "SKIP", detail: e.message } : {
        name: check.name,
        verdict: "FAIL",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    if (r.verdict !== "SKIP") run++;
    if (r.verdict === "PASS") passed++;
    console.log(`SELFTEST|${r.name}|${r.verdict}|${r.detail}`);
    report(r);
  }
  console.log(`SELFTEST|DONE|${passed}/${run}`);
}

const COLORS: Record<Verdict, string> = {
  PASS: "#1f9d55",
  FAIL: "#e3342f",
  SKIP: "#8795a1",
};

export function SelfTest() {
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const pathname = usePathname();
  const [results, setResults] = useState<Result[]>([]);
  const [done, setDone] = useState(false);
  const [typed, setTyped] = useState("");
  const [images, setImages] = useState({ rn: false, expo: false });
  const opacity = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const listRef = useRef<FlatList<number>>(null);
  const typedRef = useRef(typed);
  typedRef.current = typed;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  // The checks read the latest render through this ref (they run across many renders).
  const env = useRef<Env | null>(null);
  env.current = {
    insets,
    window: dims,
    pathname,
    typed: () => typedRef.current,
    list: () => listRef.current,
    opacity,
    images: () => imagesRef.current,
  };

  useEffect(() => {
    let live = true;
    // Let the first frame settle (insets, fonts) before measuring anything.
    sleep(300)
      .then(() => runChecks(env.current!, (r) => live && setResults((all) => [...all, r])))
      .finally(() => live && setDone(true));
    return () => {
      live = false;
    };
  }, []);

  const passed = results.filter((r) => r.verdict === "PASS").length;
  const run = results.filter((r) => r.verdict !== "SKIP").length;
  const allGood = done && passed === run;

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedText type="smallBold" testID="selftest-summary">
        {done
          ? `${allGood ? "ALL PASS" : "FAILURES"}: ${passed}/${run} passed`
          : `Self-test running… ${results.length}/${CHECKS.length}`}
      </ThemedText>
      {results.map((r) => (
        <View key={r.name} style={styles.result}>
          <Text style={[styles.badge, { backgroundColor: COLORS[r.verdict] }]}>
            {r.verdict}
          </Text>
          <ThemedText type="small" style={styles.resultText}>
            {r.name}
            <ThemedText type="small" themeColor="textSecondary">
              {" "}
              {r.detail}
            </ThemedText>
          </ThemedText>
        </View>
      ))}

      {/* The stage the checks drive. */}
      <View style={styles.stage}>
        <FlatList
          ref={listRef}
          style={styles.stageList}
          nestedScrollEnabled
          data={STAGE_ROWS}
          keyExtractor={(n) => String(n)}
          getItemLayout={(_, index) => ({
            length: 24,
            offset: 24 * index,
            index,
          })}
          renderItem={({ item }) => (
            <Text testID={`st-row-${item}`} style={styles.stageRow}>
              stage row {item}
            </Text>
          )}
        />
        <View style={styles.stageSide}>
          <TextInput
            testID="st-input"
            value={typed}
            onChangeText={setTyped}
            style={styles.stageInput}
            placeholder="stage"
          />
          <Animated.View testID="st-anim" style={[styles.anim, animated]} />
          <Image
            source={require("@/assets/images/react-logo.png")}
            style={styles.stageImage}
            onLoad={() => setImages((s) => ({ ...s, rn: true }))}
          />
          <ExpoImage
            source={require("@/assets/images/expo-logo.png")}
            style={styles.stageImage}
            onLoad={() => setImages((s) => ({ ...s, expo: true }))}
          />
        </View>
      </View>
    </ThemedView>
  );
}

const STAGE_ROWS = Array.from({ length: 1000 }, (_, i) => i);

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  result: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.two },
  badge: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
    minWidth: 40,
    textAlign: "center",
  },
  resultText: { flex: 1 },
  stage: {
    flexDirection: "row",
    gap: Spacing.two,
    marginTop: Spacing.two,
    height: 120,
  },
  stageList: {
    flex: 1,
    borderRadius: Spacing.two,
    backgroundColor: "rgba(127,127,127,0.12)",
  },
  stageRow: {
    height: 24,
    lineHeight: 24,
    paddingHorizontal: Spacing.two,
    fontSize: 12,
    color: "#888",
  },
  stageSide: { width: 110, gap: Spacing.one, alignItems: "center" },
  stageInput: {
    width: 110,
    borderWidth: 1,
    borderColor: "#888",
    borderRadius: 6,
    paddingHorizontal: 6,
    fontSize: 16,
    color: "#888",
  },
  anim: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#3c87f7" },
  stageImage: { width: 24, height: 24 },
});
