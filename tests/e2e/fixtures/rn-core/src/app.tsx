// Every import below was a build error ("No matching export") before React Native mode added
// the React Native core names react-native-web lacks.
import { useContext, useEffect, useState } from "react";
import {
  ActionSheetIOS,
  Animated,
  CodegenTypes,
  DevSettings,
  DynamicColorIOS,
  InputAccessoryView,
  NativeAppEventEmitter,
  PermissionsAndroid,
  Platform,
  PlatformColor,
  Pressable,
  requireNativeComponent,
  RootTagContext,
  SafeAreaView,
  Systrace,
  Text,
  TextInput,
  ToastAndroid,
  TurboModuleRegistry,
  unstable_batchedUpdates,
  useAnimatedValue,
  View,
} from "react-native";

/** A native component (react-native-fast-image style): renders nothing on the web. */
const FastImage = requireNativeComponent<{ testID?: string }>("FastImageView");

export function App() {
  const rootTag = useContext(RootTagContext);
  const opacity = useAnimatedValue(0.5);
  const [picked, setPicked] = useState("none");
  const [perm, setPerm] = useState("pending");
  const [events, setEvents] = useState(0);
  const [batched, setBatched] = useState("no");
  useEffect(() => {
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN)
      .then((v) => setPerm(String(v)));
    const sub = NativeAppEventEmitter.addListener(
      "ping",
      () => setEvents((n) => n + 1),
    );
    return () => sub.remove();
  }, []);
  return (
    <SafeAreaView testID="safe" style={{ flex: 1 }}>
      <View>
        <Text testID="root-tag">{String(rootTag)}</Text>
        <Animated.View
          testID="animated"
          style={{ opacity, width: 10, height: 10 }}
        />
        <Text testID="select">
          {Platform.select({
            ios: "ios",
            android: "android",
            default: "default",
          })}
        </Text>
        <Text testID="shell">{Platform.constants.denextShell}</Text>
        <Text
          testID="color"
          style={{ color: PlatformColor("systemRed") as string }}
        >
          red
        </Text>
        <Text
          testID="dynamic"
          style={{
            color: DynamicColorIOS({
              light: "rgb(1, 2, 3)",
              dark: "rgb(4, 5, 6)",
            }) as string,
          }}
        >
          dynamic
        </Text>
        <Text testID="perm">{perm}</Text>
        <Text testID="picked">{picked}</Text>
        <Text testID="events">{String(events)}</Text>
        <Text testID="batched">{batched}</Text>
        <Text testID="systrace">{String(Systrace.isEnabled())}</Text>
        <Text testID="turbo">
          {String(TurboModuleRegistry.get("RNFastImage"))}
        </Text>
        <Text testID="internals">
          {typeof CodegenTypes + ":" + typeof DevSettings.reload}
        </Text>
        <FastImage testID="fast" />
        <Pressable
          testID="toast"
          onPress={() => ToastAndroid.show("Hello toast", ToastAndroid.SHORT)}
        >
          <Text>toast</Text>
        </Pressable>
        <Pressable
          testID="sheet"
          onPress={() =>
            ActionSheetIOS.showActionSheetWithOptions(
              { options: ["Cancel", "Pick me"], cancelButtonIndex: 0 },
              (i) => setPicked(String(i)),
            )}
        >
          <Text>sheet</Text>
        </Pressable>
        <Pressable
          testID="emit"
          onPress={() => NativeAppEventEmitter.emit("ping")}
        >
          <Text>emit</Text>
        </Pressable>
        <Pressable
          testID="batch"
          onPress={() => unstable_batchedUpdates(() => setBatched("yes"), undefined)}
        >
          <Text>batch</Text>
        </Pressable>
        <TextInput testID="input" inputAccessoryViewID="acc" />
      </View>
      <InputAccessoryView nativeID="acc">
        <Text testID="accessory">accessory</Text>
      </InputAccessoryView>
    </SafeAreaView>
  );
}
