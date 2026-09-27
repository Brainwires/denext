// Every worklet here is written the way a React Native app writes it for Metro + the Babel
// plugin: no dependency arrays, no 'worklet' directives on hook callbacks.
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

/** A worklet function declaration, called from other worklets. */
function clamp(value: number, lo: number, hi: number): number {
  "worklet";
  return Math.min(Math.max(value, lo), hi);
}

const ROWS = Array.from({ length: 60 }, (_, i) => i);

/** withTiming / withSpring into styles; a derived value and a style that capture React state. */
function Boxes({ factor }: { factor: number }) {
  const [settled, setSettled] = useState(false);
  const progress = useSharedValue(0);
  const spring = useSharedValue(0);
  // Captures React state (`factor`): must re-run when it changes.
  const doubled = useDerivedValue(() => progress.value * 2 * factor);
  // A referenced worklet (a const naming an arrow), not an inline one.
  const fadeUpdater = () => ({ opacity: 0.2 + progress.value * 0.8 });
  const fadeStyle = useAnimatedStyle(fadeUpdater);
  const widthStyle = useAnimatedStyle(() => ({
    width: 10 + doubled.value * 50,
  }));
  const factorStyle = useAnimatedStyle(() => ({ height: factor * 10 }));
  const springStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: spring.value }],
  }));
  useAnimatedReaction(
    () => spring.value,
    (value) => {
      if (value > 99) runOnJS(setSettled)(true);
    },
  );
  const animate = () => {
    progress.value = withTiming(1, { duration: 200 });
    spring.value = withSpring(100);
  };
  return (
    <View>
      <Pressable testID="animate" onPress={animate}>
        <Text>animate</Text>
      </Pressable>
      <Text testID="settled">{settled ? "settled" : "moving"}</Text>
      <Animated.View
        testID="fade"
        style={[{ height: 10, backgroundColor: "red" }, fadeStyle]}
      />
      <Animated.View
        testID="width"
        style={[{ height: 10, backgroundColor: "blue" }, widthStyle]}
      />
      <Animated.View testID="factor-box" style={[{ width: 10 }, factorStyle]} />
      <Animated.View
        testID="spring"
        style={[
          { width: 10, height: 10, backgroundColor: "green" },
          springStyle,
        ]}
      />
    </View>
  );
}

/** A Gesture.Pan() whose worklet callbacks move the view. */
function PanBox() {
  const panX = useSharedValue(0);
  const panStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: clamp(panX.value, -300, 300) }],
  }));
  const pan = Gesture.Pan()
    .onUpdate((event) => {
      panX.value = event.translationX;
    })
    .onEnd(() => {
      panX.value = withTiming(panX.value);
    });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        testID="pan"
        style={[{ width: 80, height: 80, backgroundColor: "purple" }, panStyle]}
      />
    </GestureDetector>
  );
}

/** useAnimatedScrollHandler into a style. */
function Scroller({ scrollY }: { scrollY: SharedValue<number> }) {
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });
  return (
    <Animated.ScrollView
      testID="scroller"
      style={{ height: 120 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      {ROWS.map((i) => <Text key={i} style={{ height: 30 }}>row {i}</Text>)}
    </Animated.ScrollView>
  );
}

export function App() {
  const [factor, setFactor] = useState(1);
  const scrollY = useSharedValue(0);
  const scrollStyle = useAnimatedStyle(() => ({
    height: clamp(scrollY.value, 0, 400),
  }));
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ padding: 8 }}>
        <Pressable testID="factor" onPress={() => setFactor((f) => f + 1)}>
          <Text testID="factor-label">factor {factor}</Text>
        </Pressable>
        <Boxes factor={factor} />
        <Animated.View
          testID="scroll-box"
          style={[{ width: 10 }, scrollStyle]}
        />
        <PanBox />
        <Scroller scrollY={scrollY} />
      </View>
    </GestureHandlerRootView>
  );
}
