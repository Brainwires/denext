import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

// Class rules (StyleSheet.create), not inline styles: they reach the page only through
// react-native-web's style sheet.
const styles = StyleSheet.create({
  box: { backgroundColor: "rgb(0, 0, 255)", width: 40, height: 40 },
  label: { color: "rgb(255, 0, 0)", fontSize: 21 },
  pressed: { color: "rgb(0, 128, 0)" },
  list: { height: 60 },
});

export function App() {
  const [n, setN] = useState(0);
  return (
    <View testID="screen">
      <View testID="box" style={styles.box} />
      <Text testID="label" style={styles.label}>styled</Text>
      <Pressable testID="press" onPress={() => setN(n + 1)}>
        {/* A style first used after the press: inserted into the sheet at run time. */}
        <Text testID="count" style={n > 0 ? styles.pressed : undefined}>count {n}</Text>
      </Pressable>
      <TextInput testID="input" placeholder="a placeholder long enough to be cut off" />
      <FlatList
        testID="list"
        style={styles.list}
        showsVerticalScrollIndicator={false}
        data={["a", "b", "c", "d", "e"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => <Text>{item}</Text>}
      />
    </View>
  );
}
