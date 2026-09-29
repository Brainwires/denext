import { Text, View } from "react-native";
import { Counter } from "./counter.tsx";
// badge.js (JSX in `.js`) is written by the e2e: the repo's lint would parse it as plain JS.
// fallow-ignore-next-line unresolved-import
import { Badge } from "./badge";
import { GREETING } from "./greeting.ts";
import { Platform } from "./platform";

export function App() {
  return (
    <View>
      <Counter />
      <Badge />
      <Platform />
      <Text testID="greeting">{GREETING}</Text>
    </View>
  );
}
