// Every worklet here is written the way a React Native app writes it for Metro + the Babel
// plugin: no dependency arrays, no 'worklet' directives on hook callbacks.
import { useEffect, useState } from "react";
import { LayoutAnimation, Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSequence,
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

/** A button. */
function Button({ id, onPress }: { id: string; onPress: () => void }) {
  return (
    <Pressable testID={id} onPress={onPress}>
      <Text>{id}</Text>
    </Pressable>
  );
}

/** A forever spinner started on mount (its style mapper's first run is still due then). */
function Spinner() {
  const rot = useSharedValue(0);
  const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  useEffect(() => {
    rot.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1);
  }, []);
  return (
    <Animated.View
      testID="spin-box"
      style={[{ width: 40, height: 40, backgroundColor: "orange" }, spinStyle]}
    />
  );
}

/**
 * The compositor cases: transform / opacity animations Reanimated would step on the main
 * thread, which React Native mode runs as Web Animations instead.
 */
function Compositor() {
  // A shared value animated to 200 whose only reader maps it to transform + opacity.
  const x = useSharedValue(0);
  const [moved, setMoved] = useState(false);
  const moveStyle = useAnimatedStyle(() => ({
    opacity: 1 - x.value / 400,
    transform: [{ translateX: x.value }],
  }));
  const move = () => {
    x.value = withTiming(200, { duration: 2000 }, (finished) => {
      if (finished) runOnJS(setMoved)(true);
    });
  };
  const moveBack = () => {
    x.value = withTiming(0, { duration: 2000 });
  };
  // An animation returned from the style, re-created when React state changes.
  const [dim, setDim] = useState(false);
  const dimStyle = useAnimatedStyle(() => ({
    opacity: withTiming(dim ? 0.3 : 1, { duration: 1500 }),
  }));
  // withSequence out and back.
  const y = useSharedValue(0);
  const seqStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const sequence = () => {
    y.value = withSequence(
      withTiming(40, { duration: 400 }),
      withTiming(0, { duration: 400 }),
    );
  };
  // A forever spinner, mounted and unmounted on demand.
  const [spin, setSpin] = useState(false);
  // An entering layout animation.
  const [shown, setShown] = useState(false);
  // LayoutAnimation over a list that grows at the top.
  const [items, setItems] = useState(["b", "c"]);
  const add = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setItems(["a", ...items]);
  };
  const box = { width: 40, height: 40, backgroundColor: "teal" };
  return (
    <View>
      <Button id="move" onPress={move} />
      <Button id="move-back" onPress={moveBack} />
      <Button id="dim" onPress={() => setDim(true)} />
      <Button id="seq" onPress={sequence} />
      <Button id="enter-toggle" onPress={() => setShown(true)} />
      <Button id="la-add" onPress={add} />
      <Text testID="moved">{moved ? "moved" : "idle"}</Text>
      <Animated.View testID="move-box" style={[box, moveStyle]} />
      <Animated.View testID="dim-box" style={[box, dimStyle]} />
      <Animated.View testID="seq-box" style={[box, seqStyle]} />
      <Button id="spin-toggle" onPress={() => setSpin(!spin)} />
      {spin && <Spinner />}
      {shown && <Animated.View testID="enter-box" entering={FadeIn.duration(2000)} style={box} />}
      {items.map((id) => (
        <View key={id} testID={`la-${id}`} style={{ height: 30 }}>
          <Text>{id}</Text>
        </View>
      ))}
    </View>
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
        <Compositor />
      </View>
    </GestureHandlerRootView>
  );
}
