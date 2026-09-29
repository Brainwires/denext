import { useState } from "react";
import { Pressable, Text } from "react-native";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <Pressable testID="counter" onPress={() => setCount((n) => n + 1)}>
      <Text testID="label">Taps (first edition): {count}</Text>
    </Pressable>
  );
}
